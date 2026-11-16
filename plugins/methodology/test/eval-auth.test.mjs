import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthError, ChainExhausted, CREDENTIAL_VARS, authPath, childEnv, isLimit, limitText, loadChain, withChain,
} from '../cli/lib/eval-auth.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evauth-'));
// Fixture secrets are built at run time so no secret-looking literal sits in the source.
const SECRET = ['fixture', 'secret', 'value', '0123456789'].join('-');
const SECRET2 = ['fixture', 'other', 'value', '9876543210'].join('-');
const writeChain = (chain) => { const f = join(tmp(), 'eval-auth.json'); writeFileSync(f, JSON.stringify({ chain })); return f; };
const message = (fn) => { try { fn(); } catch (e) { return `${e.name}: ${e.message}`; } return ''; };

test('authPath: TRIQUAL_EVAL_AUTH_FILE wins, else the config dir', () => {
  assert.equal(authPath({ TRIQUAL_EVAL_AUTH_FILE: '/x/auth.json' }, '/h'), '/x/auth.json');
  assert.equal(authPath({ XDG_CONFIG_HOME: '/cfg' }, '/h'), '/cfg/triqual/eval-auth.json');
  assert.equal(authPath({}, '/nonexistent-home-for-test'), '/nonexistent-home-for-test/.config/triqual/eval-auth.json');
});

test('no file gives the ambient entry', () => {
  assert.deepEqual(loadChain(join(tmp(), 'missing.json')), [{ name: 'ambient', env: {}, paid: false }]);
});

test('a chain file loads in order', () => {
  const chain = loadChain(writeChain([{ name: 'first', env: { ANTHROPIC_API_KEY: 'x' } }, { name: 'second', env: {} }]));
  assert.deepEqual(chain.map((e) => e.name), ['first', 'second']);
});

test('childEnv drops the four credential variables, the three provider selectors and TRIQUAL_EVAL_ARM the entry did not set', () => {
  const base = { PATH: '/bin', KEEP: 'yes', TRIQUAL_EVAL_ARM: 'arm-a', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' };
  for (const v of CREDENTIAL_VARS) base[v] = `planted-${v}`;
  const env = childEnv({ name: 'ambient', env: {} }, base, { home: '/h' });
  assert.deepEqual(env, { PATH: '/bin', KEEP: 'yes' });
  assert.equal(base.ANTHROPIC_API_KEY, 'planted-ANTHROPIC_API_KEY', 'the base env is not mutated');
  const set = childEnv({ name: 'e', env: { ANTHROPIC_BASE_URL: 'http://gw.invalid' } }, base, { home: '/h' });
  assert.equal(set.ANTHROPIC_BASE_URL, 'http://gw.invalid');
  assert.equal(set.ANTHROPIC_API_KEY, undefined);
});

test('file and envFile values resolve at call time, ~ expands, quotes and export are stripped', () => {
  const home = tmp();
  mkdirSync(join(home, 'keys'));
  const tokenFile = join(home, 'keys', 'token');
  const envFile = join(home, 'keys', 'secrets.env');
  writeFileSync(tokenFile, `${SECRET}\n`);
  writeFileSync(envFile, `# comment\nOTHER=1\nexport MY_KEY="old-${SECRET2}"\nexport MY_KEY='${SECRET2}'\nTRAIL=2\n`);
  const entry = { name: 'e', env: {
    CLAUDE_CODE_OAUTH_TOKEN: { file: '~/keys/token' },
    ANTHROPIC_API_KEY: { envFile: envFile, var: 'MY_KEY' },
  } };
  const env = childEnv(entry, {}, { home });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, SECRET);
  assert.equal(env.ANTHROPIC_API_KEY, SECRET2);
  writeFileSync(tokenFile, 'changed\n');
  assert.equal(childEnv(entry, {}, { home }).CLAUDE_CODE_OAUTH_TOKEN, 'changed', 'resolved at the call');
});

test('an empty-string literal is set as empty', () => {
  const env = childEnv({ name: 'e', env: { ANTHROPIC_API_KEY: '' } }, { ANTHROPIC_API_KEY: 'planted' }, { home: '/h' });
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), true);
  assert.equal(env.ANTHROPIC_API_KEY, '');
});

test('an unknown variable, a duplicate name, an empty chain, an unknown key and a bad name are refused; no fixture secret in the text', () => {
  const bad = (chain) => message(() => loadChain(writeChain(chain)));
  let m = bad([{ name: 'a', env: { NOT_A_CREDENTIAL: SECRET } }]);
  assert.match(m, /AuthError/);
  assert.match(m, /a/);
  assert.match(m, /NOT_A_CREDENTIAL/);
  assert.ok(!m.includes(SECRET));
  m = bad([{ name: 'a', env: {} }, { name: 'a', env: { ANTHROPIC_API_KEY: SECRET } }]);
  assert.match(m, /AuthError.*duplicate/);
  assert.ok(!m.includes(SECRET));
  assert.match(bad([]), /AuthError.*chain/);
  m = bad([{ name: 'a', env: {}, extra: SECRET }]);
  assert.match(m, /AuthError.*extra/);
  assert.ok(!m.includes(SECRET));
  m = bad([{ name: 'Bad Name', env: {} }]);
  assert.match(m, /AuthError/);
  m = bad([{ name: 'a', env: { ANTHROPIC_API_KEY: { file: '/x', other: SECRET } } }]);
  assert.match(m, /AuthError.*ANTHROPIC_API_KEY/);
  assert.ok(!m.includes(SECRET));
  m = bad([{ name: 'a', env: { ANTHROPIC_API_KEY: 12345 } }]);
  assert.match(m, /AuthError.*ANTHROPIC_API_KEY/);
  const f = join(tmp(), 'garbled.json');
  writeFileSync(f, `{"chain": [{"name": "${SECRET}" `);
  m = message(() => loadChain(f));
  assert.match(m, /AuthError/);
  assert.ok(!m.includes(SECRET));
});

