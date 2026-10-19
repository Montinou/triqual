// `fence replay` (spec, "Acceptance", items 3 and 4): false blocks and latency, offline. Read-only and
// open to the agent: it decides tool calls, it never runs one.
//
//   fence replay --transcripts <dir> --policy <file> --out <dir> [--labels <file>]
//   runReplay(args, io, seams?) -> exit code (0 done, 1 a usage error, a refusal or a failure)
//   spawnHook(file, args, {input, env, cwd}) -> spawnSync result (the default spawner)
//
// There is no --home flag: replay is open to the agent, and a flag naming the home whose fence-hook is
// spawned would run an agent-written `<dir>/.local/bin/fence-hook`. The staged home of the acceptance
// runs is the `hookHome` seam (test/acceptance/replay-staged.mjs passes it).
//
// 1. --out is refused when it is, or lies under, a self-protected path (eval/builtin.mjs protectedGlobs
//    for the real home and for the hook home: the literal directory of every protected glob, so ~/.claude,
//    ~/.config/fence, ~/.local/share/fence, ...), or has a `.claude` or `.codex` component (a project's
//    protected directories; the project roots are not known here). Both the path as given and its real
//    path (the nearest existing parent resolved, the rest appended) are checked, case-folded. It must
//    not exist or be an empty directory (nothing is ever replaced), checked before any call is decided;
//    once created, its real path is checked again before the first file is written. Every output file
//    is created exclusively (`wx`).
// 2. Every `*.jsonl` under --transcripts (recursive, symlinks skipped) is a Claude Code transcript, walked
//    in order: files by their first record's `timestamp` (then by path), lines in file order. A line that
//    is not a JSON object counts as malformed, a record without a string `type` as unknown; both are
//    skipped. Each `tool_use` item of an `assistant` record (`message.content[]`, with `name`, `input`,
//    `id`; the cwd is the record's `cwd`, the session its `sessionId`) becomes a Claude PreToolUse payload;
//    an item without a name, with a non-object input, or a record without an absolute cwd is skipped
//    and counted. A tool_use id already decided (the same call in an earlier transcript, e.g. a resumed
//    session) is counted as a duplicate and not decided again.
// 3. Each payload is decided by spawning `<home>/.local/bin/fence-hook pre --host claude --policy <file>
//    --state-dir <tmp> --admin-dir <tmp>` (HOME=<home>; the hook home is the real home unless the
//    hookHome seam names a staged one) with the payload
//    on stdin: the real watchdog and engine processes, so the wall-clock time around that spawn is the
//    per-call latency. Nothing from a transcript is ever executed. The rule of each decision is read back
//    from the engine's log line in the temporary state directory (each payload carries a unique
//    `replay-<n>` tool_use_id).
// 4. After each decision, the paths a Write, Edit, MultiEdit, NotebookEdit or apply_patch event names are
//    appended to the temporary written-files index (log/written.mjs), whatever the decision: the
//    transcript records that the write happened, so a script written earlier is agent-written (opaque)
//    when a later call runs it.
// 5. Output (local; never commit it; a `.gitignore` of `*` is written beside it): denies.md (every deny with its rule and a `label:` field), undecided.md,
//    latency.json ({unit: "ms", samples, p50, p95, max}: nearest rank over the per-call wall-clock
//    times) and summary.md (counts, the decision profile, denies by rule, labels and the would-allow
//    rate, latency).
//    The temporary state and admin directories are removed afterwards.
//
// Labels (--labels <file>): one `<id>: would-allow` or `<id>: correct` per line, keyed by the ids of
// denies.md headings; blank lines and lines starting with `#` are ignored; any other line refuses the
// run. The would-allow rate is the denies labelled would-allow divided by the replayed commands (the
// shell command calls: Bash, Monitor; spec "Acceptance" item 3); summary.md also shows every call decided.
// A deny's id is its transcript tool_use id (when it is a plain identifier and not taken), else
// `call-<n>`; the same transcripts give the same ids.
//
// seams (only the code that calls runReplay can set them; no flag or environment variable reaches
// them): home (the real home, default os.homedir()), hookHome (the home whose .local/bin/fence-hook is
// spawned, default `home`; both are protected for --out), platform, now (a millisecond clock, default
// performance.now), spawnHook (default spawnHook below).

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { performance } from 'node:perf_hooks';

