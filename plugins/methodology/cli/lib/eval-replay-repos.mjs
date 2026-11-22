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

// Runs `/bin/sh -c command` in `dir` with output discarded and a timeout in seconds.
export function runShell(dir, command, { timeoutSeconds, env }) {
  const start = Date.now();
  const r = spawnSync('/bin/sh', ['-c', command], {
    cwd: dir,
    env,
    stdio: 'ignore',
    timeout: timeoutSeconds * 1000,
    killSignal: 'SIGKILL',
  });
  const seconds = (Date.now() - start) / 1000;
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const code = r.status ?? null;
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
