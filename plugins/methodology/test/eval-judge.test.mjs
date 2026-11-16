import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-judge.mjs';
import { loadJudgePrompt, judgeSession, redactSecrets, renderForJudge } from '../cli/lib/eval-judge.mjs';
import { readJsonl } from '../cli/lib/eval-store.mjs';

// Fixture secrets are built at run time so no secret-looking literal sits in the source.
const J = (...p) => p.join('');
const SECRETS = {
  anthropic: J('sk-', 'ant-api03-', 'A1b2C3d4'.repeat(6)),
  openai: J('sk-', 'Zy9Xw8Vu'.repeat(5)),
  githubPat: J('github_', 'pat_', 'a1B2c3D4e5'.repeat(4)),
  ghp: J('gh', 'p_', 'a1B2'.repeat(10)),
  gho: J('gh', 'o_', 'c3D4'.repeat(10)),
  ghu: J('gh', 'u_', 'e5F6'.repeat(10)),
  ghs: J('gh', 's_', 'g7H8'.repeat(10)),
  ghr: J('gh', 'r_', 'i9J0'.repeat(10)),
  aws: J('AK', 'IA', 'QWERTY0123456789'),
  awsSession: J('AS', 'IA', 'ZXCVBN9876543210'),
  google: J('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  slack: J('xo', 'xb-', '1234567890-abcdefghijKLMN'),
  stripeLive: J('sk_', 'live_', 'a1B2c3D4e5F6g7'),
  stripeRestricted: J('rk_', 'live_', 'h8I9j0K1l2M3n4'),
  stripeTest: J('sk_', 'test_', 'o5P6q7R8s9T0u1'),
  vck: J('vc', 'k_', 'a1B2c3D4e5F6g7H8i9'),
  jwt: J('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'),
  privateKey: J('-----BE', 'GIN ', 'RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit\n-----END ', 'RSA PRIVATE KEY-----'),
  urlAuth: J('postgres:', '//', 'admin:', 'Hunter2Hunter2Hunter2', '@db.example.test:5432/app'),
  assignment: J('MY_SERVICE_', 'TOKEN=', 'qwertyuiop1234567890asdf'),
};
const TAILS = {
  anthropic: 'A1b2C3d4A1b2C3d4', openai: 'Zy9Xw8VuZy9Xw8Vu', githubPat: 'a1B2c3D4e5a1B2c3D4e5', ghp: 'a1B2a1B2a1B2', gho: 'c3D4c3D4c3D4',
  ghu: 'e5F6e5F6e5F6', ghs: 'g7H8g7H8g7H8', ghr: 'i9J0i9J0i9J0', aws: 'QWERTY0123456789', awsSession: 'ZXCVBN9876543210',
  google: 'SyA1b2C3d4E5f6G7h8I9j0', slack: '1234567890-abcdefghij', stripeLive: 'a1B2c3D4e5F6g7', stripeRestricted: 'h8I9j0K1l2M3n4',
  stripeTest: 'o5P6q7R8s9T0u1', vck: 'a1B2c3D4e5F6g7H8i9', jwt: 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
  privateKey: 'KUpRKfFLfRYC9AIKjbJTWit', urlAuth: 'Hunter2Hunter2Hunter2', assignment: 'qwertyuiop1234567890asdf',
};

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evjudge-'));
const MODEL = 'claude-opus-5-5';
const writePrompt = (dir, id = 'stalls', model = MODEL) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.md`);
  writeFileSync(f, `---\nmodel: ${model}\n---\nDecide whether the session shows the failure.\n`);
  return f;
};
const turn = (role, text, extra = {}) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: typeof text === 'string' ? text : text }, ...extra });
const textBlock = (text) => [{ type: 'text', text }];
const writeTranscript = (file, lines) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); };

// ---- redactSecrets ----

test('each kind of fixture secret is replaced by [redacted]', () => {
  for (const [kind, secret] of Object.entries(SECRETS)) {
    const { text, count } = redactSecrets(`before ${secret} after`);
    assert.ok(!text.includes(TAILS[kind]), `${kind} still present`);
    assert.ok(text.includes('[redacted]'), `${kind} not marked`);
    assert.ok(text.startsWith('before ') && text.endsWith(' after') || kind === 'assignment' || kind === 'urlAuth' || kind === 'privateKey', kind);
    assert.ok(count >= 1, kind);
  }
  const url = redactSecrets(SECRETS.urlAuth);
  assert.match(url.text, /^postgres:\/\/admin:\[redacted\]@db\.example\.test:5432\/app$/);
  const asg = redactSecrets(SECRETS.assignment);
  assert.equal(asg.text, J('MY_SERVICE_TO', 'KEN=[redacted]'));
  const key = redactSecrets(SECRETS.privateKey);
  assert.equal(key.text, '[redacted]');
});

test('redactSecrets leaves ordinary text and short assignments alone, and counts matches', () => {
  const plain = 'run npm test; PASSWORD=short and token=abc; sk-short';
  assert.deepEqual(redactSecrets(plain), { text: plain, count: 0 });
  const two = redactSecrets(`${SECRETS.ghp} ${SECRETS.aws}`);
  assert.equal(two.count, 2);
  assert.equal(two.text, '[redacted] [redacted]');
});

// ---- renderForJudge ----

test('renderForJudge keeps user and assistant text, tool names and error flags, and drops tool output', () => {
  const f = join(tmp(), 's.jsonl');
  writeTranscript(f, [
    turn('user', 'please fix the build'),
    turn('assistant', [{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Bash', input: { command: 'SECRET-INPUT-SENTINEL' } }]),
    turn('user', [{ type: 'tool_result', is_error: true, content: 'SECRET-OUTPUT-SENTINEL' }]),
    turn('user', [{ type: 'tool_result', content: 'fine' }]),
    turn('assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'done' }]),
    turn('user', 'meta', { isMeta: true }),
  ]);
  const out = renderForJudge(f);
  assert.match(out, /please fix the build/);
  assert.match(out, /on it/);
  assert.match(out, /Bash/);
  assert.match(out, /error/i);
  assert.match(out, /done/);
  assert.ok(!out.includes('SECRET-INPUT-SENTINEL') && !out.includes('SECRET-OUTPUT-SENTINEL') && !out.includes('hidden'));
  assert.ok(!out.includes('meta'));
});

test('a 200,000-char transcript renders to 150,000 chars, head and tail kept', () => {
  const f = join(tmp(), 's.jsonl');
  writeTranscript(f, [turn('user', `HEAD-MARK ${'a'.repeat(100_000)}`), turn('assistant', textBlock(`${'b'.repeat(100_000)} TAIL-MARK`))]);
  const out = renderForJudge(f);
  assert.equal(out.length, 150_000);
  assert.ok(out.includes('HEAD-MARK'));
  assert.ok(out.endsWith('TAIL-MARK'));
});

test('a secret straddling the 75,000-character cut is redacted before the cap, not after', () => {
  const f = join(tmp(), 's.jsonl');
  const key = SECRETS.anthropic;
  // The rendered text is "USER: " + text. The secret starts KEPT characters before the 75,000 cut, so a head that was
  // capped first would keep an 11-character prefix of the key: too short to match any pattern on its own, so only redact-then-cap hides it. Spaces follow the key so the kept tail cannot glue back onto a fragment.
  const kept = 11;
  const pad = 75_000 - 'USER: '.length - kept;
  writeTranscript(f, [turn('user', `${'a'.repeat(pad)}${key}${' '.repeat(150_000)}`)]);
  const out = renderForJudge(f);
  const head = out.slice(0, 75_000);
  assert.ok(!head.includes(key.slice(0, kept)), 'no fragment of the secret is left at the cut');
  assert.ok(head.includes('[redacted]'));
  assert.ok(!out.includes(TAILS.anthropic.slice(0, 8)), 'no part of the secret survives');
});

// ---- loadJudgePrompt ----

test('loadJudgePrompt reads the pinned model and body, the hash is the SHA-256 of the file', () => {
  const f = writePrompt(tmp());
  const p = loadJudgePrompt(f);
  assert.equal(p.model, MODEL);
  assert.equal(p.body.trim(), 'Decide whether the session shows the failure.');
  assert.match(p.hash, /^[0-9a-f]{64}$/);
  assert.equal(p.hash, loadJudgePrompt(f).hash);
});

test('an alias model is rejected', () => {
  for (const alias of ['sonnet', 'opus', 'haiku', 'opus[1m]', 'default']) {
    const f = writePrompt(tmp(), 'x', alias);
    assert.throws(() => loadJudgePrompt(f), /model/);
  }
  const noFront = join(tmp(), 'n.md');
  writeFileSync(noFront, 'no front matter');
  assert.throws(() => loadJudgePrompt(noFront), /model/);
});

// ---- judgeSession ----

const resultJson = (over = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { critique: 'ok', result: 'pass' }, ...over });
const spawnReturning = (stdout, { calls = [], stderr = '' } = {}) => async (bin, args, opts) => { calls.push({ bin, args, opts }); return { code: 0, stdout, stderr }; };
function sessionFile(lines = [turn('user', 'hello'), turn('assistant', textBlock('hi'))]) {
  const f = join(tmp(), 's.jsonl');
  writeTranscript(f, lines);
  return f;
}
const base = (over = {}) => ({ category: 'stalls', prompt: { model: MODEL, body: 'JUDGE-BODY', hash: 'h' }, session: sessionFile(), env: { PATH: '/bin' }, cwd: '/judge-cwd', bin: 'claude', ...over });

test('the judge argv carries --setting-sources project, --strict-mcp-config and --tools "" and the stdin is prompt plus transcript', async () => {
  const calls = [];
  const out = await judgeSession({ ...base(), spawn: spawnReturning(resultJson(), { calls }) });
  assert.deepEqual(out, { result: 'pass', reason: 'ok' });
  const { args, opts, bin } = calls[0];
  assert.equal(bin, 'claude');
  const i = (flag) => args.indexOf(flag);
  assert.deepEqual(args.slice(0, 1), ['-p']);
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[i('--model') + 1], MODEL);
  assert.equal(args[i('--output-format') + 1], 'json');
  assert.equal(args[i('--setting-sources') + 1], 'project');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[i('--tools') + 1], '');
  const schema = JSON.parse(args[i('--json-schema') + 1]);
  assert.deepEqual(schema.required.sort(), ['critique', 'result']);
  assert.deepEqual(schema.properties.result.enum, ['pass', 'fail']);
  assert.equal(opts.cwd, '/judge-cwd');
  assert.match(opts.input, /JUDGE-BODY/);
  assert.match(opts.input, /hello/);
});

test('the spawned env has no TRIQUAL_EVAL_ARM: the caller env is passed as given, the CLI strips it', async () => {
  const dir = tmp();
  const evals = join(dir, 'evals');
  const e = fixture({ dir });
  e.env.TRIQUAL_EVAL_ARM = 'arm-a';
  e.env.ANTHROPIC_API_KEY = 'planted';
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  const log = readJsonl(e.log).rows;
  assert.ok(log.length > 0);
  for (const l of log) {
    assert.equal(l.hasArm, false);
    assert.equal(l.hasKeyVar, false);
  }
  assert.ok(evals);
});

test('judgeSession: unparseable stdout is an error, a completed run without a valid structured_output is undecided', async () => {
  assert.deepEqual(await judgeSession({ ...base(), spawn: spawnReturning('not json at all') }), { error: 'unparseable output' });
  assert.equal((await judgeSession({ ...base(), spawn: spawnReturning(resultJson({ structured_output: undefined })) })).result, 'undecided');
  assert.equal((await judgeSession({ ...base(), spawn: spawnReturning(resultJson({ structured_output: { critique: 'x', result: 'maybe' } })) })).result, 'undecided');
  assert.equal((await judgeSession({ ...base(), spawn: spawnReturning(resultJson({ structured_output: { critique: 'x' } })) })).result, 'undecided');
});

test('judgeSession: limit and error outcomes; a warning on stderr does not break parsing', async () => {
  const limit = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 8:30am", api_error_status: 429, api_error: 'usage_limit_reached' });
  assert.deepEqual(await judgeSession({ ...base(), spawn: spawnReturning(limit) }), { limit: true });
  const err = JSON.stringify({ type: 'result', is_error: true, result: `Overloaded ${'z'.repeat(400)}`, api_error_status: 529 });
  const out = await judgeSession({ ...base(), spawn: spawnReturning(err) });
  assert.equal(out.error.length, 200);
  assert.deepEqual(await judgeSession({ ...base(), spawn: spawnReturning(resultJson({ structured_output: { critique: 'c', result: 'fail' } }), { stderr: 'connectors warning: something' }) }), { result: 'fail', reason: 'c' });
  // an array of messages (verbose) is read for its result object
  const arr = JSON.stringify([{ type: 'system' }, JSON.parse(resultJson())]);
  assert.equal((await judgeSession({ ...base(), spawn: spawnReturning(arr) })).result, 'pass');
});

// ---- the CLI, with a fake claude binary ----

const FAKE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const e = process.env;
  appendFileSync(e.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, hasArm: 'TRIQUAL_EVAL_ARM' in e, hasKeyVar: 'ANTHROPIC_API_KEY' in e, oauth: e.CLAUDE_CODE_OAUTH_TOKEN ?? null }) + '\\n');
  const mode = e.FAKE_MODE || 'pass';
  const limit = { type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit · resets 8:30am (America/Cordoba)", api_error_status: 429, api_error: 'usage_limit_reached', terminal_reason: 'api_error', total_cost_usd: 0 };
  const ok = (r) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: { critique: 'c', result: r } });
  if (e.FAKE_WARN) process.stderr.write('connectors warning: ' + e.FAKE_WARN + '\\n');
  let out; let code = 0;
  if (mode === 'limit-first' && e.CLAUDE_CODE_OAUTH_TOKEN === e.FAKE_FIRST) { out = limit; code = 1; }
  else if (mode === 'limit-all') { out = limit; code = 1; }
  else if (mode === 'error') { out = { type: 'result', is_error: true, result: 'Overloaded', api_error_status: 529 }; code = 1; }
  else if (mode === 'garbage') out = 'not json';
  else if (mode === 'nostruct') out = { type: 'result', is_error: false, result: 'text only' };
  else out = ok(stdin.includes('MARK-FAIL') ? 'fail' : 'pass');
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  process.exitCode = code;
});
`;

// A full evals fixture: transcripts, sessions store, taxonomy, judge prompt, fake claude, session list.
function fixture({ dir = tmp(), exclude = [], sessions = ['s1', 's2'], projects = {}, chain, mode } = {}) {
  const evals = join(dir, 'evals');
  const root = join(dir, 'projects');
  const home = join(dir, 'home');
  const judges = join(dir, 'judges');
  mkdirSync(home, { recursive: true });
  mkdirSync(evals, { recursive: true });
  const stored = [];
  for (const id of sessions) {
    const project = projects[id] ?? '/home/x/proj';
    const projectDir = '-home-x-proj';
    writeTranscript(join(root, projectDir, `${id}.jsonl`), [turn('user', `task of ${id}${id === 's2' ? ' MARK-FAIL' : ''}`), turn('assistant', textBlock('working'))]);
    stored.push(JSON.stringify({ sessionId: id, project, projectDir }));
  }
  writeFileSync(join(evals, 'sessions.jsonl'), `${stored.join('\n')}\n`);
  writeFileSync(join(evals, 'label-categories.jsonl'), ['a', 'b', 'c'].map((id) => JSON.stringify({ sessionId: id, categories: ['stalls'] })).join('\n'));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify({
    judgeExclude: exclude,
    categories: [
      { id: 'stalls', name: 'Stalls', definition: 'd', examples: ['a', 'b', 'c'], check: 'judge' },
      { id: 'loops', name: 'Loops', definition: 'd', examples: ['a', 'b', 'c'], check: 'code' },
    ],
  }));
  writePrompt(judges);
  const bin = join(dir, 'claude');
  writeFileSync(bin, FAKE.replace("require('node:fs')", "require('node:fs')"));
  chmodSync(bin, 0o755);
  const log = join(dir, 'calls.jsonl');
  const sessionsFile = join(dir, 'ids.jsonl');
  writeFileSync(sessionsFile, `${sessions.map((id) => JSON.stringify({ sessionId: id })).join('\n')}\n`);
  const env = {
    HOME: home, PATH: process.env.PATH, TRIQUAL_EVALS_DIR: evals, TRIQUAL_TRANSCRIPTS_DIR: root,
    TRIQUAL_CLAUDE_BIN: bin, FAKE_LOG: log, TRIQUAL_EVAL_AUTH_FILE: join(dir, 'eval-auth.json'),
  };
  if (mode) env.FAKE_MODE = mode;
  if (chain) writeFileSync(env.TRIQUAL_EVAL_AUTH_FILE, JSON.stringify({ chain }));
  return { dir, evals, env, judges, log, sessionsFile, judgments: join(evals, 'judgments', 'stalls.jsonl') };
}
async function run(e, argv) {
  let out = '';
  let err = '';
  const code = await main(argv, { env: e.env, judgesDir: e.judges, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, platform: 'linux' });
  return { code, out, err, lines: out.trim().split('\n') };
}
const calls = (e) => readJsonl(e.log).rows;
const lines = (e) => readJsonl(e.judgments).rows;