import { protectedGlobs } from '../eval/builtin.mjs';
import { parseApplyPatch } from '../hosts/patch.mjs';
import { lookupTool } from '../hosts/tools.mjs';
import { parseLines } from '../log/log.mjs';
import { redact } from '../log/redact.mjs';
import { appendWritten } from '../log/written.mjs';
import { isUnknown } from '../norm/unknown.mjs';
import { loadPolicy } from '../policy/load.mjs';
import { foldCase, resolvePath } from '../resolve/paths.mjs';
import { fencePaths } from './paths.mjs';

const USAGE = 'usage: fence replay --transcripts <dir> --policy <file> --out <dir> [--labels <file>]';
const VALUE_FLAGS = ['--transcripts', '--policy', '--out', '--labels'];
const HOOK_TIMEOUT_MS = 30_000;
const HOOK_MAX_BUFFER = 16 * 1024 * 1024;
const LATENCY_TARGETS = Object.freeze({ p50: 100, p95: 250 });
const RATE_TARGET_PERCENT = 1;
const INPUT_CAP = 500;
const REASON_CAP = 500;
const LABELS = Object.freeze(['would-allow', 'correct']);
const WRITE_FIELDS = Object.freeze({ Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' });
const CONTENT_KEYS = new Set(['content', 'new_string', 'old_string', 'edits', 'new_source']);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
// The watchdog's own failure text (watchdog.mjs failureText) and rule: such a deny is not a rule's.
const WATCHDOG_FAILURE = /could not check it/;
const WATCHDOG_RULE = 'builtin:watchdog';

class Refusal extends Error {}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAbs = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0');

export function spawnHook(file, args, { input, env, cwd } = {}) {
  return spawnSync(file, args, { input, env, cwd, encoding: 'utf8', timeout: HOOK_TIMEOUT_MS, maxBuffer: HOOK_MAX_BUFFER });
}

// ---- arguments -----------------------------------------------------------------------------------

function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (!VALUE_FLAGS.includes(flag)) throw new Refusal(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    let value;
    if (eq > 0 && flag !== a) value = a.slice(eq + 1);
    else if (i + 1 < args.length) value = String(args[++i]);
    if (value === undefined || value === '') throw new Refusal(`${flag} needs a value\n${USAGE}`);
    if (Object.hasOwn(values, flag)) throw new Refusal(`${flag} is given twice\n${USAGE}`);
    values[flag] = value;
  }
  for (const required of ['--transcripts', '--policy', '--out']) {
    if (!Object.hasOwn(values, required)) throw new Refusal(`${required} is required\n${USAGE}`);
  }
  const abs = (v) => (v === undefined ? undefined : nodePath.resolve(v));
  return {
    transcripts: abs(values['--transcripts']),
    policy: abs(values['--policy']),
    out: abs(values['--out']),
    labels: abs(values['--labels']),
  };
}

// ---- the --out refusal ----------------------------------------------------------------------------

// The real path of `p`: its nearest existing parent resolved, the missing rest appended.
function realOf(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return nodePath.join(nodeFs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = nodePath.dirname(cur);
      if (parent === cur) return p;
      rest.push(nodePath.basename(cur));
      cur = parent;
    }
  }
}

