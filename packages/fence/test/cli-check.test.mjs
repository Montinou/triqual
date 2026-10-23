import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as check from '../src/cli/check.mjs';
import { validatePolicy } from '../src/policy/schema.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(PKG_DIR, 'bin', 'fence.mjs');

// The example policy from the spec's "Policy file" section, verbatim.
const SPEC_EXAMPLE = `{
  "version": 1,
  "profiles": {
    "default":    { "undecided": "host" },
    "unattended": { "undecided": "deny" }
  },
  "branches": { "protected": ["main", "master", "develop"], "denyFileWrites": false },
  "rules": [
    { "id": "credentials", "decision": "deny",
      "match": { "paths": ["**/.env", "**/.env.*", "~/.aws/**", "~/.ssh/**"], "access": "any" },
      "except": { "paths": ["**/.env.example", "**/.env.sample"] },
      "why": "Credential files are never read or written by the agent.",
      "examples": { "deny": [{ "tool": "Bash", "command": "cat .env" }], "allow": [{ "tool": "Read", "path": ".env.example" }] } }
  ]
}`;

// A temp home (never the real one) holding the policy file.
function setup(text) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-cli-')));
  const policy = path.join(home, 'policy.json');
  fs.writeFileSync(policy, text);
  return { home, policy };
}

function fence(args, home) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home },
    cwd: home,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('fence check exits 0 on the example policy and 1 on a bad one naming the pointer', () => {
  const ok = setup(SPEC_EXAMPLE);
  const r = fence(['check', '--policy', ok.policy], ok.home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 rule/);

  const bad = setup('{"version": 1, "rules": [{"id": "r", "decision": "deny", "match": {"class": ["delete"]}}]}');
  const b = fence(['check', '--policy', bad.policy], bad.home);
  assert.equal(b.code, 1);
  assert.ok(b.stderr.includes('/rules/0/why'), b.stderr);
  assert.ok(b.stderr.includes(bad.policy), b.stderr);
  assert.ok(b.stderr.includes('missing-key'), b.stderr);

  const reversed = setup('{"version": 1, "rules": [{"id": "r", "decision": "deny", "match": {"paths": ["/a/[z-a]"]}, "why": "w"}]}');
  const rv = fence(['check', '--policy', reversed.policy], reversed.home);
  assert.equal(rv.code, 1);
  assert.ok(rv.stderr.includes('/rules/0/match/paths/0'), rv.stderr);

  // the default policy path is under the home directory
  const none = setup(SPEC_EXAMPLE);
  const n = fence(['check'], none.home);
  assert.equal(n.code, 1);
  assert.ok(n.stderr.includes(path.join(none.home, '.config', 'fence', 'policy.json')), n.stderr);
  fs.mkdirSync(path.join(none.home, '.config', 'fence'), { recursive: true });
  fs.writeFileSync(path.join(none.home, '.config', 'fence', 'policy.json'), SPEC_EXAMPLE);
  assert.equal(fence(['check'], none.home).code, 0);

  // a missing --policy value is a usage error
  assert.equal(fence(['check', '--policy'], ok.home).code, 1);
});