test('pass and fail are recorded once per prompt hash', async () => {
  const e = fixture();
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.at(-1), 'judged 2: ambient 2; errors 0; left 0');
  const rows = lines(e);
  assert.deepEqual(rows.map((x) => [x.sessionId, x.result]), [['s1', 'pass'], ['s2', 'fail']]);
  const hash = loadJudgePrompt(join(e.judges, 'stalls.md')).hash;
  for (const x of rows) {
    assert.equal(x.category, 'stalls');
    assert.equal(x.promptHash, hash);
    assert.equal(x.model, MODEL);
    assert.equal(x.auth, 'ambient');
    assert.match(x.at, /^\d{4}-\d{2}-\d{2}T/);
  }
  const r2 = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.lines.at(-1), 'judged 0: none; errors 0; left 0');
  assert.equal(lines(e).length, 2);
  assert.equal(calls(e).length, 2);
  // a changed prompt is a new hash: judged again
  writeFileSync(join(e.judges, 'stalls.md'), `---\nmodel: ${MODEL}\n---\nAnother wording.\n`);
  await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(lines(e).length, 4);
});

test('the taxonomy is read from <evals>/taxonomy.json, not from the config dir', async () => {
  const e = fixture();
  // a decoy under the temp HOME's config dir that would make the category a code check if it were read
  const decoyDir = join(e.env.HOME, '.config', 'triqual');
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(join(decoyDir, 'taxonomy.json'), JSON.stringify({
    judgeExclude: [],
    categories: [{ id: 'stalls', name: 'Stalls', definition: 'd', examples: ['a', 'b', 'c'], check: 'code' }],
  }));
  assert.ok(!('TRIQUAL_TAXONOMY_FILE' in e.env));
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.at(-1), 'judged 2: ambient 2; errors 0; left 0');
});

