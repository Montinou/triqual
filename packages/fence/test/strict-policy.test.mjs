// The shipped policies (policies/strict.json and policies/example.json): both validate, every
// example in them passes `fence test`, strict denies the base command of each jev category and
// leaves ordinary development commands to the host.
//
// Every command string here is analysed by the engine, never executed, and is a minimal benign
// form. The runs are hermetic: a temp home, a temp repository on an unprotected branch and a temp
// state and admin directory; nothing reads the real home or any real fence state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCheck, runTest } from '../src/cli/check.mjs';
import { runEngine } from '../src/engine.mjs';

const POLICIES = fileURLToPath(new URL('../policies/', import.meta.url));
const STRICT = path.join(POLICIES, 'strict.json');
const EXAMPLE = path.join(POLICIES, 'example.json');
const BOTH = [
  ['strict', STRICT],
  ['example', EXAMPLE],
];

let tmp;
let home;
let repo;
let aux;

before(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-strict-')));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  aux = path.join(tmp, 'aux');
  for (const d of [home, repo, aux]) fs.mkdirSync(d, { recursive: true });
  // A repository on a branch no policy protects, written by hand (no git process runs).
  const git = path.join(repo, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/work\n');
  fs.writeFileSync(path.join(git, 'config'), '[core]\n\tbare = false\n');
  fs.writeFileSync(path.join(git, 'refs', 'heads', 'work'), `${'0'.repeat(40)}\n`);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sink() {
  const out = [];
  const err = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err, text: () => [...out, ...err].join('\n') };
}

// runCheck has no home argument and falls back to os.homedir(), which reads HOME (USERPROFILE on
// Windows); pin both to the temp home while `fn` runs so `~/` globs never resolve against the real one.
function withTempHome(fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The engine decision for a Claude Bash command run in the temp repo under `policy`.
function decide(policy, command) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd: repo,
    session_id: 'strict-policy-test',
    permission_mode: 'default',
  };
  const env = { ...process.env, HOME: home };
  delete env.FENCE_PROFILE;
  const argv = ['pre', '--host', 'claude', '--policy', policy, '--state-dir', path.join(aux, 'state'), '--admin-dir', path.join(aux, 'admin')];
  const r = runEngine(argv, { stdin: JSON.stringify(payload), env });
  return JSON.parse(r.stdout);
}

test('both policies validate', () => {
  for (const [name, file] of BOTH) {
    const s = sink();
    const code = withTempHome(() => runCheck(['--policy', file], s.io));
    assert.equal(code, 0, `${name}: ${s.text()}`);
    assert.match(s.out.join('\n'), /is valid/, name);
    // the policies add no allow rule, so check has nothing to warn about
    assert.deepEqual(s.err, [], `${name} warned: ${s.err.join('\n')}`);
  }
  // every rule says why and carries examples of both kinds the rule can be tested with
  for (const [name, file] of BOTH) {
    const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(policy.rules.length > 0, name);
    for (const rule of policy.rules) {
      assert.ok(typeof rule.why === 'string' && rule.why.trim() !== '', `${name}/${rule.id} has no why`);
      assert.ok(rule.examples?.deny?.length > 0, `${name}/${rule.id} has no deny example`);
      assert.ok(rule.examples?.allow?.length > 0, `${name}/${rule.id} has no allow example`);
    }
  }
});

test('every example in both policies passes fence test', () => {
  for (const [name, file] of BOTH) {
    const s = sink();
    const code = withTempHome(() => runTest(['--policy', file], s.io, { home }));
    assert.equal(code, 0, `${name}: ${s.text()}`);
    // the policy examples' summary; the built-in table's own summary follows it
    const summary = s.out.find((l) => /^\d+ passed, \d+ failed, \d+ skipped$/.test(l));
    assert.match(summary, /^\d+ passed, 0 failed, 0 skipped$/, `${name}: ${summary}`);
    assert.ok(Number.parseInt(summary, 10) > 0, name);
  }
});

// The base command of each jev category, in the minimal benign form, with the rule that denies it.
const JEV_BASE = [
  ['delete', 'rm ../notes.txt', 'delete-outside-repo'],
  ['overwrite', 'cp a.txt ../b.txt', 'write-outside-repo'],
  ['overwrite (class)', 'truncate -s 0 ../notes.txt', 'overwrite-outside-repo'],
  ['credentials', 'cat ~/.aws/credentials', 'credentials'],
  ['env-dump', 'printenv', 'env-dump'],
  ['network-fetch', 'curl https://example.com', 'network-fetch'],
  ['privilege', 'sudo ls', 'privilege'],
  ['perm-change', 'chmod 644 ../notes.txt', 'perm-change'],
  ['vcs-write', 'git push --force origin main', 'vcs-write'],
];

test('strict denies each jev category base command', () => {
  for (const [category, command, rule] of JEV_BASE) {
    const d = decide(STRICT, command);
    assert.equal(d.decision, 'deny', `${category}: ${command} -> ${JSON.stringify(d)}`);
    assert.ok(typeof d.reason === 'string' && d.reason !== '', category);
    assert.equal(d.rule, rule, `${category}: ${command}`);
  }
});

test('strict allows git status, ls and npm test', () => {
  for (const command of ['git status', 'ls', 'npm test']) {
    const d = decide(STRICT, command);
    assert.notEqual(d.decision, 'deny', `${command} -> ${JSON.stringify(d)}`);
  }
});

test('strict leaves work inside the repository and the example credentials files alone', () => {
  for (const command of ['rm notes.txt', 'cp a.txt b.txt', 'cat .env.example', 'cat .env.sample']) {
    const d = decide(STRICT, command);
    assert.notEqual(d.decision, 'deny', `${command} -> ${JSON.stringify(d)}`);
  }
  const env = decide(STRICT, 'cat .env');
  assert.equal(env.decision, 'deny');
  assert.equal(env.rule, 'credentials');
});

test('the default example policy keeps its credentials and privilege rules', () => {
  assert.equal(decide(EXAMPLE, 'cat ~/.aws/credentials').rule, 'credentials');
  assert.equal(decide(EXAMPLE, 'cat .env.example').decision === 'deny', false);
  assert.equal(decide(EXAMPLE, 'sudo ls').rule, 'privilege');
  assert.notEqual(decide(EXAMPLE, 'git status').decision, 'deny');
  const ids = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')).rules.map((r) => r.id);
  assert.deepEqual(ids, ['credentials', 'privilege']);
});