test('fence check warns on an allow rule matching runs-repo-code', () => {
  const text = JSON.stringify({
    version: 1,
    rules: [
      { id: 'tests-ok', decision: 'allow', match: { class: ['runs-repo-code', 'search'] }, why: 'w' },
      { id: 'no-net', decision: 'deny', match: { class: ['runs-repo-code'] }, why: 'w' },
    ],
  });
  const { home, policy } = setup(text);
  const r = fence(['check', '--policy', policy], home);
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout + r.stderr;
  assert.match(out, /warning/i);
  assert.ok(out.includes('tests-ok'));
  assert.ok(out.includes('runs-repo-code'));
  assert.ok(!out.includes('no-net'), 'a deny rule on runs-repo-code is not warned about');

  // an argv match alone covers runs-repo-code, so an argv allow is warned about too; a rule
  // with neither class runs-repo-code nor argv can not cover such a part and is not
  const text2 = JSON.stringify({
    version: 1,
    rules: [
      { id: 'npm-test', decision: 'allow', match: { argv: [['npm', 'test']] }, why: 'w' },
      { id: 'repo-reads', decision: 'allow', match: { paths: ['${repo}/**'], access: 'read' }, why: 'w' },
      { id: 'search-only', decision: 'allow', match: { class: ['search'] }, why: 'w' },
    ],
  });
  const second = setup(text2);
  const r2 = fence(['check', '--policy', second.policy], second.home);
  assert.equal(r2.code, 0, r2.stderr);
  const out2 = r2.stdout + r2.stderr;
  assert.match(out2, /warning: allow rule "npm-test"/);
  assert.ok(!out2.includes('"repo-reads"'), out2);
  assert.ok(!out2.includes('"search-only"'), out2);
});

test('fence check warns, without failing, on an unknown construct name in a profile', () => {
  const text = (constructs) =>
    JSON.stringify({
      version: 1,
      profiles: { default: { undecided: 'host', uncertain: { constructs } } },
      rules: [],
    });
  const bad = setup(text({ 'no-such': 'audit', 'eval-dynamic': 'deny' }));
  const r = fence(['check', '--policy', bad.policy], bad.home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /warning: profile "default": uncertain\.constructs names "no-such"/);
  assert.match(r.stderr, /not in fence's known list of opaque constructs \(a likely typo\)/);
  assert.ok(!/never applies/.test(r.stderr), r.stderr);
  assert.ok(!r.stderr.includes('"eval-dynamic"'), r.stderr);
  assert.match(r.stdout, /is valid/);

  // known names draw no warning
  const good = setup(text({ 'eval-dynamic': 'audit', 'command-substitution': 'deny' }));
  const g = fence(['check', '--policy', good.policy], good.home);
  assert.equal(g.code, 0, g.stderr);
  assert.ok(!/warning/.test(g.stderr), g.stderr);
});

test('fence test runs examples with non-shell tools and shell examples through the engine', () => {
  const ok = setup(SPEC_EXAMPLE);
  const r = fence(['test', '--policy', ok.policy], ok.home);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  // no policy example is skipped (the built-in table that follows reports its own skips)
  const examples = r.stdout.slice(0, r.stdout.indexOf('0 skipped'));
  assert.ok(!/skip/i.test(examples), r.stdout);
  assert.match(r.stdout, /PASS credentials deny\[0\] Bash cat \.env/);
  assert.match(r.stdout, /2 passed, 0 failed, 0 skipped/);

  // a richer policy: deny and allow examples on file, fetch and mcp tools, one of them wrong
  const text = JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'creds',
        decision: 'deny',
        match: { paths: ['**/.env', '~/.ssh/**'], access: 'any' },
        except: { paths: ['**/.env.example'] },
        why: 'w',
        examples: {
          deny: [
            { tool: 'Read', path: '.env' },
            { tool: 'Write', file_path: '~/.ssh/config' },
            { tool: 'Read', path: 'README.md' },
          ],
          allow: [{ tool: 'Read', path: '.env.example' }, { tool: 'shell', command: ['cat', 'README.md'] }],
        },
      },
      {
        id: 'web',
        decision: 'deny',
        match: { domains: ['bad.example'] },
        why: 'w',
        examples: { deny: [{ tool: 'WebFetch', url: 'https://bad.example/x' }], allow: [{ tool: 'WebFetch', url: 'https://ok.example/' }] },
      },
      {
        id: 'mcp',
        decision: 'deny',
        match: { mcp: ['mcp__evil__*'] },
        why: 'w',
        examples: { deny: [{ tool: 'mcp__evil__run' }], allow: [{ tool: 'mcp__good__run' }] },
      },
    ],
  });
  const rich = setup(text);
  const t = fence(['test', '--policy', rich.policy], rich.home);
  assert.equal(t.code, 1, t.stdout + t.stderr);
  assert.match(t.stdout, /FAIL.*creds.*README\.md/);
  assert.match(t.stdout, /8 passed, 1 failed, 0 skipped/);

  // an allow example on an allow rule must be allowed, not merely not denied; ${repo}
  // in an example path expands to the temporary example repo
  const allowText = JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'repo-reads',
        decision: 'allow',
        match: { paths: ['${repo}/**'], access: 'read' },
        why: 'w',
        examples: { allow: [{ tool: 'Read', path: '${repo}/src/a.js' }, { tool: 'Read', path: 'b.txt' }, { tool: 'Read', path: '/etc/hosts' }] },
      },
    ],
  });
  const al = setup(allowText);
  const a = fence(['test', '--policy', al.policy], al.home);
  assert.equal(a.code, 1, a.stdout + a.stderr);
  assert.match(a.stdout, /PASS repo-reads allow\[0\]/);
  assert.match(a.stdout, /PASS repo-reads allow\[1\]/);
  assert.match(a.stdout, /FAIL repo-reads allow\[2\].*expected allow, got undecided/);
  assert.match(a.stdout, /2 passed, 1 failed, 0 skipped/);

  // a bad policy is a load error
  const bad = setup('{"version": 2, "rules": []}');
  const b = fence(['test', '--policy', bad.policy], bad.home);
  assert.equal(b.code, 1);
  assert.ok(b.stderr.includes('/version'), b.stderr);
});

