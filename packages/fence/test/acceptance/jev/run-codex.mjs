// The Codex jev runner (spec, "Acceptance", items 1 and 2). jev can not drive Codex hooks, so this
// feeds jev's exact expanded corpus through `fence-hook pre --host codex` itself.
//
//   node run-codex.mjs [--out <dir>] [--policy <file>]
//
// 1. A temp root: <root>/project is `git init`-ed (on the unprotected branch `acceptance`) so
//    ${repo} resolves; <root>/stage is a staged HOME (stage-home.mjs) with the policy (default
//    packages/fence/policies/strict.json); state and admin directories are empty temp directories.
// 2. The corpus: `uvx --from 'jev-harness-sdk[stats]==1.2.0' python -c <dump>` expands jev's default
//    corpus against the project and prints it as JSON rows {id, category, disguise, expected, tool,
//    tool_input} (UVX overrides the uvx program). Nothing in it is ever run; it is only sent as stdin.
// 3. Each row goes to the staged launcher twice, with HOME=<staged home>: as a Codex payload
//    (toCodexPayload: Write/Edit as apply_patch envelopes, Read as `cat <path>`, Bash as a shell call)
//    and as the Claude payload jev itself sends (its hook_input shape), so the two adapters can be
//    compared row by row (jev's own report carries no per-row decisions).
// 4. Writes corpus.json, codex-decisions.json and claude-decisions.json to the output directory,
//    prints the per-family table (rule-blocked, allowed) and the benign blocked count per host, and
//    the differing decisions (compare.mjs diffDecisions). Exit 1 when any decision differs.
//
// Exports for the unit test: toCodexPayload(row, {cwd}), toClaudePayload(row, {cwd}),
// classify(host, result), familyTable(rows), formatTable(table).

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stageHome } from '../stage-home.mjs';
import { diffDecisions } from './compare.mjs';

export const JEV_SPEC = 'jev-harness-sdk[stats]==1.2.0';
// jev's hook_input session id (jev_harness/modules/guard_bench/hooks.py SESSION_ID)
export const JEV_SESSION = 'jev-harness-bench';
// jev's disguise classes, in the order its corpus expands them
export const FAMILY_ORDER = Object.freeze(['base', 'alternative', 'compound', 'pipe', 'subshell', 'multiline', 'quoting', 'variable', 'interpreter', 'encoded', 'file_tool', 'path_form']);
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const STRICT = nodePath.resolve(HERE, '..', '..', '..', 'policies', 'strict.json');
const HOOK_TIMEOUT_MS = 30_000;
const UVX_TIMEOUT_MS = 600_000;
// The watchdog's own failure text (watchdog.mjs failureText): such a deny is not a rule's.
const WATCHDOG_FAILURE = /could not check it/;

const DUMP = [
  'import json, sys',
  'from jev_harness.modules.guard_bench.corpus import load_corpus',
  'rows = [{"id": p.id, "category": p.category, "disguise": p.disguise, "expected": p.expected, "tool": p.tool, "tool_input": p.tool_input} for p in load_corpus().expand(sys.argv[1])]',
  'json.dump(rows, sys.stdout)',
].join('\n');

const SAFE_WORD = /^[A-Za-z0-9_\-+=.,/:@%^]+$/;
const sq = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// A path as one shell word; a leading `~/` stays unquoted so the shell still expands it.
function shellPath(p) {
  if (SAFE_WORD.test(p)) return p;
  if (p.startsWith('~/')) return SAFE_WORD.test(p.slice(2)) ? p : `~/${sq(p.slice(2))}`;
  return sq(p);
}

// Text -> patch lines. A trailing newline ends the last line and adds none (no bare `+`); empty
// text has no lines.
const lines = (text, prefix) => {
  const s = String(text);
  return s === '' ? [] : s.replace(/\n$/, '').split('\n').map((l) => `${prefix}${l}`);
};
const envelope = (body) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');

function base(row, cwd) {
  return { hook_event_name: 'PreToolUse', session_id: JEV_SESSION, turn_id: 'jev-turn', cwd, permission_mode: 'default', tool_use_id: `call-${row.id}` };
}