test('the judge runs in an empty directory under the evals dir with the lean flags', async () => {
  const e = fixture();
  await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  const c = calls(e)[0];
  assert.equal(realpathSync(c.cwd), realpathSync(join(e.evals, 'judge-cwd')));
  assert.ok(c.argv.includes('--strict-mcp-config'));
  assert.equal(c.argv[c.argv.indexOf('--setting-sources') + 1], 'project');
  assert.equal(c.argv[c.argv.indexOf('--tools') + 1], '');
});

test('a session under a judgeExclude pattern is never passed to a judge', async () => {
  const e = fixture({ exclude: ['/home/x/Client'], projects: { s1: '/home/x/Client/app', s2: '/home/x/proj' } });
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(calls(e).length, 1, 'only the non-excluded session was spawned');
  assert.ok(!calls(e)[0].stdin.includes('task of s1'));
  const [a, b] = lines(e);
  assert.equal(a.sessionId, 's1');
  assert.equal(a.result, 'undecided');
  assert.equal(a.reason, 'excluded');
  assert.equal(Object.hasOwn(a, 'auth'), false);
  assert.equal(b.sessionId, 's2');
  assert.equal(r.lines.at(-1), 'judged 1: ambient 1; errors 0; left 0');
});

test('an unknown project counts as excluded when a pattern is set; a session missing from the store is not spawned, gets no line and is an error', async () => {
  const e = fixture({ exclude: ['/home/x/Client'], sessions: ['s1'], projects: { s1: '' } });
  writeFileSync(e.sessionsFile, `${JSON.stringify({ sessionId: 's1' })}\n${JSON.stringify({ sessionId: 'ghost' })}\n`);
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(calls(e).length, 0);
  assert.deepEqual(lines(e).map((x) => [x.sessionId, x.reason]), [['s1', 'excluded']]);
  assert.match(r.err, /ghost: not in the sessions store/);
  assert.equal(r.code, 1);
});

