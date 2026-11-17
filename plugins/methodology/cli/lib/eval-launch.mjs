// The `claude` launcher of the session experiments: starts `claude` with the owner's arguments
// unchanged, adding `--session-id <uuid> --settings <file>` to a new interactive session of the active session
// experiment (the arm's settings object is the file), and `--settings <file>` to a resume of a session that was
// assigned. Everything else (print mode, continue, subcommands, help, no active experiment) starts `claude` as typed.
// `install`/`uninstall` add and remove the shell alias that routes `claude` here. node: built-ins only.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import {
  accessSync, appendFileSync, constants, existsSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, constants as osConstants } from 'node:os';
import { delimiter, join } from 'node:path';
import { SESSION_ARMS_FILE } from './eval-arms.mjs';
import { armFor, loadExperiments, validateExperiments } from './eval-experiments.mjs';
import { ensureDir, evalsDir, experimentsPath } from './eval-paths.mjs';

export const RC_LINE = "alias claude='triqual eval launch' # triqual eval launch";

// Any of these means the session is not a new interactive one the launcher may name: print mode, continue, fork, an
// id the owner chose, a pull request's, a teleported, a cloud or a background session, help and version.
const PASS_FLAGS = new Set([
  '-p', '--print', '-c', '--continue', '--fork-session', '--session-id', '--from-pr', '--teleport', '--cloud', '--bg',
  '-h', '--help', '-v', '--version',
]);
const PASS_EQ = ['--session-id=', '--from-pr=', '--teleport=', '--cloud=', '--bg='];
const RESUME_FLAGS = new Set(['-r', '--resume']);
const RESUME_EQ = '--resume=';

const EMPTY_HELP = { subcommands: [], valueOptions: [] };

// `claude --help` text -> { subcommands, valueOptions }. Subcommands: the names (a|b gives both) of the entries of the
// `Commands:` section, which sit at an indent of two. Value options: every name of an entry of `Options:` (indent two,
// starting with a dash) whose spec shows a value as <...> or [...]. Deeper-indented lines are descriptions.
export function parseHelp(text) {
  const subcommands = [];
  const valueOptions = [];
  let section = '';
  for (const line of String(text ?? '').split('\n')) {
    const header = /^([A-Z][A-Za-z ]*):\s*$/.exec(line);
    if (header) { section = header[1]; continue; }
    const entry = /^ {2}(\S.*)$/.exec(line);
    if (!entry) continue;
    const spec = entry[1].split(/\s{2,}/)[0];
    if (section === 'Commands') {
      const names = /^[\w|-]+/.exec(spec)?.[0];
      if (names) subcommands.push(...names.split('|').filter(Boolean));
    } else if (section === 'Options' && spec.startsWith('-')) {
      if (!/[<[]/.test(spec)) continue;
      const names = spec.replace(/[<[].*$/, '').split(/[,\s|]+/).filter((n) => n.startsWith('-'));
      valueOptions.push(...names);
    }
  }
  return { subcommands, valueOptions };
}

function defaultRun(bin, args, { env } = {}) {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '';
}

// The parsed help of `bin`, from <evalsDir>/launch/claude-help.json when it was made for this binary (its realpath, size
// and mtime) and spawned through `run(bin, ['--help'])` (which returns the stdout text) when not. An answer that parses
// to nothing is not cached.
export function helpCache({ bin, evalsDir: evals, run = defaultRun, env }) {
  let key;
  try {
    const real = realpathSync(bin);
    const st = statSync(real);
    key = { realpath: real, size: st.size, mtimeMs: st.mtimeMs };
  } catch { return EMPTY_HELP; }
  const file = join(evals, 'launch', 'claude-help.json');
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached?.realpath === key.realpath && cached.size === key.size && cached.mtimeMs === key.mtimeMs
      && Array.isArray(cached.help?.subcommands) && Array.isArray(cached.help?.valueOptions)) return cached.help;
  } catch { /* no cache or an unreadable one: ask the binary */ }
  const help = parseHelp(run(bin, ['--help'], { env }));
  if (help.subcommands.length === 0 && help.valueOptions.length === 0) return EMPTY_HELP;
  try {
    ensureDir(join(evals, 'launch'));
    writeFileSync(file, JSON.stringify({ ...key, help }), { mode: 0o600 });
  } catch { /* an unwritable cache costs a spawn next time */ }
  return help;
}

