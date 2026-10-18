import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEngine } from '../src/engine.mjs';
import { KEEP_CAP, KEEP_DIR, keepFileName, readKeepSnapshot, renderKeepList } from '../src/hooks/keeplist.mjs';
import { loadPolicy } from '../src/policy/load.mjs';
import { validatePolicy } from '../src/policy/schema.mjs';

// Hermetic: one realpath'd temp root; the engine runs in-process with an explicit policy and state
// directory, so nothing outside the temp root is read or written.
const TMP = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'fence-keeplist-')));
after(() => nodeFs.rmSync(TMP, { recursive: true, force: true }));

const EXAMPLE = fileURLToPath(new URL('../policies/example.json', import.meta.url));
const exampleText = nodeFs.readFileSync(EXAMPLE, 'utf8');
const examplePolicy = () => validatePolicy(JSON.parse(exampleText));

let counter = 0;
function freshDirs(policyText = exampleText) {
  const base = path.join(TMP, `run${counter++}`);
  nodeFs.mkdirSync(base);
  const policy = path.join(base, 'policy.json');
  nodeFs.writeFileSync(policy, policyText);
  const state = path.join(base, 'state');
  nodeFs.mkdirSync(state);
  return { policy, state };
}

function precompact(d, payload, { env = {}, fs } = {}) {
  const argv = ['precompact', '--host', 'claude', '--policy', d.policy, '--state-dir', d.state];
  const stdin = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = runEngine(argv, { stdin, now: Date.parse('2026-10-18T00:00:00Z'), env, ...(fs ? { fs } : {}) });
  assert.equal(r.exit, 0);
  return JSON.parse(r.stdout);
}

const payloadFor = (session_id) => ({ hook_event_name: 'PreCompact', session_id, cwd: TMP, trigger: 'auto' });

function smallPolicy(rules, extra = {}) {
  return validatePolicy({ version: 1, rules, ...extra });
}

test('contains each rule\'s id and why', () => {
  const policy = smallPolicy([
    { id: 'no-curl', decision: 'deny', match: { class: ['network-fetch'] }, why: 'Fetching from the network is denied.' },
    { id: 'no-sudo', decision: 'deny', match: { class: ['privilege'] }, why: 'Raising privileges is denied.' },
    { id: 'no-mcp', decision: 'deny', match: { mcp: ['server__tool'] }, why: 'That MCP tool is off limits.' },
  ]);
  const text = renderKeepList(policy, { profile: 'default' });
  for (const rule of policy.rules) {
    assert.ok(text.includes(rule.id), `${rule.id} missing from:\n${text}`);
    assert.ok(text.includes(rule.why), `why of ${rule.id} missing from:\n${text}`);
  }
  // one line per rule: each id starts its own line
  for (const rule of policy.rules) assert.ok(text.split('\n').some((l) => l.startsWith(`${rule.id}:`)), rule.id);
});

test('contains the credentials rule text including its excepts', () => {
  const text = renderKeepList(examplePolicy(), { profile: 'default' });
  const line = text.split('\n').find((l) => l.startsWith('credentials:'));
  assert.ok(line, text);
  assert.match(line, /deny/);
  assert.ok(line.includes('~/.aws/**'), line);
  assert.ok(line.includes('**/.env.example'), line);
  assert.ok(line.includes('**/.env.sample'), line);
  assert.ok(line.includes('Credential files are never read or written by the agent.'), line);
});

test('the credentials rule shows the expanded home form the engine loads', () => {
  const home = path.join(TMP, 'fake-home');
  const policy = loadPolicy(EXAMPLE, { home }).policy;
  const text = renderKeepList(policy, { profile: 'default' });
  const line = text.split('\n').find((l) => l.startsWith('credentials:'));
  assert.ok(line, text);
  assert.ok(line.includes(`${home}/.aws/**`), line);
  assert.ok(!line.includes('~/.aws/**'), line);
  assert.ok(line.includes('**/.env.example'), line);
});

test('names the protected branches, denyFileWrites, the profile and one built-ins line', () => {
  const policy = smallPolicy(
    [{ id: 'r1', decision: 'deny', match: { class: ['privilege'] }, why: 'No.' }],
    {
      branches: { protected: ['main', 'release'], denyFileWrites: true },
      profiles: { unattended: { undecided: 'deny' } },
    },
  );
  const text = renderKeepList(policy, { profile: 'unattended' });
  assert.match(text, /protected branches: main, release/);
  assert.match(text, /denyFileWrites: true/);
  assert.match(text, /profile unattended/);
  assert.match(text, /undecided: deny/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('built-ins:')).length, 1, text);
  const dflt = renderKeepList(smallPolicy([{ id: 'r1', decision: 'deny', match: { class: ['privilege'] }, why: 'No.' }]), {});
  assert.match(dflt, /profile default/);
  assert.match(dflt, /denyFileWrites: false/);
});