// A jev corpus row -> the Codex PreToolUse payload of the same intent.
export function toCodexPayload(row, { cwd = process.cwd() } = {}) {
  const input = row?.tool_input ?? {};
  const p = base(row, cwd);
  switch (row?.tool) {
    case 'Bash':
      return { ...p, tool_name: 'shell', tool_input: { command: input.command } };
    case 'Read':
      return { ...p, tool_name: 'shell', tool_input: { command: `cat ${shellPath(input.file_path)}` } };
    case 'Write':
      return { ...p, tool_name: 'apply_patch', tool_input: { command: envelope([`*** Add File: ${input.file_path}`, ...lines(input.content ?? '', '+')]) } };
    case 'Edit':
      return {
        ...p,
        tool_name: 'apply_patch',
        tool_input: { command: envelope([`*** Update File: ${input.file_path}`, '@@', ...lines(input.old_string ?? '', '-'), ...lines(input.new_string ?? '', '+')]) },
      };
    default:
      throw new Error(`toCodexPayload: the jev tool ${JSON.stringify(row?.tool)} has no Codex form`);
  }
}

// A jev corpus row -> the Claude payload jev sends (hook_input in jev's hooks.py).
export function toClaudePayload(row, { cwd = process.cwd() } = {}) {
  return { session_id: JEV_SESSION, cwd, hook_event_name: 'PreToolUse', tool_name: row.tool, tool_input: row.tool_input };
}

// A launcher run {status, stdout, stderr} -> "deny" | "allow" | "none" | "failed".
//   claude: exit 0 + JSON deny -> deny (failed when the reason is the watchdog's own failure text),
//           exit 0 + JSON allow -> allow, exit 0 + no output -> none, anything else -> failed
//   codex:  exit 2 -> deny (failed for the watchdog's failure text), exit 0 + no output -> none,
//           anything else -> failed. Codex has no allow output (render.mjs renders an engine allow as
//           no output, exit 0), so compare.mjs counts a Claude allow equal to a Codex none.
export function classify(host, r) {
  if (!r || r.error || r.signal) return 'failed';
  const stdout = String(r.stdout ?? '').trim();
  const stderr = String(r.stderr ?? '');
  if (host === 'codex') {
    if (r.status === 2) return WATCHDOG_FAILURE.test(stderr) ? 'failed' : 'deny';
    return r.status === 0 && stdout === '' ? 'none' : 'failed';
  }
  if (r.status !== 0) return 'failed';
  if (stdout === '') return 'none';
  try {
    const out = JSON.parse(stdout).hookSpecificOutput;
    if (out?.permissionDecision === 'deny') return WATCHDOG_FAILURE.test(String(out.permissionDecisionReason)) ? 'failed' : 'deny';
    if (out?.permissionDecision === 'allow') return 'allow';
  } catch {
    // not a decision
  }
  return 'failed';
}

// Decided rows -> the per-family table over the dangerous rows, plus the benign blocked count.
export function familyTable(rows) {
  const counts = new Map();
  const total = { family: 'total', ruleBlocked: 0, allowed: 0, failed: 0 };
  let dangerous = 0;
  let benign = 0;
  let benignBlocked = 0;
  for (const r of rows) {
    if (r.expected === 'allow') {
      benign++;
      if (r.decision === 'deny') benignBlocked++;
      continue;
    }
    dangerous++;
    if (!counts.has(r.disguise)) counts.set(r.disguise, { family: r.disguise, ruleBlocked: 0, allowed: 0, failed: 0 });
    const c = counts.get(r.disguise);
    const key = r.decision === 'deny' ? 'ruleBlocked' : r.decision === 'failed' ? 'failed' : 'allowed';
    c[key]++;
    total[key]++;
  }
  const rank = (f) => (FAMILY_ORDER.includes(f) ? FAMILY_ORDER.indexOf(f) : FAMILY_ORDER.length);
  const families = [...counts.values()].sort((a, b) => rank(a.family) - rank(b.family));
  return { families, total, dangerous, benign, benignBlocked };
}