// { mode: 'pass' } (start claude as typed), { mode: 'resume', id } or { mode: 'assign' }, from the arguments and the
// parsed help. The first argument that is not an option (a value option's next token that does not start with a dash is
// its value) names a subcommand or is the prompt. A resume without an id opens claude's picker: nothing to look up, pass.
export function classify(argv, help) {
  if (argv.some((a) => PASS_FLAGS.has(a) || PASS_EQ.some((p) => a.startsWith(p)))) return { mode: 'pass' };
  const values = new Set(help.valueOptions);
  const subcommands = new Set(help.subcommands);
  let positional = false;
  let resume = null;
  let bareResume = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      if (arg.startsWith(RESUME_EQ)) { resume = arg.slice(RESUME_EQ.length); continue; }
      const next = argv[i + 1];
      const takes = next !== undefined && !next.startsWith('-') && !arg.includes('=');
      if (RESUME_FLAGS.has(arg)) {
        if (takes) { resume = next; i += 1; } else bareResume = true;
      } else if (takes && values.has(arg)) {
        i += 1;
      }
    } else if (!positional) {
      positional = true;
      if (subcommands.has(arg)) return { mode: 'pass' };
    }
  }
  if (bareResume) return { mode: 'pass' };
  return resume === null ? { mode: 'assign' } : { mode: 'resume', id: resume };
}

// TRIQUAL_CLAUDE_BIN, else the first executable regular file named claude on PATH; null when there is none.
export function findClaude(env) {
  if (env.TRIQUAL_CLAUDE_BIN) return env.TRIQUAL_CLAUDE_BIN;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, 'claude');
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch { /* not here */ }
  }
  return null;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// The arm and launch id of `sessionId` when every SessionStart record of it names one arm and one launch id (a record
// is { sessionId, source, arm, launchId, at }, written by lib/eval-arms.mjs); null otherwise.
function storedLaunch(evals, sessionId) {
  let text;
  try { text = readFileSync(join(evals, SESSION_ARMS_FILE), 'utf8'); } catch { return null; }
  let arm;
  let launchId;
  let seen = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.sessionId !== sessionId) continue;
    if (typeof r.arm !== 'string' || typeof r.launchId !== 'string' || !SAFE_ID.test(r.launchId)) return null;
    if (seen && (r.arm !== arm || r.launchId !== launchId)) return null;
    arm = r.arm;
    launchId = r.launchId;
    seen = true;
  }
  if (!seen) return null;
  const file = join(evals, 'launch', `${launchId}.json`);
  return existsSync(file) ? { arm, launchId, file } : null;
}

// What to start claude with: { args, env }. Anything unexpected falls back to the owner's arguments and environment
// unchanged: the launcher never stops claude from starting.
function prepare(argv, { env, home, bin, run, randomUUID, now, cwd }) {
  const unchanged = { args: argv, env };
  try {
    const experiments = loadExperiments(experimentsPath(env, home));
    if (!validateExperiments(experiments).ok) return unchanged;
    if (!experiments.some((e) => e.status === 'active' && e.kind === 'session')) return unchanged;
    const evals = evalsDir(env, home);
    const help = helpCache({ bin, evalsDir: evals, run, env });
    if (help.subcommands.length === 0 && help.valueOptions.length === 0) return unchanged;
    const c = classify(argv, help);
    if (c.mode === 'pass') return unchanged;
    if (c.mode === 'resume') {
      const stored = storedLaunch(evals, c.id);
      if (!stored) return unchanged;
      return {
        args: ['--settings', stored.file, ...argv],
        env: { ...env, TRIQUAL_EVAL_ARM: stored.arm, TRIQUAL_EVAL_LAUNCH: stored.launchId },
      };
    }
    const id = randomUUID();
    const hit = armFor('session', id, { experiments });
    if (!hit) return unchanged;
    const dir = join(evals, 'launch');
    ensureDir(dir);
    const file = join(dir, `${id}.json`);
    const patch = hit.payload !== null && typeof hit.payload === 'object' && !Array.isArray(hit.payload) ? hit.payload : {};
    writeFileSync(file, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 });
    const record = { launchId: id, experiment: hit.experiment.id, arm: hit.arm, cwd, at: now().toISOString() };
    appendFileSync(join(evals, 'assignments.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return {
      args: ['--session-id', id, '--settings', file, ...argv],
      env: { ...env, TRIQUAL_EVAL_ARM: `${hit.experiment.id}/${hit.arm}`, TRIQUAL_EVAL_LAUNCH: id },
    };
  } catch {
    return unchanged;
  }
}