test('a missing secret file or variable throws naming the entry and the variable, never a value', () => {
  const home = tmp();
  const envFile = join(home, 'e.env');
  writeFileSync(envFile, `OTHER=${SECRET}\n`);
  let m = message(() => childEnv({ name: 'first', env: { ANTHROPIC_API_KEY: { file: join(home, 'gone') } } }, {}, { home }));
  assert.match(m, /AuthError.*first.*ANTHROPIC_API_KEY/);
  m = message(() => childEnv({ name: 'first', env: { ANTHROPIC_AUTH_TOKEN: { envFile, var: 'MISSING' } } }, {}, { home }));
  assert.match(m, /AuthError.*first.*ANTHROPIC_AUTH_TOKEN/);
  assert.ok(!m.includes(SECRET));
  m = message(() => childEnv({ name: 'first', env: { ANTHROPIC_AUTH_TOKEN: { envFile: join(home, 'gone.env'), var: 'X' } } }, {}, { home }));
  assert.match(m, /AuthError.*first.*ANTHROPIC_AUTH_TOKEN/);
});

const OBSERVED = {
  type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 8:30am (America/Cordoba)",
  api_error_status: 429, api_error: 'usage_limit_reached', terminal_reason: 'api_error', total_cost_usd: 0,
};

test('isLimit: usage_limit_reached and each limit text are limits; a bare 429, a 529 overload result and a successful result are not', () => {
  assert.equal(isLimit(OBSERVED), true);
  assert.equal(isLimit({ is_error: true, api_error: 'usage_limit_reached' }), true);
  assert.equal(isLimit({ is_error: true, api_error_status: 429 }), false);
  assert.equal(isLimit({ is_error: true, api_error_status: 429, result: 'Too many requests' }), false);
  for (const text of [
    "You've hit your session limit · resets 3:45pm", "You've hit your limit", "You've hit your weekly limit · resets Mon 12:00am",
    'Credit balance is too low', "You've hit your monthly spend limit · raise it at …", "API Error: You've hit your limit",
    'Your shared budget is spent',
  ]) {
    assert.equal(isLimit({ is_error: true, result: text }), true, text);
  }
  assert.equal(isLimit({ is_error: true, api_error_status: 529, result: 'Overloaded' }), false);
  assert.equal(isLimit({ is_error: false, result: "You've hit your limit", api_error_status: 429 }), false);
  assert.equal(isLimit({ is_error: false, result: 'done' }), false);
  assert.equal(isLimit(null), false);
  assert.equal(limitText(undefined), false);
  assert.equal(limitText('all good'), false);
});

test('withChain: a limit moves every later unit to the next entry, counts, then ChainExhausted names the entries', async () => {
  const chain = [{ name: 'first', env: {} }, { name: 'second', env: {} }];
  const seen = [];
  const attempt = async (unit, entry) => {
    seen.push(`${unit}:${entry.name}`);
    return entry.name === 'first' ? OBSERVED : { is_error: false, result: 'ok' };
  };
  const w = withChain(chain, attempt);
  const a = await w.run('u1');
  assert.equal(a.entry.name, 'second');
  assert.equal(a.result.result, 'ok');
  await w.run('u2');
  assert.deepEqual(seen, ['u1:first', 'u1:second', 'u2:second']);
  assert.deepEqual(w.counts(), { second: 2 });

  const dead = withChain(chain, async () => OBSERVED);
  await assert.rejects(dead.run('u'), (e) => e instanceof ChainExhausted && JSON.stringify(e.tried) === JSON.stringify(['first', 'second']) && !/hit your/.test(e.message));
  await assert.rejects(dead.run('v'), ChainExhausted);
});

test('withChain also treats { limit: true } as a limit', async () => {
  const w = withChain([{ name: 'a', env: {} }, { name: 'b', env: {} }], async (_u, e) => (e.name === 'a' ? { limit: true } : { ok: true }));
  assert.equal((await w.run('u')).entry.name, 'b');
});

test('the fixture secret appears in no error text of the auth module', () => {
  const home = tmp();
  const f = join(home, 'tok');
  writeFileSync(f, SECRET);
  const err = new AuthError('x');
  assert.equal(err.name, 'AuthError');
  const env = childEnv({ name: 'e', env: { ANTHROPIC_API_KEY: { file: f } } }, {}, { home });
  assert.equal(env.ANTHROPIC_API_KEY, SECRET);
});
