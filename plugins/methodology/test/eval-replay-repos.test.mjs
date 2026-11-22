import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  replayReposPath,
  loadReplayRepos,
  runShell,
  runSetup,
} from '../cli/lib/eval-replay-repos.mjs';

let tmp;
let home;
let f;
let dir;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'replay-repos-fixture-'));
  home = join(tmp, 'home');
  f = join(tmp, 'replay-repos.json');
  dir = join(tmp, 'dir');
  mkdirSync(dir, { recursive: true });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('replayReposPath follows XDG_CONFIG_HOME', () => {
  assert.equal(replayReposPath({ XDG_CONFIG_HOME: '/x' }, '/h'), '/x/triqual/replay-repos.json');
  assert.equal(replayReposPath({}, home), join(home, '.config', 'triqual', 'replay-repos.json'));
});

test('a missing file is no entries; timeoutSeconds defaults to 600', () => {
  assert.deepEqual(loadReplayRepos(join(tmp, 'none.json')), {});
  writeFileSync(f, JSON.stringify({ app: { setup: 'true' } }));
  assert.deepEqual(loadReplayRepos(f), { app: { setup: 'true', timeoutSeconds: 600 } });
});

test('an entry without setup is refused, naming the repository', () => {
  writeFileSync(f, JSON.stringify({ app: { timeoutSeconds: 5 } }));
  assert.throws(() => loadReplayRepos(f), /invalid app/);
});

test('runSetup passes REPLAY_REPO and reports ok', () => {
  const r = runSetup(dir, { setup: 'test "$REPLAY_REPO" = /main && touch done', timeoutSeconds: 10 }, { repo: '/main', env: process.env });
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(dir, 'done')));
});

test('a failing setup returns ok false', () => {
  assert.equal(runSetup(dir, { setup: 'exit 3', timeoutSeconds: 10 }, { repo: '/main', env: process.env }).ok, false);
});

test('runShell times out', () => {
  const r = runShell(dir, 'sleep 5', { timeoutSeconds: 1, env: process.env });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});

test('runShell timeout kills the whole process group, not only the shell', () => {
  const marker = `sleep 5.${process.pid}`;
  const r = runShell(dir, `${marker}; true`, { timeoutSeconds: 1, env: process.env });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  const left = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
  assert.equal(left.stdout.trim(), '', `orphaned process left: ${left.stdout}`);
});

test('runShell passes the command as an argument and reports its exit code', () => {
  assert.deepEqual(
    (({ ok, code, timedOut }) => ({ ok, code, timedOut }))(runShell(dir, 'exit 3', { timeoutSeconds: 5, env: process.env })),
    { ok: false, code: 3, timedOut: false },
  );
  const r = runShell(dir, `test "$X" = 'a b"; touch injected' && true`, { timeoutSeconds: 5, env: { ...process.env, X: 'a b"; touch injected' } });
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(dir, 'injected')), false);
});
