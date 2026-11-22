import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-replay.mjs';
import { main as evalMain } from '../cli/eval.mjs';

const SENTINEL_PROMPT_TEXT = 'zz-replay-prompt-sentinel';
const ROLE = 'tdd-implementer';

let base;
let env;

// One main transcript with one dispatch of the role and no subagent transcript: harvest finds it and excludes it, so the
// command runs without any git or test command. NODE_TEST_CONTEXT is dropped from the env (a nested `node --test` under
// it would exit 0 without running anything).
before(() => {
  base = mkdtempSync(join(tmpdir(), 'cm-replay-cli-'));
  const root = join(base, 'projects');
  mkdirSync(join(root, 'proj'), { recursive: true });
  const line = {
    type: 'assistant',
    timestamp: '2026-11-20T10:00:00Z',
    cwd: join(base, 'work'),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_X', name: 'Agent', input: { subagent_type: `roles:${ROLE}`, description: 'Task 1: x', prompt: SENTINEL_PROMPT_TEXT } }],
    },
  };
  writeFileSync(join(root, 'proj', 'sess.jsonl'), `${JSON.stringify(line)}\n`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
  env = {
    ...inherited,
    HOME: join(base, 'home'),
    XDG_CONFIG_HOME: join(base, 'config'),
    TRIQUAL_TRANSCRIPTS_DIR: root,
    TRIQUAL_EVALS_DIR: join(base, 'evals'),
    ROLE_EVAL_FILE: join(base, 'none.jsonl'),
  };
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

async function run(argv, over = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, { env: { ...env, ...over }, cwd: base, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

async function evalHelp() {
  let out = '';
  await evalMain([], { env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  return out;
}

test('eval lists replay', async () => { assert.match(await evalHelp(), /^\s+replay\s+\S/m); });

test('harvest prints counts only', async () => {
  const r = await run(['harvest', '--role', ROLE, '--since', '2026-11-19']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^tdd-implementer: dispatches \d+, cases kept \d+/);
  assert.equal(r.out, 'tdd-implementer: dispatches 1, cases kept 0; excluded no-subagent-transcript 1\n');
  assert.ok(!r.out.includes(SENTINEL_PROMPT_TEXT));
  assert.ok(!r.err.includes(SENTINEL_PROMPT_TEXT));
});

test('harvest --json', async () => {
  const j = JSON.parse((await run(['harvest', '--role', ROLE, '--since', '2026-11-19', '--json'])).out);
  assert.deepEqual(Object.keys(j), ['role', 'found', 'kept', 'excluded']);
  assert.equal(j.found, 1);
  assert.equal(j.excluded['no-subagent-transcript'], 1);
});

test('--since after the dispatch finds nothing', async () => {
  const r = await run(['harvest', '--role', ROLE, '--since', '2026-11-21T00:00:00Z']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'tdd-implementer: dispatches 0, cases kept 0\n');
});

test('a bad --since is a usage error', async () => {
  const r = await run(['harvest', '--role', ROLE, '--since', 'not-a-date']);
  assert.equal(r.code, 2);
  assert.ok(!r.out);
});

test('an unknown role is a usage error', async () => {
  assert.equal((await run(['harvest', '--role', 'spec-reviewer'])).code, 2);
  assert.equal((await run(['harvest'])).code, 2);
});

test('an invalid replay-repos file is a usage error', async () => {
  mkdirSync(join(base, 'config', 'triqual'), { recursive: true });
  writeFileSync(join(base, 'config', 'triqual', 'replay-repos.json'), '{ not json');
  try {
    const r = await run(['harvest', '--role', ROLE, '--since', '2026-11-19']);
    assert.equal(r.code, 2);
    assert.match(r.err, /replay-repos file/);
  } finally {
    rmSync(join(base, 'config'), { recursive: true, force: true });
  }
});

test('no action or an unknown action prints usage and exits 2', async () => {
  for (const argv of [[], ['run'], ['harvest', '--bogus']]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /usage:/);
  }
});

test('--help documents harvest', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /harvest --role <R> \[--since <ISO/);
  assert.match(r.out, /validation-failed/);
});