test('fence help, unknown commands and not-yet-built commands', () => {
  const { home } = setup(SPEC_EXAMPLE);
  const h = fence([], home);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /check/);
  const u = fence(['bogus'], home);
  assert.equal(u.code, 1);
  assert.match(u.stderr, /bogus/);
  // replay is read-only: run from a pipe it reaches its own argument check, not the human-only refusal
  const l = fence(['replay'], home);
  assert.equal(l.code, 1);
  assert.match(l.stderr, /usage: fence replay/);
  assert.doesNotMatch(l.stderr, /not yet implemented|interactive terminal/);
  // a human-only command run from a pipe (this spawn has no terminal) is refused by the wiring
  const hatch = fence(['hatch'], home);
  assert.equal(hatch.code, 1);
  assert.match(hatch.stderr, /interactive terminal/);
});

test('fence version prints the package version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const { home } = setup(SPEC_EXAMPLE);
  for (const arg of ['version', '--version']) {
    const r = fence([arg], home);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(pkg.version), r.stdout);
  }
  const help = fence(['help'], home);
  assert.ok(help.stdout.includes(pkg.version));
  for (const c of ['check', 'test', 'version', 'help', 'install', 'allow-once']) assert.ok(help.stdout.includes(c), c);
});

// ---- fence test under modes (T8) ----------------------------------------------------------------------

const CREDS = (decision, examples) => ({
  id: 'creds',
  decision,
  match: { paths: ['~/.ssh/**'], access: 'any' },
  why: 'Keys are never read.',
  ...(examples === undefined ? {} : { examples }),
});

// fence test, no built-in table, in process; the policy examples only.
function exampleRun(policy) {
  const { home, policy: file } = setup(JSON.stringify(policy));
  const out = [];
  const code = check.runTest(['--policy', file], { out: (l) => out.push(l), err: (l) => out.push(l) }, { home, builtin: false });
  return { code, text: out.join('\n') };
}