test('an unreadable or empty transcript is an error: no spawn, no judgment line, counted in errors and left', async () => {
  const e = fixture({ sessions: ['s1', 's2', 's3'] });
  const dir = join(e.env.TRIQUAL_TRANSCRIPTS_DIR, '-home-x-proj');
  rmSync(join(dir, 's1.jsonl'));
  writeFileSync(join(dir, 's2.jsonl'), '');
  writeTranscript(join(dir, 's3.jsonl'), [turn('user', 'task of s3'), turn('assistant', textBlock('working'))]);
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 1);
  assert.equal(calls(e).length, 1, 'only the readable session was spawned');
  assert.deepEqual(lines(e).map((x) => x.sessionId), ['s3']);
  assert.equal(r.lines.at(-1), 'judged 1: ambient 1; errors 2; left 2');
  assert.match(r.err, /s1: .*transcript/);
  assert.match(r.err, /s2: .*transcript/);
  // once the transcript exists, the next run judges it
  writeTranscript(join(dir, 's1.jsonl'), [turn('user', 'task of s1'), turn('assistant', textBlock('working'))]);
  const r2 = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r2.lines.at(-1), 'judged 1: ambient 1; errors 1; left 1');
});

test('with the default empty judgeExclude the same session is judged', async () => {
  const e = fixture({ projects: { s1: '/home/x/Client/app' } });
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(calls(e).length, 2);
  assert.equal(lines(e).filter((x) => x.reason === 'excluded').length, 0);
});