function manyRules(n, { id = (i) => `r${String(i).padStart(2, '0')}`, why = (i) => `Reason number ${i} `.repeat(6 + (i % 7)) } = {}) {
  return smallPolicy(
    Array.from({ length: n }, (_, i) => ({
      id: id(i),
      decision: 'deny',
      match: { paths: [`**/dir-${i}/**`, `~/.config/tool-${i}/**`], access: 'write' },
      why: why(i),
    })),
  );
}

test('stays within 2000 characters for 80 rules', () => {
  const policy = manyRules(80);
  const text = renderKeepList(policy, { profile: 'default' });
  assert.ok(text.length <= KEEP_CAP, `length ${text.length}`);
  assert.equal(KEEP_CAP, 2000);
  for (const rule of policy.rules) assert.ok(text.includes(rule.id), `${rule.id} dropped`);
});

test('keeps every id even when the ids alone nearly fill the budget', () => {
  const policy = manyRules(80, { id: (i) => `rule-identifier-${String(i).padStart(2, '0')}` });
  const text = renderKeepList(policy, { profile: 'default' });
  assert.ok(text.length <= KEEP_CAP, `length ${text.length}`);
  for (const rule of policy.rules) assert.ok(text.includes(rule.id), `${rule.id} dropped`);
});

test('60 rules with long ids keep the branches and built-ins lines and end with a count line', () => {
  const id = (i) => `rule-${String(i).padStart(2, '0')}-${'x'.repeat(26)}`;
  assert.equal(id(0).length, 34);
  const policy = smallPolicy(
    Array.from({ length: 60 }, (_, i) => ({
      id: id(i),
      decision: 'deny',
      match: { class: ['privilege'] },
      why: `Reason ${i}.`,
    })),
    { branches: { protected: ['main', 'release'], denyFileWrites: true } },
  );
  const text = renderKeepList(policy, { profile: 'default' });
  assert.ok(text.length <= KEEP_CAP, `length ${text.length}`);
  const lines = text.split('\n');
  assert.ok(lines.some((l) => l === 'protected branches: main, release; denyFileWrites: true'), text);
  assert.equal(lines.filter((l) => l.startsWith('built-ins:')).length, 1, text);
  assert.ok(lines[0].startsWith('fence policy, profile default'), lines[0]);
  const last = lines[lines.length - 1];
  const m = /^… and (\d+) more rules \(run fence check to list them\)$/.exec(last);
  assert.ok(m, `last line: ${last}`);
  const n = Number(m[1]);
  assert.ok(n > 0 && n < 60, last);
  // the rules that fit are the first ones in policy order, whole; the count names exactly the rest
  const ruleLines = lines.filter((l) => l.startsWith('rule-'));
  assert.equal(ruleLines.length, 60 - n, text);
  ruleLines.forEach((l, i) => assert.equal(l, `${id(i)}: deny`));
});

test('a very long profile name is capped to one line of 64 characters in the head', () => {
  const policy = smallPolicy([{ id: 'r1', decision: 'deny', match: { class: ['privilege'] }, why: 'No.' }]);
  const profile = `${'p'.repeat(500)}\n${'q'.repeat(500)}`;
  const text = renderKeepList(policy, { profile });
  assert.ok(text.length <= KEEP_CAP, `length ${text.length}`);
  const head = text.split('\n')[0];
  assert.ok(head.startsWith('fence policy, profile '), head);
  const name = /^fence policy, profile (.*) \(not defined by this policy\)$/.exec(head);
  assert.ok(name, head);
  assert.equal(name[1].length, 64);
  assert.ok(name[1].endsWith('…'));
  assert.ok(text.split('\n').some((l) => l.startsWith('r1:')), text);
  assert.ok(text.includes('built-ins:'));
});

