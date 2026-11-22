// Per-repository setup config (replay-repos.json) and shell runner for replay clones. node: built-ins only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandDir } from './brand.mjs';

const DEFAULT_TIMEOUT_SECONDS = 600;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// brandDir($XDG_CONFIG_HOME or home/.config)/replay-repos.json (the directory of experiments.json).
export function replayReposPath(env, home) {
  return join(brandDir(env.XDG_CONFIG_HOME || join(home, '.config')), 'replay-repos.json');
}

// Loads replay-repos.json: missing file -> {}; unreadable/invalid JSON or invalid entry -> throws Error('replay-repos file: invalid <repoName>').
export function loadReplayRepos(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw new Error('replay-repos file: invalid unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('replay-repos file: invalid unreadable');
  }
  if (!isObject(raw)) throw new Error('replay-repos file: invalid unreadable');
  const out = {};
  for (const [repoName, entry] of Object.entries(raw)) {
    if (!isObject(entry) || typeof entry.setup !== 'string' || entry.setup === '') {
      throw new Error(`replay-repos file: invalid ${repoName}`);
    }
    const timeoutSeconds = entry.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_SECONDS : entry.timeoutSeconds;
    if (!isPositiveInt(timeoutSeconds)) {
      throw new Error(`replay-repos file: invalid ${repoName}`);
    }
    out[repoName] = { setup: entry.setup, timeoutSeconds };
  }
  return out;
}

// Launcher run by node: starts `/bin/sh -c <argv[1]>` as the leader of its own process group, and on timeout
// (argv[2] ms) SIGKILLs the whole group. Prints {code, timedOut} as JSON on stdout.
const LAUNCHER = `
const { spawn } = require('node:child_process');
const [command, ms] = [process.argv[1], Number(process.argv[2])];
const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}, ms);
child.on('error', () => { clearTimeout(timer); process.stdout.write(JSON.stringify({ code: null, timedOut: false })); });
child.on('exit', (code) => { clearTimeout(timer); process.stdout.write(JSON.stringify({ code, timedOut })); });
`;

// Runs `/bin/sh -c command` in `dir` (in its own process group, killed whole on timeout) with output discarded and a timeout in seconds.
export function runShell(dir, command, { timeoutSeconds, env }) {
  const start = Date.now();
  const r = spawnSync(process.execPath, ['-e', LAUNCHER, command, String(timeoutSeconds * 1000)], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  const seconds = (Date.now() - start) / 1000;
  let result = { code: null, timedOut: false };
  try {
    result = JSON.parse(r.stdout);
  } catch {}
  const { code, timedOut } = result;
  return { ok: code === 0 && !timedOut && !r.error, code, timedOut, seconds };
}

// Runs `entry.setup` in `dir` with `REPLAY_REPO=<repo>` added to `env`.
export function runSetup(dir, entry, { repo, env }) {
  const { ok, seconds } = runShell(dir, entry.setup, {
    timeoutSeconds: entry.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    env: { ...env, REPLAY_REPO: repo },
  });
  return { ok, seconds };
}