test('each kind of fixture secret is absent from the judge stdin and [redacted] is present', async () => {
  const e = fixture({ sessions: ['s1'] });
  const all = Object.values(SECRETS).join('\n');
  writeTranscript(join(e.env.TRIQUAL_TRANSCRIPTS_DIR, '-home-x-proj', 's1.jsonl'), [turn('user', `here:\n${all}\nend`), turn('assistant', textBlock('ok'))]);
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  const stdin = calls(e)[0].stdin;
  for (const [kind, tail] of Object.entries(TAILS)) assert.ok(!stdin.includes(tail), `${kind} reached the judge`);
  assert.ok(stdin.includes('[redacted]'));
  // and nowhere in the CLI output or the judgment lines
  const everything = r.out + r.err + readFileSync(e.judgments, 'utf8');
  for (const [kind, tail] of Object.entries(TAILS)) assert.ok(!everything.includes(tail), `${kind} leaked`);
});

test('unparseable judge output writes no line (an error); a result with no structured output is undecided', async () => {
  const e = fixture({ sessions: ['s1'], mode: 'garbage' });
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 1);
  assert.equal(lines(e).length, 0);
  assert.equal(r.lines.at(-1), 'judged 0: none; errors 1; left 1');
  const e2 = fixture({ sessions: ['s1'], mode: 'nostruct' });
  const r2 = await run(e2, ['--category', 'stalls', '--sessions', e2.sessionsFile]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(lines(e2)[0].result, 'undecided');
});