test('shortens the longest why first and leaves short ones whole', () => {
  const longWhy = 'This explanation is deliberately very long. '.repeat(80);
  const policy = smallPolicy([
    { id: 'short-a', decision: 'deny', match: { class: ['privilege'] }, why: 'Short reason A.' },
    { id: 'the-long-one', decision: 'deny', match: { class: ['delete'] }, why: longWhy },
    { id: 'short-b', decision: 'deny', match: { class: ['network-fetch'] }, why: 'Short reason B.' },
  ]);
  const text = renderKeepList(policy, { profile: 'default' });
  assert.ok(text.length <= KEEP_CAP, `length ${text.length}`);
  assert.ok(text.includes('Short reason A.'));
  assert.ok(text.includes('Short reason B.'));
  const line = text.split('\n').find((l) => l.startsWith('the-long-one:'));
  assert.ok(line.includes('…'), line);
  assert.ok(!line.includes(longWhy.trim()), 'the long why was shortened');
});

test('a policy under the cap is rendered whole, without ellipses', () => {
  const text = renderKeepList(examplePolicy(), { profile: 'default' });
  assert.ok(text.length < KEEP_CAP);
  assert.ok(!text.includes('…'), text);
});

test('precompact writes the snapshot file', () => {
  const d = freshDirs();
  const out = precompact(d, payloadFor('sess-keep-1'));
  assert.deepEqual(out, {});
  const file = path.join(d.state, KEEP_DIR, 'sess-keep-1.md');
  assert.equal(keepFileName('sess-keep-1'), 'sess-keep-1.md');
  const written = nodeFs.readFileSync(file, 'utf8');
  // the engine loads the policy with `~/` expanded against the home directory; the rendering is of that.
  // The first line records the sha256 of the policy file the rendering came from (session start compares it).
  const loaded = loadPolicy(d.policy, { home: os.homedir() });
  assert.equal(written, `fence-policy-sha256: ${loaded.sha}\n${renderKeepList(loaded.policy, { profile: 'default' })}`);
  assert.match(loaded.sha, /^[0-9a-f]{64}$/);
  assert.equal(readKeepSnapshot(d.state, 'sess-keep-1').sha, loaded.sha);
  assert.equal(readKeepSnapshot(d.state, 'sess-keep-1').text, renderKeepList(loaded.policy, { profile: 'default' }));
  assert.equal(readKeepSnapshot(d.state, 'no-such-session'), null);
  assert.equal(readKeepSnapshot(d.state, '../escape'), null);
  assert.ok(written.includes('credentials'));
  assert.equal(nodeFs.statSync(file).mode & 0o077, 0, 'private file');
  // the temp name is gone after the rename
  assert.deepEqual(nodeFs.readdirSync(path.join(d.state, KEEP_DIR)), ['sess-keep-1.md']);
  // a second compaction replaces the snapshot
  assert.deepEqual(precompact(d, payloadFor('sess-keep-1')), {});
  assert.deepEqual(nodeFs.readdirSync(path.join(d.state, KEEP_DIR)), ['sess-keep-1.md']);
});

test('readKeepSnapshot reads through one open descriptor, bounded, and refuses what is not a small regular file', () => {
  const d = freshDirs();
  precompact(d, payloadFor('sess-keep-fd'));
  const keep = path.join(d.state, KEEP_DIR);
  const file = path.join(keep, 'sess-keep-fd.md');
  const calls = [];
  const spy = new Proxy(nodeFs, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      return (...args) => {
        calls.push({ op: String(prop), args });
        return v.apply(target, args);
      };
    },
  });
  const snapshot = readKeepSnapshot(d.state, 'sess-keep-fd', { fs: spy });
  assert.match(snapshot.sha, /^[0-9a-f]{64}$/);
  const onFile = calls.filter((c) => c.args[0] === file);
  assert.ok(onFile.length > 0 && onFile.every((c) => c.op === 'openSync'), `only openSync takes the path: ${onFile.map((c) => c.op)}`);
  assert.ok(calls.some((c) => c.op === 'fstatSync'), 'the type and size come from the descriptor');
  assert.ok(!calls.some((c) => c.op === 'readFileSync'), 'no unbounded readFileSync');
  const reads = calls.filter((c) => c.op === 'readSync');
  assert.ok(reads.length > 0);
  for (const r of reads) assert.ok(r.args[3] <= 16 * 1024 + 1, `a read of ${r.args[3]} bytes exceeds the bound`);
  assert.ok(calls.filter((c) => c.op === 'openSync').length === calls.filter((c) => c.op === 'closeSync').length, 'the descriptor is closed');

  // an oversized file, a symlink and a directory are not snapshots; none of them is read in full
  nodeFs.writeFileSync(path.join(keep, 'sess-big.md'), 'x'.repeat(64 * 1024));
  nodeFs.symlinkSync(file, path.join(keep, 'sess-link.md'));
  nodeFs.mkdirSync(path.join(keep, 'sess-dir.md'));
  const bigCalls = [];
  const bigSpy = new Proxy(nodeFs, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === 'function' ? (...args) => (bigCalls.push({ op: String(prop), args }), v.apply(target, args)) : v;
    },
  });
  for (const id of ['sess-big', 'sess-link', 'sess-dir']) assert.equal(readKeepSnapshot(d.state, id, { fs: bigSpy }), null, id);
  for (const r of bigCalls.filter((c) => c.op === 'readSync')) assert.ok(r.args[3] <= 16 * 1024 + 1, `a read of ${r.args[3]} bytes exceeds the bound`);
  assert.ok(!bigCalls.some((c) => c.op === 'readFileSync'));
});