test('forceDeny sets every audit-able action to deny and leaves undecided and the input alone', () => {
  const policy = validatePolicy({
    version: 1,
    profiles: {
      default: { undecided: 'host' },
      relaxed: { undecided: 'host', uncertain: { opaque: 'audit', selfProtection: 'audit', rules: 'audit', constructs: { 'eval-dynamic': 'audit' } }, certain: 'audit', rules: { creds: 'off', other: 'audit' } },
      unattended: { undecided: 'deny', uncertain: 'audit', certain: 'audit' },
    },
    rules: [CREDS('audit'), { id: 'other', decision: 'deny', match: { class: ['delete'] }, why: 'w' }, { id: 'ok', decision: 'allow', match: { class: ['search'] }, why: 'w' }],
  });
  const before = JSON.stringify(policy);
  const forced = check.forceDeny(policy);
  assert.equal(JSON.stringify(policy), before, 'the input is not changed');
  for (const name of ['default', 'relaxed', 'unattended']) {
    const p = forced.profiles[name];
    assert.equal(p.certain, 'deny', name);
    assert.deepEqual([p.uncertain.opaque, p.uncertain.selfProtection, p.uncertain.rules], ['deny', 'deny', 'deny'], name);
    assert.ok(Object.values(p.uncertain.constructs).every((a) => a === 'deny'), name);
    assert.ok(Object.values(p.rules).every((a) => a === 'deny'), name);
  }
  assert.deepEqual(Object.keys(forced.profiles.relaxed.rules).sort(), ['creds', 'other']);
  assert.deepEqual(Object.keys(forced.profiles.relaxed.uncertain.constructs), ['eval-dynamic']);
  assert.equal(forced.profiles.default.undecided, 'host');
  assert.equal(forced.profiles.unattended.undecided, 'deny');
  assert.deepEqual(forced.rules.map((r) => r.decision), ['deny', 'deny', 'allow']);
  assert.deepEqual(forced.rules.map((r) => r.id), ['creds', 'other', 'ok']);
});

test('forceDeny also reads a policy as written in the file', () => {
  const forced = check.forceDeny({ version: 1, profiles: { a: { undecided: 'host', uncertain: 'audit', certain: 'audit' }, b: { undecided: 'deny' } }, rules: [{ id: 'r', decision: 'audit' }] });
  assert.deepEqual(forced.profiles.a, { undecided: 'host', uncertain: 'deny', certain: 'deny' });
  assert.deepEqual(forced.profiles.b, { undecided: 'deny' });
  assert.equal(forced.rules[0].decision, 'deny');
});

test('fence test: a deny example of an audit rule passes, on a tool call and on a shell command', () => {
  const r = exampleRun({
    version: 1,
    rules: [CREDS('audit', { deny: [{ tool: 'Read', path: '~/.ssh/id_rsa' }, { tool: 'Bash', command: 'cat ~/.ssh/id_rsa' }], allow: [{ tool: 'Read', path: 'README.md' }] })],
  });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /PASS creds deny\[0\] Read/);
  assert.match(r.text, /PASS creds deny\[1\] Bash cat/);
  assert.match(r.text, /3 passed, 0 failed, 0 skipped/);
});

test('fence test: a deny example passes under a profile that relaxes certain denies', () => {
  const r = exampleRun({
    version: 1,
    profiles: { default: { undecided: 'host', uncertain: 'audit', certain: 'audit', rules: { creds: 'off' } } },
    rules: [CREDS('deny', { deny: [{ tool: 'Read', path: '~/.ssh/id_rsa' }, { tool: 'Bash', command: 'cat ~/.ssh/id_rsa' }] })],
  });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /2 passed, 0 failed, 0 skipped/);
});

test('fence test: an allow example of a deny rule passes when the call ends undecided, and fails when denied', () => {
  const r = exampleRun({
    version: 1,
    profiles: { default: { undecided: 'host', uncertain: 'audit' } },
    rules: [CREDS('deny', { deny: [{ tool: 'Read', path: '~/.ssh/id_rsa' }], allow: [{ tool: 'Bash', command: 'npm test' }, { tool: 'Read', path: '~/.ssh/config' }] })],
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /PASS creds allow\[0\] Bash npm test/);
  assert.match(r.text, /FAIL creds allow\[1\].*expected not deny, got deny/);
  assert.match(r.text, /2 passed, 1 failed, 0 skipped/);
});