test('a limit result moves to the next entry: every session is judged on the second entry and no line is written for the limited attempt', async () => {
  const first = J('first-', 'fixture-', 'value');
  const second = J('second-', 'fixture-', 'value');
  const e = fixture({ chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: first } }, { name: 'two', env: { CLAUDE_CODE_OAUTH_TOKEN: second } }], mode: 'limit-first' });
  e.env.FAKE_FIRST = first;
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.lines.at(-1), 'judged 2: two 2; errors 0; left 0');
  assert.deepEqual(lines(e).map((x) => x.auth), ['two', 'two']);
  assert.deepEqual(calls(e).map((c) => c.oauth), [first, second, second], 'the first entry was tried once, then never again');
  const everything = r.out + r.err + readFileSync(e.judgments, 'utf8');
  assert.ok(!everything.includes(first) && !everything.includes(second));
});

test('every entry limited: exit 1, no line, stderr names the entries and no secret', async () => {
  const first = J('first-', 'fixture-', 'value');
  const second = J('second-', 'fixture-', 'value');
  const e = fixture({ chain: [{ name: 'one', env: { CLAUDE_CODE_OAUTH_TOKEN: first } }, { name: 'two', env: { ANTHROPIC_API_KEY: second } }], mode: 'limit-all' });
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 1);
  assert.equal(lines(e).length, 0);
  assert.match(r.err, /one/);
  assert.match(r.err, /two/);
  assert.ok(!(r.out + r.err).includes(first) && !(r.out + r.err).includes(second));
  assert.equal(r.lines.at(-1), 'judged 0: none; errors 0; left 2');
});

