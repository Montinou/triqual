// The built-in self-protection table (fixtures/selfprotect-cases.json): a regression table of calls
// that must be denied with a `builtin:*` rule, each with a harmless twin that must not be denied.
//
//   loadCases(file?)                         -> the validated rows
//   prepareCase(row, {root})                 -> {skip, decide(which, profile?), dir} for one row
//   runBuiltinCases(io, {cases?, root?})     -> {passed, failed, skipped}; prints PASS/FAIL/SKIP lines
//
// Every row runs once per example profile (EXAMPLE_PROFILES: the spec's default, strict, relaxed and
// unattended), each selected with FENCE_PROFILE in the engine's environment, over the rules of the cases
// policy: the built-in denies must hold in every mode, so a row's attack is denied with its rule under all
// four, and its harmless twin is denied by no rule but `builtin:profile` (undecided under `unattended`).
// The profiles are written into a copy of the cases policy here until strict.json ships them.
//
// Analysis only: every call goes through the engine in process (runEngine), which reads the call and
// decides; nothing in a payload is ever executed. Each row gets a synthetic home and a synthetic
// repository under a temp root, so the user's real home, config and state are never read or written
// (the engine reads its home through os.homedir(), which follows HOME, so HOME is pinned to the
// synthetic home around each call). The one process that may start is the git of a `git` row, which
// builds a temp repository with the file in a commit (and, through the engine, the bounded tree check).
//
// Row: {id, host: claude|codex, tool, input, expectRule, harmless: {tool, input}, cwd?, requires?,
//       setup?: {files?: {path: text}, dirs?: [path], gitBranch?: {name, files: {path: text}}}}.
// Strings in `input`, `cwd` and `setup` expand ${home}, ${repo} and ${tmp} (the row's directory).
// `requires` names environment needs: "git" (a git >= 2.45.1 on PATH) and "case-insensitive" (the temp
// volume folds case); a row whose need is missing is skipped with the reason, never failed.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEngine } from '../engine.mjs';
import { isCaseInsensitive } from '../resolve/paths.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CASES_FILE = path.join(PKG_DIR, 'fixtures', 'selfprotect-cases.json');
export const CASES_POLICY = path.join(PKG_DIR, 'policies', 'strict.json');

// The spec's four example profiles.
export const EXAMPLE_PROFILES = Object.freeze({
  default: Object.freeze({ undecided: 'host', uncertain: 'audit' }),
  strict: Object.freeze({ undecided: 'host', uncertain: 'deny' }),
  relaxed: Object.freeze({ undecided: 'host', uncertain: 'audit', certain: 'audit' }),
  unattended: Object.freeze({ undecided: 'deny', uncertain: 'deny' }),
});

const HOSTS = new Set(['claude', 'codex']);
const REQUIRES = new Set(['git', 'case-insensitive']);
const MIN_GIT = [2, 45, 1];
const BASE_BRANCH = 'fence-base';
const GIT_TIMEOUT_MS = 20000;

export function loadCases(file = CASES_FILE) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.cases)) throw new Error(`${file}: expected {"cases": [...]}`);
  const seen = new Set();
  for (const c of doc.cases) {
    const where = `${file}: case ${JSON.stringify(c?.id)}`;
    if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || c.id === '') throw new Error(`${file}: a case has no id`);
    if (seen.has(c.id)) throw new Error(`${where}: duplicate id`);
    seen.add(c.id);
    if (!HOSTS.has(c.host)) throw new Error(`${where}: host must be claude or codex`);
    if (typeof c.tool !== 'string' || c.input === null || typeof c.input !== 'object') throw new Error(`${where}: needs a tool and an input object`);
    if (typeof c.expectRule !== 'string' || !c.expectRule.startsWith('builtin:')) throw new Error(`${where}: expectRule must be a builtin:* rule id`);
    if (typeof c.harmless?.tool !== 'string' || c.harmless.input === null || typeof c.harmless.input !== 'object') throw new Error(`${where}: needs a harmless twin {tool, input}`);
    for (const r of c.requires ?? []) if (!REQUIRES.has(r)) throw new Error(`${where}: unknown requirement ${JSON.stringify(r)}`);
  }
  return doc.cases;
}

