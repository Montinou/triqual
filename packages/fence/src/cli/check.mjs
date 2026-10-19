// `fence check [--policy f]` and `fence test [--policy f]` (read-only, open to the agent).
//
// check: load and validate the policy; exit 1 naming the file, error code and JSON pointer on
//        a load error; warn (exit 0) on any allow rule that can cover a `runs-repo-code` part:
//        one whose `class` lists it, or one with an `argv` match (an argv match alone covers
//        runs-repo-code). A rule without either can not cover such a part (see evaluate.mjs).
//        Also warns (exit 0) on a profile's `uncertain.constructs` name that fence never reports
//        (src/norm/constructs.mjs): construct names are free strings, so an unknown one is a likely typo.
// test:  run each rule's examples through the evaluator with the default profile, in a fresh
//        temporary repo directory (the example cwd and repo root; `${repo}`, `${cwd}` and
//        relative paths resolve inside it, `~` to the home; paths are realpath-resolved). A
//        `deny` example passes when the call is denied; an `allow` example passes when it is
//        allowed (allow rule) or not denied (deny rule).
//        Shell examples (a `command`, or a shell tool) run through the engine (runEngine, in
//        process, with the policy file and temporary state and admin directories, so no grant,
//        log or written-files index of the real install is read or written): a Claude
//        Bash/Monitor payload, or a Codex payload for a Codex shell tool, with the example
//        command text (or argv) and the temporary repo as cwd.
//        Examples are judged against the policy with every mode's audit turned into deny (forceDeny): an example
//        asks whether the rule would deny the call, whatever mode a session later runs in. The forced policy is
//        written to a temporary file the engine reads (`--policy`), and loaded back for the other examples.
//        runTest(args, io, {home}) takes the home directory from its third argument (default
//        os.homedir()); `fence apply` passes its own so a draft is tested against the same home.
//        After the examples it runs the built-in self-protection table (selfprotect.mjs), one
//        PASS/FAIL/SKIP line per case; a failing built-in case fails the command too. `builtin: false`
//        leaves it out (`fence apply` tests a draft policy only); `builtinCases` replaces the table.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runEngine } from '../engine.mjs';
import { evaluate } from '../eval/evaluate.mjs';
import { ARGV_COVERED_CLASSES } from '../policy/classes.mjs';
import { isKnownConstruct } from '../norm/constructs.mjs';
import { loadPolicy } from '../policy/load.mjs';
import { runBuiltinCases } from './selfprotect.mjs';

export const DEFAULT_POLICY = (home) => path.join(home, '.config', 'fence', 'policy.json');

const SHELL_TOOLS = new Set(['Bash', 'Monitor', 'shell', 'exec_command', 'local_shell', 'container.exec', 'write_stdin']);
const EXAMPLE_BRANCH = 'fence-test';
const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'Monitor']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

class UsageError extends Error {}

function parseArgs(args, home) {
  let policy = DEFAULT_POLICY(home);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--policy') {
      if (i + 1 >= args.length || args[i + 1] === '') throw new UsageError('--policy needs a file');
      policy = args[++i];
    } else if (a.startsWith('--policy=') && a.length > '--policy='.length) {
      policy = a.slice('--policy='.length);
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  return { policy: path.resolve(policy) };
}

function describeError(err, file) {
  const where = err.pointer ? ` at ${err.pointer}` : '';
  return `fence: ${err.path ?? file}: ${err.code ?? 'error'}${where}: ${err.message}`;
}

// Loads the policy for a command; returns {loaded} or {code} after printing the error.
function load(args, io, home = os.homedir()) {
  let file;
  try {
    file = parseArgs(args, home).policy;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`fence: ${err.message}`);
    return { code: 1 };
  }
  try {
    return { loaded: loadPolicy(file, { mode: 'user', home }), file, home };
  } catch (err) {
    io.err(describeError(err, file));
    return { code: 1 };
  }
}

// True when an allow rule can cover a part carrying class `cls`.
function allowCanCover(rule, cls) {
  if (rule.decision !== 'allow') return false;
  if (rule.match.class?.includes(cls)) return true;
  return Boolean(rule.match.argv) && ARGV_COVERED_CLASSES.includes(cls);
}