// The literal leading directory of an expanded glob (one-character classes unescaped); for a glob with
// no wildcard, the path itself.
function literalDir(glob) {
  const out = [];
  for (const seg of glob.split('/')) {
    if (/[*?[{]/.test(seg.replace(/\[([*?[$~])\]/g, ''))) break;
    out.push(seg.replace(/\[([*?[$~])\]/g, '$1'));
  }
  return out.join('/') || '/';
}

const covers = (base, p) => p === base || p.startsWith(base.endsWith('/') ? base : `${base}/`);

// -> null, or the protected path `out` is at or under
function protectedOut(out, homes, platform) {
  const candidates = [...new Set([out, realOf(out)])].map((p) => foldCase(p, true));
  for (const c of candidates) {
    const seg = c.split('/').find((s) => s === '.claude' || s === '.codex');
    if (seg !== undefined) return `a ${seg} directory`;
  }
  for (const home of homes) {
    for (const glob of protectedGlobs({ home, platform })) {
      const dir = literalDir(glob);
      if (dir === '/') continue;
      const folded = foldCase(dir, true);
      if (candidates.some((c) => covers(folded, c))) return dir;
    }
  }
  return null;
}

// ---- labels ---------------------------------------------------------------------------------------

function readLabels(file) {
  let text;
  try {
    text = nodeFs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Refusal(`the labels file ${file} can not be read (${err.code ?? err.message})`);
  }
  const labels = new Map();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const m = /^([^\s:]+)\s*:\s*(\S+)$/.exec(line);
    if (m === null || !LABELS.includes(m[2])) {
      throw new Refusal(`labels file ${file} line ${i + 1}: expected "<id>: would-allow" or "<id>: correct", got ${JSON.stringify(line)}`);
    }
    if (labels.has(m[1]) && labels.get(m[1]) !== m[2]) throw new Refusal(`labels file ${file} line ${i + 1}: ${m[1]} is labelled twice, differently`);
    labels.set(m[1], m[2]);
  });
  return labels;
}

// ---- transcripts ----------------------------------------------------------------------------------

function listTranscripts(root) {
  const files = [];
  const walk = (dir) => {
    let names;
    try {
      names = nodeFs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = nodePath.join(dir, name);
      let st;
      try {
        st = nodeFs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  return files;
}

function firstTimestamp(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"timestamp"')) continue;
    try {
      const v = JSON.parse(line);
      if (isPlainObject(v) && typeof v.timestamp === 'string') return v.timestamp;
    } catch {
      // not a record
    }
  }
  return '';
}

// -> [{file, rel, text}] in replay order
function orderedTranscripts(root) {
  const items = listTranscripts(root).map((file) => {
    let text = '';
    try {
      text = nodeFs.readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    return { file, rel: nodePath.relative(root, file), text, ts: text === null ? '' : firstTimestamp(text) };
  });
  return items.sort((a, b) => (a.ts === b.ts ? (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) : a.ts === '' ? 1 : b.ts === '' ? -1 : a.ts < b.ts ? -1 : 1));
}

// The paths a write-tool event names (lexical; resolved by the caller).
function writtenBy(tool, input) {
  if (Object.hasOwn(WRITE_FIELDS, tool)) {
    const v = input[WRITE_FIELDS[tool]];
    return typeof v === 'string' && v !== '' ? [v] : [];
  }
  if (tool === 'apply_patch') {
    const text = [input.command, input.patch, input.input].find((v) => typeof v === 'string');
    const ops = parseApplyPatch(text) ?? [];
    return ops.flatMap((o) => [o.path, o.from]).filter((p) => typeof p === 'string' && p !== '');
  }
  return [];
}

// ---- rendering ------------------------------------------------------------------------------------

const oneLine = (s) => String(s).replace(/\r?\n/g, '\\n').replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const capText = (s, n) => (s.length > n ? `${s.slice(0, n)}…[truncated]` : s);

function code(s) {
  const runs = s.match(/`+/g);
  const fence = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
  return fence.length > 1 || s.startsWith(' ') || s.endsWith(' ') ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

// What a call asks for, without file contents, redacted, on one line.
function inputSummary(tool, input) {
  let s;
  if (tool === 'apply_patch') {
    const text = [input.command, input.patch, input.input].find((v) => typeof v === 'string');
    const ops = parseApplyPatch(text);
    s = ops === null ? `apply_patch (${Buffer.byteLength(String(text ?? ''), 'utf8')} bytes, not an envelope)` : `apply_patch ${ops.map((o) => `${o.op} ${o.from ? `${o.from} -> ` : ''}${o.path}`).join(', ')}`;
  } else if (typeof input.command === 'string') {
    s = input.command;
  } else {
    s = JSON.stringify(input, (k, v) => (CONTENT_KEYS.has(k) ? `<${Buffer.byteLength(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 'utf8')} bytes>` : v)) ?? '';
  }
  return capText(oneLine(redact({ raw: s }).raw), INPUT_CAP);
}

function entry(call, { label } = {}) {
  const lines = [
    `## ${call.id}`,
    `- rule: ${call.rule ? code(call.rule) : '(none)'}`,
    `- tool: ${call.tool}`,
    `- transcript: ${call.transcript}:${call.line}`,
    `- session: ${call.session}`,
    `- cwd: ${call.cwd}`,
    `- input: ${code(call.input)}`,
  ];
  if (call.reason) lines.push(`- reason: ${capText(oneLine(redact({ raw: call.reason }).raw), REASON_CAP)}`);
  if (label !== undefined) lines.push(`- label:${label ? ` ${label}` : ''}`);
  return lines.join('\n');
}

function deniesMd(calls, labels, meta) {
  const head = [
    '# fence replay: denies',
    '',
    `Policy ${meta.policy}; ${calls.length} denies. Local output: never commit or publish it.`,
    '',
    'Label each deny for the owner: `would-allow` (fence blocked a call that should have run) or `correct`.',
    'Labels file (`fence replay ... --labels <file>`): one `<id>: would-allow` or `<id>: correct` per line,',
    'keyed by the ids of the headings below; blank lines and lines starting with `#` are ignored.',
    '',
  ];
  return `${[...head, ...calls.map((c) => `${entry(c, { label: labels?.get(c.id) ?? '' })}\n`)].join('\n')}`;
}

function undecidedMd(calls, meta) {
  const head = ['# fence replay: undecided', '', `Policy ${meta.policy}; ${calls.length} undecided calls (no rule matched; the profile decides).`, ''];
  return `${[...head, ...calls.map((c) => `${entry(c)}\n`)].join('\n')}`;
}

// nearest rank: the value at rank ceil(p/100 * n) of the sorted samples
function nearestRank(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}
const ms = (x) => (x === null ? null : Math.round(x * 100) / 100);

function latencyOf(calls) {
  const sorted = calls.map((c) => c.ms).sort((a, b) => a - b);
  return {
    unit: 'ms',
    method: 'wall-clock around each fence-hook spawn; nearest-rank percentiles',
    samples: sorted.length,
    p50: ms(nearestRank(sorted, 50)),
    p95: ms(nearestRank(sorted, 95)),
    max: ms(sorted.length ? sorted[sorted.length - 1] : null),
    targets: { ...LATENCY_TARGETS },
  };
}

function summaryMd(r, labels, latency, meta) {
  const by = (d) => r.calls.filter((c) => c.decision === d).length;
  const denies = r.calls.filter((c) => c.decision === 'deny' || c.decision === 'failed');
  const commands = r.calls.filter((c) => c.command).length;
  const rules = new Map();
  for (const c of denies) rules.set(c.rule ?? '(none)', (rules.get(c.rule ?? '(none)') ?? 0) + 1);
  const lines = [
    '# fence replay: summary',
    '',
    `Policy ${meta.policy}; watchdog ${meta.hook}. Local output: never commit or publish it.`,
    '',
    `- profile: ${r.profiles.join(', ')}`,
    `- transcripts: ${r.transcripts}`,
    `- lines read: ${r.lines}`,
    `- malformed lines: ${r.malformed}`,
    `- unknown records: ${r.unknown}`,
    `- tool_use items skipped: ${r.skipped}`,
    `- duplicate tool_use items: ${r.duplicates}`,
    `- unreadable transcripts: ${r.unreadable}`,
    `- commands replayed (Bash/shell): ${commands}`,
    `- calls decided: ${r.calls.length}`,
    `  - allow: ${by('allow')}`,
    `  - undecided: ${by('undecided')}`,
    `  - deny: ${by('deny')}`,
    `  - failed (watchdog): ${by('failed')}`,
    `- written-files index paths seeded: ${r.seeded}`,
    '',
    '## Denies by rule',
    '',
  ];
  if (rules.size === 0) lines.push('none');
  else {
    lines.push('| rule | denies |', '| --- | --- |');
    for (const [rule, n] of [...rules].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) lines.push(`| ${code(rule)} | ${n} |`);
  }
  lines.push('', '## Labels', '');
  if (labels === null) {
    lines.push('No labels file: label each deny in denies.md and run again with `--labels <file>`.', `- unlabelled: ${denies.length}`);
  } else {
    const ids = new Set(denies.map((c) => c.id));
    const count = (l) => denies.filter((c) => labels.get(c.id) === l).length;
    const wouldAllow = count('would-allow');
    const unlabelled = denies.filter((c) => !labels.has(c.id)).length;
    const unmatched = [...labels.keys()].filter((id) => !ids.has(id)).length;
    const pct = commands === 0 ? 0 : (100 * wouldAllow) / commands;
    const verdict =
      unlabelled > 0 ? `pending: ${unlabelled} denies unlabelled` : pct < RATE_TARGET_PERCENT ? 'met' : 'not met';
    lines.push(
      `- would-allow: ${wouldAllow}`,
      `- correct: ${count('correct')}`,
      `- unlabelled: ${unlabelled}`,
      `- labels with no matching deny: ${unmatched}`,
      `- would-allow rate: ${wouldAllow} / ${commands} commands = ${pct.toFixed(2)}% (target under ${RATE_TARGET_PERCENT}%: ${verdict}; ${r.calls.length} calls decided in all)`,
    );
  }
  lines.push('', '## Latency', '');
  if (latency.samples === 0) lines.push('no calls');
  else {
    const ok = latency.p50 < LATENCY_TARGETS.p50 && latency.p95 < LATENCY_TARGETS.p95;
    lines.push(
      `- p50 ${latency.p50} ms (target under ${LATENCY_TARGETS.p50} ms), p95 ${latency.p95} ms (target under ${LATENCY_TARGETS.p95} ms), max ${latency.max} ms, over ${latency.samples} calls: ${ok ? 'met' : 'not met'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// created exclusively: an existing file, or a symlink planted in its place, is never replaced or followed
function writeOut(dir, name, text) {
  nodeFs.writeFileSync(nodePath.join(dir, name), text, { flag: 'wx', mode: 0o600 });
}

// ---- the run --------------------------------------------------------------------------------------

// A hook run -> "deny" | "allow" | "none" | "failed", with the deny reason.
function classify(r) {
  if (!r || r.error || r.signal || r.status !== 0) return { kind: 'failed', reason: r?.error ? String(r.error.message ?? r.error) : `fence-hook exited ${r?.status ?? r?.signal}` };
  const stdout = String(r.stdout ?? '').trim();
  if (stdout === '') return { kind: 'none' };
  try {
    const out = JSON.parse(stdout).hookSpecificOutput;
    if (out?.permissionDecision === 'deny') {
      const reason = String(out.permissionDecisionReason ?? '');
      return { kind: WATCHDOG_FAILURE.test(reason) ? 'failed' : 'deny', reason };
    }
    if (out?.permissionDecision === 'allow') return { kind: 'allow' };
  } catch {
    // not a decision
  }
  return { kind: 'failed', reason: 'fence-hook printed something that is not a decision' };
}

// tool_use_id -> the engine's log entry, from every day file of the temporary state directory
function readLog(stateDir) {
  const byId = new Map();
  const dir = nodePath.join(stateDir, 'log');
  let names = [];
  try {
    names = nodeFs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return byId;
  }
  for (const name of names) {
    let text = '';
    try {
      text = nodeFs.readFileSync(nodePath.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const e of parseLines(text).entries) {
      if (typeof e.tool_use_id === 'string' && e.phase === undefined) byId.set(e.tool_use_id, e);
    }
  }
  return byId;
}

function run(opts, seams) {
  const { hook, hookHome, policy, stateDir, adminDir, tmpRoot } = opts;
  const now = seams.now;
  const spawn = seams.spawnHook;
  // a fixed minimal environment: the hook sees the staged home and no caller variable or git config,
  // except FENCE_PROFILE (when set), so the replay decides under the owner's profile
  const env = { PATH: process.env.PATH ?? '', HOME: hookHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (typeof process.env.FENCE_PROFILE === 'string') env.FENCE_PROFILE = process.env.FENCE_PROFILE;
  const r = { transcripts: 0, lines: 0, malformed: 0, unknown: 0, skipped: 0, duplicates: 0, unreadable: 0, seeded: 0, calls: [], profiles: [] };
  const usedIds = new Set();
  const decidedIds = new Set();
  const idFor = (orig, n) => {
    let id = typeof orig === 'string' && SAFE_ID.test(orig) && !usedIds.has(orig) ? orig : `call-${n}`;
    for (let k = 2; usedIds.has(id); k++) id = `call-${n}-${k}`;
    usedIds.add(id);
    return id;
  };

  for (const t of orderedTranscripts(opts.transcripts)) {
    r.transcripts++;
    if (t.text === null) {
      r.unreadable++;
      continue;
    }
    const fallbackSession = nodePath.basename(t.file, '.jsonl');
    t.text.split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      r.lines++;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        r.malformed++;
        return;
      }
      if (!isPlainObject(rec)) {
        r.malformed++;
        return;
      }
      if (typeof rec.type !== 'string') {
        r.unknown++;
        return;
      }
      if (rec.type !== 'assistant') return;
      const content = isPlainObject(rec.message) && Array.isArray(rec.message.content) ? rec.message.content : [];
      for (const item of content) {
        if (!isPlainObject(item) || item.type !== 'tool_use') continue;
        const input = item.input === undefined ? {} : item.input;
        if (typeof item.name !== 'string' || item.name === '' || !isPlainObject(input) || !isAbs(rec.cwd)) {
          r.skipped++;
          continue;
        }
        if (typeof item.id === 'string' && item.id !== '') {
          if (decidedIds.has(item.id)) {
            r.duplicates++;
            continue;
          }
          decidedIds.add(item.id);
        }
        const n = r.calls.length + 1;
        const session = typeof rec.sessionId === 'string' && rec.sessionId !== '' ? rec.sessionId : fallbackSession;
        const cwd = nodePath.resolve(rec.cwd);
        const payload = {
          session_id: session,
          transcript_path: t.file,
          cwd,
          permission_mode: 'default',
          hook_event_name: 'PreToolUse',
          tool_name: item.name,
          tool_input: input,
          tool_use_id: `replay-${n}`,
        };
        const args = ['pre', '--host', 'claude', '--policy', policy, '--state-dir', stateDir, '--admin-dir', adminDir];
        const t0 = now();
        const out = spawn(hook, args, { input: JSON.stringify(payload), env, cwd: tmpRoot });
        const elapsed = now() - t0;
        const c = classify(out);
        // a caller-only seam for live progress (the acceptance script prints it); never from argv
        if (typeof seams.progress === 'function') {
          try {
            seams.progress({ n, tool: item.name, kind: c.kind, ms: elapsed, transcript: t.rel });
          } catch {
            // progress is best effort
          }
        }
        r.calls.push({
          n,
          id: idFor(item.id, n),
          tool: item.name,
          command: lookupTool(item.name)?.command === true,
          transcript: t.rel,
          line: i + 1,
          session,
          cwd,
          input: inputSummary(item.name, input),
          kind: c.kind,
          reason: c.reason,
          ms: elapsed,
        });
        // the transcript says this write happened: the file is agent-written from here on
        const real = writtenBy(item.name, input)
          .map((p) => resolvePath(p, cwd, hookHome))
          .filter((p) => !isUnknown(p));
        if (real.length > 0 && appendWritten(stateDir, session, real).ok) r.seeded += real.length;
      }
    });
  }

  const log = readLog(stateDir);
  // the profile every decision was made under, as the engine logged it (else as it reads FENCE_PROFILE)
  const profiles = new Set();
  for (const c of r.calls) {
    const e = log.get(`replay-${c.n}`);
    if (typeof e?.profile === 'string') profiles.add(e.profile);
    if (c.kind === 'failed') {
      c.decision = 'failed';
      c.rule = WATCHDOG_RULE;
    } else {
      c.decision = c.kind === 'none' ? 'undecided' : c.kind;
      c.rule = typeof e?.rule === 'string' ? e.rule : null;
    }
  }
  r.profiles = profiles.size > 0 ? [...profiles].sort() : [env.FENCE_PROFILE === undefined ? 'default' : env.FENCE_PROFILE];
  return r;
}

export function replay(opts, seams = {}) {
  const realHome = isAbs(seams.home) ? seams.home : os.homedir();
  const platform = typeof seams.platform === 'string' ? seams.platform : process.platform;
  const s = {
    now: typeof seams.now === 'function' ? seams.now : () => performance.now(),
    spawnHook: typeof seams.spawnHook === 'function' ? seams.spawnHook : spawnHook,
    progress: typeof seams.progress === 'function' ? seams.progress : undefined,
  };
  const hookHome = isAbs(seams.hookHome) ? nodePath.resolve(seams.hookHome) : realHome;
  const homes = [...new Set([realHome, hookHome])];
  const refuseProtected = (p) => {
    const hit = protectedOut(p, homes, platform);
    if (hit !== null) throw new Refusal(`--out ${opts.out} is protected by fence's built-in self-protection (${hit}); choose a directory outside it`);
  };

  refuseProtected(opts.out);
  const isDir = (p) => {
    try {
      return nodeFs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  if (!isDir(opts.transcripts)) throw new Refusal(`--transcripts ${opts.transcripts} is not a directory`);
  if (!isDir(hookHome)) throw new Refusal(`the home ${hookHome} is not a directory`);
  try {
    loadPolicy(opts.policy, { mode: 'user', home: hookHome });
  } catch (err) {
    throw new Refusal(`the policy ${opts.policy} does not load: ${err.code ?? 'error'}${err.pointer ? ` at ${err.pointer}` : ''}: ${err.message}`);
  }
  const hook = fencePaths(hookHome).watchdog;
  try {
    if (!nodeFs.statSync(hook).isFile()) throw new Error('not a file');
  } catch {
    throw new Refusal(`no fence-hook at ${hook}: install fence first`);
  }
  const labels = opts.labels === undefined ? null : readLabels(opts.labels);
  let outEntry = null;
  try {
    outEntry = nodeFs.lstatSync(opts.out);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Refusal(`--out ${opts.out} can not be checked (${err?.code ?? err})`);
  }
  if (outEntry !== null) {
    if (!isDir(opts.out)) throw new Refusal(`--out ${opts.out} exists and is not a directory`);
    if (nodeFs.readdirSync(opts.out).length > 0) throw new Refusal(`--out ${opts.out} is not empty; name a new or empty directory (replay never replaces files)`);
  }

  const tmpRoot = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-replay-')));
  try {
    const stateDir = nodePath.join(tmpRoot, 'state');
    const adminDir = nodePath.join(tmpRoot, 'admin');
    nodeFs.mkdirSync(stateDir, { mode: 0o700 });
    nodeFs.mkdirSync(adminDir, { mode: 0o700 });
    const result = run({ hook, hookHome, policy: opts.policy, transcripts: opts.transcripts, stateDir, adminDir, tmpRoot }, s);
    const latency = latencyOf(result.calls);
    const meta = { policy: opts.policy, hook };
    nodeFs.mkdirSync(opts.out, { recursive: true, mode: 0o700 });
    // the directory as it now exists (a parent may have been swapped while the calls were decided)
    refuseProtected(nodeFs.realpathSync.native(opts.out));
    if (nodeFs.readdirSync(opts.out).length > 0) throw new Refusal(`--out ${opts.out} is no longer empty; nothing was written`);
    writeOut(opts.out, '.gitignore', '*\n');
    writeOut(opts.out, 'denies.md', deniesMd(result.calls.filter((c) => c.decision === 'deny' || c.decision === 'failed'), labels, meta));
    writeOut(opts.out, 'undecided.md', undecidedMd(result.calls.filter((c) => c.decision === 'undecided'), meta));
    writeOut(opts.out, 'latency.json', `${JSON.stringify(latency, null, 2)}\n`);
    writeOut(opts.out, 'summary.md', summaryMd(result, labels, latency, meta));
    return { result, latency };
  } finally {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function runReplay(args, io, seams = {}) {
  try {
    const opts = parseArgs(Array.isArray(args) ? args : []);
    const { result, latency } = replay(opts, seams ?? {});
    const by = (d) => result.calls.filter((c) => c.decision === d).length;
    io.out(
      `fence replay: ${result.calls.length} calls decided (${by('allow')} allow, ${by('undecided')} undecided, ${by('deny')} deny, ${by('failed')} failed); p50 ${latency.p50 ?? '-'} ms, p95 ${latency.p95 ?? '-'} ms; output in ${opts.out}`,
    );
    return 0;
  } catch (err) {
    io.err(`fence: replay: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