function expand(value, vars) {
  if (typeof value === 'string') return value.replaceAll('${home}', vars.home).replaceAll('${repo}', vars.repo).replaceAll('${tmp}', vars.tmp);
  if (Array.isArray(value)) return value.map((v) => expand(v, vars));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [expand(k, vars), expand(v, vars)]));
  return value;
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A repository written by hand (no git binary): HEAD on a branch no policy protects.
function handBuiltRepo(repo) {
  const git = path.join(repo, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  put(path.join(git, 'HEAD'), `ref: refs/heads/${BASE_BRANCH}\n`);
  put(path.join(git, 'config'), '[core]\n\tbare = false\n');
  put(path.join(git, 'refs', 'heads', BASE_BRANCH), `${'0'.repeat(40)}\n`);
}

let gitFound;
// {path, version} of a git >= 2.45.1 found on PATH, or {reason}. Looked up once.
function findGit() {
  if (gitFound !== undefined) return gitFound;
  gitFound = { reason: 'no git binary on PATH' };
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { PATH: process.env.PATH ?? '' } });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout ?? '');
    if (r.status !== 0 || m === null) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
    const first = nums.findIndex((n, i) => n !== MIN_GIT[i]);
    const old = first !== -1 && nums[first] < MIN_GIT[first];
    gitFound = old ? { reason: `git ${version} is older than ${MIN_GIT.join('.')}, which the self-protection tree check needs` } : { path: candidate, version };
    break;
  }
  return gitFound;
}

// A real repository with the base branch plus `branch` holding `files` in a commit; HEAD ends on the base.
function gitRepo(repo, home, git, branch) {
  const env = { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const run = (...args) => {
    const r = spawnSync(git.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=fence', '-c', 'user.email=fence@example.invalid', ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  };
  run('init', '-q', '-b', BASE_BRANCH);
  put(path.join(repo, 'README.md'), 'x\n');
  run('add', 'README.md');
  run('commit', '-q', '-m', 'base');
  run('checkout', '-q', '-b', branch.name);
  for (const [rel, text] of Object.entries(branch.files ?? {})) {
    put(path.join(repo, rel), text);
    run('add', '-f', rel);
  }
  run('commit', '-q', '-m', 'branch');
  run('checkout', '-q', BASE_BRANCH);
}

function payloadFor(row, which, vars) {
  const call = which === 'harmless' ? row.harmless : row;
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'fence-selfprotect',
    ...(row.host === 'codex' ? { turn_id: 'turn-1' } : {}),
    cwd: expand(row.cwd ?? '${repo}', vars),
    permission_mode: 'default',
    tool_name: call.tool,
    tool_input: expand(call.input, vars),
    tool_use_id: 'toolu_selfprotect',
  };
}

// The cases policy's rules under the four example profiles, written to `file`.
function writeCasesPolicy(file) {
  const policy = JSON.parse(fs.readFileSync(CASES_POLICY, 'utf8'));
  put(file, JSON.stringify({ ...policy, profiles: EXAMPLE_PROFILES }));
}

// HOME (read by os.homedir()) pinned to the synthetic home for the engine call; the profile reaches the engine through its explicit env.
function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, FENCE_PROFILE: process.env.FENCE_PROFILE };
  process.env.HOME = home;
  delete process.env.FENCE_PROFILE;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// -> {skip: string|null, dir, decide(which: 'attack'|'harmless', profile = 'default')}. The row's directory is
// created under `root`; `profile` is passed to the engine as FENCE_PROFILE.
export function prepareCase(row, { root = os.tmpdir() } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, `case-${row.id.replace(/[^A-Za-z0-9_-]/g, '_')}-`)));
  const vars = { home: path.join(dir, 'home'), repo: path.join(dir, 'repo'), tmp: dir };
  fs.mkdirSync(vars.home, { recursive: true });
  fs.mkdirSync(vars.repo, { recursive: true });
  const state = path.join(dir, 'state');
  const admin = path.join(dir, 'admin');
  fs.mkdirSync(state);
  fs.mkdirSync(admin);

  const need = row.requires ?? [];
  let skip = null;
  let git = null;
  if (need.includes('case-insensitive') && !isCaseInsensitive(vars.home)) skip = 'the temporary volume is case-sensitive, so a case-flipped path is a different file';
  if (skip === null && (need.includes('git') || row.setup?.gitBranch !== undefined)) {
    git = findGit();
    if (git.path === undefined) skip = git.reason;
  }
  if (skip !== null) return { skip, dir, decide: () => ({ decision: 'skipped' }) };

  const setup = expand(row.setup ?? {}, vars);
  if (setup.gitBranch !== undefined) gitRepo(vars.repo, vars.home, git, setup.gitBranch);
  else handBuiltRepo(vars.repo);
  if (git !== null) put(path.join(vars.home, '.local', 'share', 'fence', 'git.json'), JSON.stringify({ path: git.path, version: git.version }));
  for (const d of setup.dirs ?? []) fs.mkdirSync(d, { recursive: true });
  for (const [file, text] of Object.entries(setup.files ?? {})) put(file, text);

  const policy = path.join(dir, 'policy.json');
  writeCasesPolicy(policy);
  const decide = (which, profile = 'default') => {
    const payload = payloadFor(row, which, vars);
    const argv = ['pre', '--host', row.host, '--policy', policy, '--state-dir', state, '--admin-dir', admin];
    const env = { PATH: process.env.PATH ?? '', HOME: vars.home, FENCE_PROFILE: profile };
    const r = withHome(vars.home, () => runEngine(argv, { stdin: JSON.stringify(payload), env }));
    return JSON.parse(r.stdout);
  };
  return { skip: null, dir, decide };
}