export function runCheck(args, io) {
  const r = load(args, io);
  if (!r.loaded) return r.code;
  const { policy, sha } = r.loaded;
  for (const rule of policy.rules) {
    if (allowCanCover(rule, 'runs-repo-code')) {
      const how = rule.match.class?.includes('runs-repo-code') ? 'lists runs-repo-code' : 'has an argv match, which covers runs-repo-code';
      io.err(
        `fence: warning: allow rule "${rule.id}" ${how}: it lets the agent run repository code (tests, scripts, hooks) whose contents fence does not read.`,
      );
    }
  }
  for (const [name, profile] of Object.entries(policy.profiles)) {
    for (const construct of Object.keys(profile.uncertain.constructs)) {
      if (isKnownConstruct(construct)) continue;
      io.err(
        `fence: warning: profile "${name}": uncertain.constructs names "${construct}", which is not in fence's known list of opaque constructs (a likely typo).`,
      );
    }
  }
  const n = policy.rules.length;
  io.out(`fence: ${r.file} is valid (${n} rule${n === 1 ? '' : 's'}, sha256 ${sha})`);
  return 0;
}

// The realpath of an absolute path: the deepest existing ancestor resolved, the rest appended.
function realpathLoose(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function expandExamplePath(p, cwd, repo, home) {
  let out = p.replaceAll('${repo}', repo).replaceAll('${cwd}', cwd);
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = path.posix.join(home, out.slice(2));
  return realpathLoose(path.posix.resolve(cwd, out));
}

function exampleSummary(ex) {
  const tool = typeof ex.tool === 'string' ? ex.tool : '?';
  const detail = ex.command ?? ex.path ?? ex.file_path ?? ex.notebook_path ?? ex.url;
  if (detail === undefined) return tool;
  return `${tool} ${Array.isArray(detail) ? detail.join(' ') : String(detail)}`;
}

function isShellExample(ex) {
  return ex.command !== undefined || SHELL_TOOLS.has(ex.tool);
}

// A canonical call built from an example fragment (non-shell tools only).
function exampleCall(ex, home, repo) {
  const tool = typeof ex.tool === 'string' ? ex.tool : '';
  const cwd = typeof ex.cwd === 'string' && ex.cwd.startsWith('/') ? ex.cwd : repo;
  const call = { host: 'test', event: 'pre', tool, cwd, paths: [], repo: { root: repo, branch: null } };
  const p = ex.path ?? ex.file_path ?? ex.notebook_path;
  if (p !== undefined) {
    const access = ex.access === 'read' || ex.access === 'write' ? ex.access : WRITE_TOOLS.has(tool) ? 'write' : 'read';
    call.paths.push({ path: typeof p === 'string' ? expandExamplePath(p, cwd, repo, home) : p, access });
  }
  if (ex.url !== undefined) call.url = ex.url;
  if (tool.startsWith('mcp__')) call.mcp = tool;
  return call;
}

// Marks `repo` as a git repository on a branch no policy protects (written by hand: no git
// binary runs), so the engine resolves `${repo}` in shell examples to it, as it does for the
// other examples.
function makeExampleRepo(repo) {
  const git = path.join(repo, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), `ref: refs/heads/${EXAMPLE_BRANCH}\n`);
  fs.writeFileSync(path.join(git, 'config'), '[core]\n\tbare = false\n');
  fs.writeFileSync(path.join(git, 'refs', 'heads', EXAMPLE_BRANCH), `${'0'.repeat(40)}\n`);
}

// The decision the engine gives a shell example: its host payload goes through runEngine.
function shellDecision(ex, file, repo, aux, home) {
  const tool = typeof ex.tool === 'string' ? ex.tool : 'Bash';
  const cwd = typeof ex.cwd === 'string' && ex.cwd.startsWith('/') ? ex.cwd : repo;
  const claudeHost = CLAUDE_SHELL_TOOLS.has(tool);
  const command = claudeHost && Array.isArray(ex.command) ? ex.command.join(' ') : ex.command;
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: ex.command === undefined ? {} : { command },
    cwd,
    session_id: 'fence-test',
    permission_mode: 'default',
  };
  // Examples run under the default profile in a fixed minimal environment, so `fence test` gives the
  // same answer on every machine (no caller variable, no user or system git config reaches the engine).
  const env = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const argv = ['pre', '--host', claudeHost ? 'claude' : 'codex', '--policy', file, '--state-dir', path.join(aux, 'state'), '--admin-dir', path.join(aux, 'admin')];
  const r = runEngine(argv, { stdin: JSON.stringify(payload), env });
  return JSON.parse(r.stdout);
}