test('an API error result writes no line and exits 1; a later run judges the session', async () => {
  const e = fixture({ sessions: ['s1'], mode: 'error' });
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 1);
  assert.equal(lines(e).length, 0);
  assert.equal(r.lines.at(-1), 'judged 0: none; errors 1; left 1');
  delete e.env.FAKE_MODE;
  const r2 = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(lines(e).length, 1);
});

test('a warning on stderr does not break parsing', async () => {
  const e = fixture({ sessions: ['s1'] });
  e.env.FAKE_WARN = 'x';
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(lines(e)[0].result, 'pass');
});

test('the sessions file may hold one id per line', async () => {
  const e = fixture();
  writeFileSync(e.sessionsFile, 's1\n\ns2\ns1\n');
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 0, r.err);
  assert.equal(lines(e).length, 2);
});

test('a code category and an unknown category exit 2; missing flags exit 2; --help prints usage', async () => {
  const e = fixture();
  let r = await run(e, ['--category', 'loops', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 2);
  assert.equal(calls(e).length, 0);
  r = await run(e, ['--category', 'nope', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 2);
  r = await run(e, ['--category', 'stalls']);
  assert.equal(r.code, 2);
  r = await run(e, ['--bogus']);
  assert.equal(r.code, 2);
  r = await run(e, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage/);
});

test('an unreadable credential file stops the run, naming the entry and the variable, no value', async () => {
  const e = fixture({ chain: [{ name: 'one', env: { ANTHROPIC_API_KEY: { file: '/nonexistent-dir/none' } } }] });
  const r = await run(e, ['--category', 'stalls', '--sessions', e.sessionsFile]);
  assert.equal(r.code, 1);
  assert.match(r.err, /one/);
  assert.match(r.err, /ANTHROPIC_API_KEY/);
  assert.equal(lines(e).length, 0);
});

test('the dispatcher lists judge', async () => {
  const { main: dispatch } = await import('../cli/eval.mjs');
  let out = '';
  assert.equal(await dispatch([], { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } }), 0);
  assert.match(out, /^ {2}judge /m);
  rmSync(tmp(), { recursive: true, force: true });
});

test('redactSecrets stays linear on adversarial input', () => {
  const start = Date.now();
  for (const s of ['a.'.repeat(100_000), 'TOKEN'.repeat(30_000), 'a:'.concat('//b:').repeat(30_000), `${J('TO', 'KEN=')}${'x'.repeat(100_000)}`]) redactSecrets(s);
  assert.ok(Date.now() - start < 3000, `took ${Date.now() - start} ms`);
});