// Runs the child with the terminal: SIGINT and SIGQUIT (the terminal sends them to the whole foreground group, so the
// child gets them itself) are ignored here, SIGTERM and SIGHUP are forwarded. Resolves the child's exit code (128 plus
// the signal number when a signal ended it, 127 when claude cannot be found, 126 when it cannot be run).
function runChild(spawn, bin, args, env, stderr) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'inherit', env });
    } catch (err) {
      stderr.write(`triqual eval launch: could not start claude: ${err?.code ?? 'error'}\n`);
      resolve(err?.code === 'ENOENT' ? 127 : 126);
      return;
    }
    const ignore = () => {};
    const forward = (sig) => () => { try { child.kill(sig); } catch { /* already gone */ } };
    const handlers = [
      ['SIGINT', ignore], ['SIGQUIT', ignore], ['SIGTERM', forward('SIGTERM')], ['SIGHUP', forward('SIGHUP')],
    ];
    for (const [sig, fn] of handlers) process.on(sig, fn);
    const done = (code) => {
      for (const [sig, fn] of handlers) process.removeListener(sig, fn);
      resolve(code);
    };
    child.on('error', (err) => {
      stderr.write(`triqual eval launch: could not start claude: ${err?.code ?? 'error'}\n`);
      done(err?.code === 'ENOENT' ? 127 : 126);
    });
    child.on('close', (code, signal) => {
      done(signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 0));
    });
  });
}

// Starts claude and resolves its exit code.
export async function launch(argv, deps = {}) {
  const {
    env = process.env, home = env.HOME || homedir(), stderr = process.stderr, spawn = nodeSpawn, run,
    randomUUID = nodeRandomUUID, now = () => new Date(), cwd = process.cwd(),
  } = deps;
  const bin = findClaude(env);
  if (!bin) {
    stderr.write('triqual eval launch: no claude found on PATH (set TRIQUAL_CLAUDE_BIN to its path)\n');
    return 127;
  }
  const plan = prepare(argv, { env, home, bin, run, randomUUID, now, cwd });
  return runChild(spawn, bin, plan.args, plan.env, stderr);
}

// Adds RC_LINE to the end of `rcFile` unless a line of it is exactly that; creates the file when missing. The file is
// written in place, so its mode and a symlink it may be are kept. { changed }.
export function install({ rcFile }) {
  let text = '';
  try { text = readFileSync(rcFile, 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  if (text.split('\n').includes(RC_LINE)) return { changed: false };
  const lead = text === '' || text.endsWith('\n') ? '' : '\n';
  writeFileSync(rcFile, `${text}${lead}${RC_LINE}\n`, { mode: 0o644 });
  return { changed: true };
}

// Removes the lines of `rcFile` that are exactly RC_LINE; a missing file or no such line changes nothing. { changed }.
export function uninstall({ rcFile }) {
  let text;
  try { text = readFileSync(rcFile, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return { changed: false };
    throw err;
  }
  const kept = text.split('\n').filter((l) => l !== RC_LINE);
  if (kept.length === text.split('\n').length) return { changed: false };
  writeFileSync(rcFile, kept.join('\n'));
  return { changed: true };
}