// A copy of `policy` in which nothing is audited or switched off: every profile's uncertain categories and
// constructs, `certain` and `rules` overrides are `deny`, and every rule with `decision: "audit"` is `deny`.
// `undecided` stays as written. The input is not changed. It reads a policy as written in the file (where
// `uncertain` may be a single action) and as the loader returns it.
export function forceDeny(policy) {
  const forced = JSON.parse(JSON.stringify(policy));
  for (const profile of Object.values(forced.profiles ?? {})) {
    if (typeof profile.uncertain === 'string') {
      profile.uncertain = 'deny';
    } else if (profile.uncertain !== null && typeof profile.uncertain === 'object') {
      for (const key of Object.keys(profile.uncertain)) {
        if (key === 'constructs') for (const name of Object.keys(profile.uncertain.constructs)) profile.uncertain.constructs[name] = 'deny';
        else profile.uncertain[key] = 'deny';
      }
    }
    if (Object.hasOwn(profile, 'certain')) profile.certain = 'deny';
    if (profile.rules !== null && typeof profile.rules === 'object') for (const id of Object.keys(profile.rules)) profile.rules[id] = 'deny';
  }
  for (const rule of forced.rules ?? []) if (rule.decision === 'audit') rule.decision = 'deny';
  return forced;
}

export function runTest(args, io, { home, builtin = true, builtinCases } = {}) {
  const r = load(args, io, home ?? os.homedir());
  if (!r.loaded) return r.code;
  const opts = { profile: 'default', grants: [], ctx: { home: r.home, platform: process.platform, caseInsensitive: false } };
  // A fresh, real repo directory for the examples and a directory for the engine's state and
  // admin paths, both removed afterwards.
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-test-repo-')));
  const aux = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-test-aux-')));
  try {
    makeExampleRepo(repo);
    // The forced policy is built from the file as written (its `~` and `${repo}` globs stay for the engine to
    // expand), written to a temporary file for the engine, and loaded back for the examples run in process.
    const forcedFile = path.join(aux, 'forced-policy.json');
    fs.writeFileSync(forcedFile, JSON.stringify(forceDeny(JSON.parse(fs.readFileSync(r.file, 'utf8')))));
    const { policy } = loadPolicy(forcedFile, { mode: 'user', home: r.home });
    const code = runExamples(policy, opts, r.home, repo, io, { file: forcedFile, aux });
    if (!builtin) return code;
    // The built-in self-protection table, after the policy examples: independent of the policy under
    // test and judged against a synthetic home and repository (analysis only, see selfprotect.mjs).
    const table = runBuiltinCases(io, builtinCases === undefined ? {} : { cases: builtinCases });
    return code !== 0 || table.failed > 0 ? 1 : 0;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(aux, { recursive: true, force: true });
  }
}

function runExamples(policy, opts, home, repo, io, shell) {
  let passed = 0;
  let failed = 0;
  const skipped = 0; // every example runs now; the count stays in the summary line
  for (const rule of policy.rules) {
    for (const expected of ['deny', 'allow']) {
      const examples = rule.examples?.[expected] ?? [];
      examples.forEach((ex, i) => {
        const label = `${rule.id} ${expected}[${i}] ${exampleSummary(ex)}`;
        const result = isShellExample(ex) ? shellDecision(ex, shell.file, repo, shell.aux, home) : evaluate(policy, exampleCall(ex, home, repo), null, opts);
        const want = expected === 'deny' ? 'deny' : rule.decision === 'allow' ? 'allow' : 'not deny';
        const ok = want === 'not deny' ? result.decision !== 'deny' : result.decision === want;
        if (ok) {
          passed++;
          io.out(`PASS ${label}`);
        } else {
          failed++;
          io.out(`FAIL ${label}: expected ${want}, got ${result.decision} (rule ${result.rule ?? 'none'}): ${result.reason}`);
        }
      });
    }
  }
  io.out(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed > 0 ? 1 : 0;
}