const show = (d) => `${d.decision} (rule ${d.rule ?? 'none'}): ${d.reason ?? ''}`;

// Runs every row; prints one PASS/FAIL/SKIP line each and a summary. A row passes when its call is denied
// with expectRule under every example profile and its harmless twin is denied by no rule but builtin:profile.
export function runBuiltinCases(io, { cases, root } = {}) {
  const tally = { passed: 0, failed: 0, skipped: 0 };
  let rows = cases;
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(root ?? os.tmpdir(), 'fence-test-selfprotect-')));
  try {
    try {
      rows ??= loadCases();
    } catch (err) {
      io.out(`FAIL builtin table: ${err.message}`);
      tally.failed++;
      rows = [];
    }
    for (const row of rows) {
      const label = `builtin ${row.id}`;
      try {
        const c = prepareCase(row, { root: base });
        if (c.skip) {
          tally.skipped++;
          io.out(`SKIP ${label}: ${c.skip}`);
          continue;
        }
        let failure = null;
        for (const profile of Object.keys(EXAMPLE_PROFILES)) {
          const attack = c.decide('attack', profile);
          if (attack.decision !== 'deny' || attack.rule !== row.expectRule) {
            failure = `under ${profile}: expected deny with ${row.expectRule}, got ${show(attack)}`;
            break;
          }
          const twin = c.decide('harmless', profile);
          if (twin.decision === 'deny' && twin.rule !== 'builtin:profile') {
            failure = `under ${profile}: the harmless twin was ${show(twin)}`;
            break;
          }
        }
        if (failure !== null) {
          tally.failed++;
          io.out(`FAIL ${label} ${failure}`);
          continue;
        }
        tally.passed++;
        io.out(`PASS ${label} (${row.expectRule})`);
      } catch (err) {
        tally.failed++;
        io.out(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  io.out(`built-in self-protection: ${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} skipped`);
  return tally;
}