test('precompact renders the profile named by FENCE_PROFILE', () => {
  const d = freshDirs();
  assert.deepEqual(precompact(d, payloadFor('sess-keep-2'), { env: { FENCE_PROFILE: 'unattended' } }), {});
  const text = nodeFs.readFileSync(path.join(d.state, KEEP_DIR, 'sess-keep-2.md'), 'utf8');
  assert.match(text, /profile unattended/);
  assert.match(text, /undecided: deny/);
});

test('precompact with an unsafe session id writes nothing', () => {
  const unsafe = ['../escape', 'a/b', '..', '.', '', 'x'.repeat(200), 'nul\0byte', 'tab\tname', 'new\nline', 'sp ace', 42, null, undefined, ['a']];
  for (const id of unsafe) {
    const d = freshDirs();
    const payload = payloadFor(id);
    assert.deepEqual(precompact(d, payload), {}, JSON.stringify(id));
    assert.deepEqual(nodeFs.readdirSync(d.state), [], `state dir not empty for ${JSON.stringify(id)}`);
    assert.deepEqual(nodeFs.readdirSync(path.dirname(d.state)).sort(), ['policy.json', 'state'], `a file escaped for ${JSON.stringify(id)}`);
  }
});

test('precompact with a policy that does not load or an unreadable payload returns {} and writes nothing', () => {
  const broken = freshDirs('{ not json');
  assert.deepEqual(precompact(broken, payloadFor('sess-keep-3')), {});
  assert.deepEqual(nodeFs.readdirSync(broken.state), []);
  const d = freshDirs();
  for (const payload of ['not json', '[]', 'null', '']) assert.deepEqual(precompact(d, payload), {});
  assert.deepEqual(nodeFs.readdirSync(d.state), []);
  // a bad argument list does not deny either: compaction is never blocked
  const r = runEngine(['precompact', '--bogus'], { stdin: '{}' });
  assert.equal(r.exit, 0);
  assert.deepEqual(JSON.parse(r.stdout), {});
});

test('precompact never throws when the state dir is unwritable', () => {
  // Every write-side call of the file system throws (this also holds when the tests run as root).
  const throwing = new Proxy(nodeFs, {
    get(target, prop) {
      if (['mkdirSync', 'writeFileSync', 'openSync', 'renameSync', 'writeSync', 'copyFileSync'].includes(prop)) {
        return () => {
          throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const d = freshDirs();
  assert.deepEqual(precompact(d, payloadFor('sess-keep-4'), { fs: throwing }), {});
  assert.deepEqual(nodeFs.readdirSync(d.state), []);

  // The state dir path is a regular file, so keep/ cannot be created under it.
  const blocked = freshDirs();
  nodeFs.rmSync(blocked.state, { recursive: true });
  nodeFs.writeFileSync(blocked.state, 'not a directory');
  assert.deepEqual(precompact(blocked, payloadFor('sess-keep-5')), {});
  assert.equal(nodeFs.readFileSync(blocked.state, 'utf8'), 'not a directory');

  // keep/ is a symlink: never followed, nothing is written through it.
  const linked = freshDirs();
  const elsewhere = path.join(path.dirname(linked.state), 'elsewhere');
  nodeFs.mkdirSync(elsewhere);
  nodeFs.symlinkSync(elsewhere, path.join(linked.state, KEEP_DIR));
  assert.deepEqual(precompact(linked, payloadFor('sess-keep-6')), {});
  assert.deepEqual(nodeFs.readdirSync(elsewhere), []);
});

test('a failed rename leaves no partial file behind', () => {
  const failing = new Proxy(nodeFs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return () => {
          throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const d = freshDirs();
  assert.deepEqual(precompact(d, payloadFor('sess-keep-7'), { fs: failing }), {});
  assert.deepEqual(nodeFs.readdirSync(path.join(d.state, KEEP_DIR)), []);
});
