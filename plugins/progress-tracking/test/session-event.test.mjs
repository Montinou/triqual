import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openSessions, readSessions } from '../lib/sessions.mjs';

const script = new URL('../scripts/session-event.mjs', import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/hook-payloads.jsonl', import.meta.url), 'utf8').split('\n')[0]);
function setup(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'session-event-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  mkdirSync(join(home, '.config', 'triqual'), { recursive: true });
  const data = join(home, 'data');
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: data };
  for (const key of ['TRIQUAL_TRACKING_DB', 'CM_TRACKING_DB', 'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR', 'TRIQUAL_SESSIONS']) delete env[key];
  const register = roots => writeFileSync(join(home, '.config', 'triqual', 'repos.json'), JSON.stringify({ version: 1, repos: roots.map(root => ({ root: realpathSync(root), mode: 'store' })) }));
  register([repo]);
  const run = (payload = { ...fixture, cwd: repo }, extra = {}) => spawnSync(process.execPath, [script.pathname], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...env, ...extra }, encoding: 'utf8' });
  const file = join(data, 'triqual', 'sessions.db');
  const rows = () => {
    const db = openSessions(join(data, 'triqual'));
    try { return readSessions(db, { since: 0, now: Date.now() }); } finally { db.close(); }
  };
  return { home, repo, register, run, file, rows };
}
function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
}
test('a payload inside a registered repo is recorded', t => {
  const s = setup(t);
  success(s.run());
  assert.ok(existsSync(s.file));
  assert.equal(s.rows()[0].repoRoot, s.repo);
  assert.equal(s.rows()[0].sessionId, fixture.session_id);
  assert.ok(!existsSync(join(s.home, 'data', 'triqual', 'tracking.db')));
});
test('the deepest nested root wins', t => {
  const s = setup(t);
  const nested = join(s.repo, 'nested');
  mkdirSync(nested);
  s.register([nested, s.repo]);
  success(s.run({ ...fixture, cwd: nested }));
  assert.equal(s.rows()[0].repoRoot, nested);
});
test('a payload outside any registered repo writes nothing', t => {
  const s = setup(t);
  success(s.run({ ...fixture, cwd: `${s.repo}-outside` }));
  assert.ok(!existsSync(s.file));
});
test('malformed JSON exits 0 and writes nothing', t => {
  const s = setup(t);
  success(s.run('{broken'));
  assert.ok(!existsSync(s.file));
});
test('TRIQUAL_SESSIONS=0 writes nothing', t => {
  const s = setup(t);
  success(s.run(undefined, { TRIQUAL_SESSIONS: '0' }));
  assert.ok(!existsSync(s.file));
});
test('an unresolved cwd falls back to the string', t => {
  const s = setup(t);
  success(s.run({ ...fixture, cwd: join(s.repo, 'gone') }));
  assert.equal(s.rows()[0].repoRoot, s.repo);
});
test('a disabled store writes nothing', t => {
  const s = setup(t);
  success(s.run(undefined, { TRIQUAL_TRACKING_DB: '' }));
  assert.ok(!existsSync(s.file));
});
test('hooks.json declares the six async recorder entries and leaves the gate entries unchanged', () => {
  const { hooks } = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const gateStart = { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" session-start', timeout: 15 }] };
  const gateStop = { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" stop', timeout: 15, statusMessage: 'Checking progress tracking' }] };
  assert.deepEqual(hooks.SessionStart[0], gateStart);
  assert.deepEqual(hooks.Stop, [gateStop]);
  const recorder = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-event.mjs"', async: true, timeout: 10 };
  for (const event of ['SessionStart', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd']) {
    const entries = hooks[event].filter(entry => entry.hooks.some(hook => hook.command === recorder.command));
    assert.equal(entries.length, 1, event);
    assert.deepEqual(entries[0].hooks, [recorder]);
    if (event === 'SessionStart') assert.equal(entries[0].matcher, gateStart.matcher);
  }
});