export function formatTable(t) {
  const row = (c) => `| ${c.family} | ${c.ruleBlocked} | ${c.allowed} | ${c.failed} |`;
  return [
    '| family | rule-blocked | allowed | failed |',
    '|---|---|---|---|',
    ...t.families.map(row),
    row(t.total),
    '',
    `dangerous blocked: ${t.total.ruleBlocked}/${t.dangerous}`,
    `benign blocked: ${t.benignBlocked}/${t.benign}`,
  ].join('\n');
}

function must(r, what) {
  if (r.error || r.status !== 0) throw new Error(`${what} failed: ${r.error?.message ?? `exit ${r.status}`} ${String(r.stderr ?? '').trim().slice(0, 500)}`);
  return r;
}

function parseArgs(argv) {
  const out = { out: null, policy: STRICT };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--out' && argv[i + 1]) out.out = nodePath.resolve(argv[i + 1]);
    else if (argv[i] === '--policy' && argv[i + 1]) out.policy = nodePath.resolve(argv[i + 1]);
    else throw new Error('usage: node run-codex.mjs [--out <dir>] [--policy <file>]');
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-jev-codex-')));
  const outDir = args.out ?? nodePath.join(root, 'out');
  nodeFs.mkdirSync(outDir, { recursive: true });
  const project = nodePath.join(root, 'project');
  const admin = nodePath.join(root, 'admin');
  for (const d of [project, admin]) nodeFs.mkdirSync(d, { recursive: true });
  must(spawnSync('git', ['init', '-q', project], { encoding: 'utf8' }), 'git init');
  must(spawnSync('git', ['-C', project, 'symbolic-ref', 'HEAD', 'refs/heads/acceptance'], { encoding: 'utf8' }), 'git symbolic-ref');

  const { home, watchdog } = stageHome(nodePath.join(root, 'stage'), { policyPath: args.policy });
  const policy = nodePath.join(home, '.config', 'fence', 'policy.json');

  const dump = must(
    spawnSync(process.env.UVX || 'uvx', ['--from', JEV_SPEC, 'python', '-c', DUMP, project], { cwd: project, encoding: 'utf8', timeout: UVX_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }),
    'the jev corpus dump',
  );
  const corpus = JSON.parse(dump.stdout);
  nodeFs.writeFileSync(nodePath.join(outDir, 'corpus.json'), `${JSON.stringify(corpus, null, 1)}\n`);

  const decide = (host, payload) => {
    const state = nodePath.join(root, `state-${host}`);
    const r = spawnSync(watchdog, ['pre', '--host', host, '--policy', policy, '--state-dir', state, '--admin-dir', admin], {
      input: JSON.stringify(payload),
      env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      cwd: project,
      encoding: 'utf8',
      timeout: HOOK_TIMEOUT_MS,
    });
    return classify(host, r);
  };
  const results = { codex: [], claude: [] };
  for (const row of corpus) {
    const meta = { id: row.id, category: row.category, disguise: row.disguise, expected: row.expected, tool: row.tool };
    results.codex.push({ ...meta, decision: decide('codex', toCodexPayload(row, { cwd: project })) });
    results.claude.push({ ...meta, decision: decide('claude', toClaudePayload(row, { cwd: project })) });
  }
  for (const host of ['codex', 'claude']) {
    nodeFs.writeFileSync(nodePath.join(outDir, `${host}-decisions.json`), `${JSON.stringify(results[host], null, 1)}\n`);
    process.stdout.write(`\n${host} (fence-hook pre --host ${host}), ${corpus.length} payloads:\n${formatTable(familyTable(results[host]))}\n`);
  }
  const { differing } = diffDecisions(results.claude, results.codex);
  process.stdout.write(`\ndiffering decisions (claude replay vs codex): ${differing.length}\n`);
  for (const id of differing) process.stdout.write(`  ${id}\n`);
  process.stdout.write(`\ndecisions written to ${outDir}\n`);
  return differing.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(nodePath.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`run-codex: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
