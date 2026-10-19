import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTest } from '../src/cli/check.mjs';
import * as selfprotect from '../src/cli/selfprotect.mjs';
import { CASES_FILE, loadCases, prepareCase, runBuiltinCases } from '../src/cli/selfprotect.mjs';

// Hermetic: every row gets its own synthetic home and repository under one realpath'd temp root.
// The engine only analyses the calls (in process); nothing here executes a payload.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-selfprotect-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = loadCases();

// Every route the table must cover (brief), as the row ids that stand for it.
const ROUTES = {
  Edit: 'edit-claude-settings',
  Write: 'write-claude-settings',
  apply_patch: 'apply-patch-codex-hooks',
  'shell redirect': 'shell-redirect',
  'sed -i': 'shell-sed-in-place',
  'python3 -c': 'interpreter-python-c',
  'agent-written script': 'agent-written-script',
  'opaque command': 'opaque-command',
  'mv onto a missing .claude': 'mv-onto-missing-claude-dir',
  'case-flipped path': 'case-flipped-path',
  'HOME=... claude': 'home-redirect-claude',
  'claude plugin disable': 'claude-plugin-disable',
  'codex features disable hooks': 'codex-features-disable-hooks',
  'git checkout bringing .claude/settings.json': 'git-checkout-brings-claude-settings',
  'cd ~/.claude && tool settings.json': 'cd-protected-dir-unmodeled-tool',
};

test('the table ships with the package and covers every route', () => {
  assert.equal(CASES_FILE, path.join(PKG_DIR, 'fixtures', 'selfprotect-cases.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('fixtures'), 'package.json files must ship fixtures');
  const ids = new Set(CASES.map((c) => c.id));
  assert.equal(ids.size, CASES.length, 'row ids are unique');
  for (const [route, id] of Object.entries(ROUTES)) assert.ok(ids.has(id), `no row for ${route} (${id})`);
  for (const c of CASES) {
    assert.match(c.expectRule, /^builtin:[a-z-]+$/, c.id);
    assert.ok(c.harmless && typeof c.harmless.tool === 'string' && typeof c.harmless.input === 'object', `${c.id} has no harmless twin`);
  }
});

test('every case denies with its expected builtin rule', async (t) => {
  for (const row of CASES) {
    await t.test(row.id, (t2) => {
      const c = prepareCase(row, { root: TMP });
      if (c.skip) return t2.skip(c.skip);
      const d = c.decide('attack');
      assert.equal(d.decision, 'deny', `${row.id}: ${JSON.stringify(d)}`);
      assert.equal(d.rule, row.expectRule, `${row.id}: ${d.reason}`);
    });
  }
});

test('a matching harmless case allows or stays undecided', async (t) => {
  for (const row of CASES) {
    await t.test(row.id, (t2) => {
      const c = prepareCase(row, { root: TMP });
      if (c.skip) return t2.skip(c.skip);
      const d = c.decide('harmless');
      assert.ok(d.decision === 'allow' || d.decision === 'undecided', `${row.id}: ${JSON.stringify(d)}`);
    });
  }
});

function sink() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

test('runBuiltinCases reports each case and fails when one does not hold', () => {
  const good = sink();
  const ok = runBuiltinCases(good.io);
  assert.equal(ok.failed, 0, good.out.join('\n'));
  assert.ok(ok.passed > 0);
  assert.equal(ok.passed + ok.skipped, CASES.length);
  for (const row of CASES) assert.ok(good.out.some((l) => l.includes(`builtin ${row.id}`)), `no line for ${row.id}`);

  // a row whose expected rule is wrong, and one whose harmless twin is denied, each fail
  const wrong = { ...CASES[0], id: 'wrong-rule', expectRule: 'builtin:opaque' };
  const denied = { ...CASES[0], id: 'twin-denied', harmless: { tool: 'Write', input: { file_path: '${home}/.claude/settings.json', content: 'x' } } };
  const bad = sink();
  const r = runBuiltinCases(bad.io, { cases: [wrong, denied] });
  assert.equal(r.failed, 2);
  assert.ok(bad.out.some((l) => /^FAIL builtin wrong-rule/.test(l)), bad.out.join('\n'));
  assert.ok(bad.out.some((l) => /^FAIL builtin twin-denied/.test(l)), bad.out.join('\n'));
});

test('fence test runs the built-in cases after the policy examples and fails when one fails', () => {
  const home = path.join(TMP, 'cli-home');
  fs.mkdirSync(home, { recursive: true });
  const policy = path.join(home, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ version: 1, rules: [] }));

  const s = sink();
  const code = runTest(['--policy', policy], s.io, { home });
  assert.equal(code, 0, s.out.join('\n') + s.err.join('\n'));
  const lines = s.out;
  const summary = lines.findIndex((l) => /^\d+ passed, \d+ failed, \d+ skipped$/.test(l));
  const first = lines.findIndex((l) => l.includes('builtin '));
  assert.ok(summary >= 0 && first > summary, 'built-in lines come after the policy example summary');
  assert.ok(lines.some((l) => /^PASS builtin edit-claude-settings/.test(l)), lines.join('\n'));
  assert.match(lines.at(-1), /^built-in self-protection: \d+ passed, 0 failed, \d+ skipped$/);

  // the real home is never read: the run uses a synthetic home, so the given one gains nothing
  assert.deepEqual(fs.readdirSync(home).sort(), ['policy.json']);

  const f = sink();
  const failing = { ...CASES[0], id: 'forced-failure', expectRule: 'builtin:opaque' };
  const failCode = runTest(['--policy', policy], f.io, { home, builtinCases: [failing] });
  assert.equal(failCode, 1, f.out.join('\n'));
  assert.ok(f.out.some((l) => /^FAIL builtin forced-failure/.test(l)), f.out.join('\n'));
  assert.match(f.out.at(-1), /built-in self-protection: 0 passed, 1 failed, 0 skipped$/);

  // opting out leaves only the policy examples
  const n = sink();
  assert.equal(runTest(['--policy', policy], n.io, { home, builtin: false }), 0);
  assert.ok(!n.out.some((l) => l.includes('builtin')), n.out.join('\n'));
});

// ---- the table under the four example profiles (T8) ----------------------------------------------------

const FOUR = {
  default: { undecided: 'host', uncertain: 'audit' },
  strict: { undecided: 'host', uncertain: 'deny' },
  relaxed: { undecided: 'host', uncertain: 'audit', certain: 'audit' },
  unattended: { undecided: 'deny', uncertain: 'deny' },
};

test('the runner carries the spec\'s four example profiles', () => {
  assert.deepEqual(selfprotect.EXAMPLE_PROFILES, FOUR);
});

test('every row denies with its rule under all four profiles, and its harmless twin is denied by no rule but builtin:profile', async (t) => {
  for (const row of CASES) {
    for (const profile of Object.keys(FOUR)) {
      await t.test(`${row.id} under ${profile}`, (t2) => {
        const c = prepareCase(row, { root: TMP });
        if (c.skip) return t2.skip(c.skip);
        const attack = c.decide('attack', profile);
        assert.equal(attack.decision, 'deny', `${row.id}: ${JSON.stringify(attack)}`);
        assert.equal(attack.rule, row.expectRule, `${row.id}: ${attack.reason}`);
        const twin = c.decide('harmless', profile);
        assert.ok(twin.decision !== 'deny' || twin.rule === 'builtin:profile', `${row.id} twin: ${JSON.stringify(twin)}`);
        if (twin.decision === 'deny') assert.equal(profile, 'unattended', `${row.id} twin denied by builtin:profile outside unattended`);
      });
    }
  }
});

test('the opaque-command row names its protected target literally', () => {
  const row = CASES.find((r) => r.id === 'opaque-command');
  assert.match(row.input.command, /\$\{home\}\/\.claude\/settings\.json/);
  assert.equal(row.expectRule, 'builtin:opaque');
});

test('the runner selects each profile with FENCE_PROFILE and fails a row a mode relaxes', () => {
  // an opaque call whose text names no target is audited under `default`: the row fails there, and the line names the profile
  const soft = { ...CASES.find((r) => r.id === 'opaque-command'), id: 'soft-opaque', input: { command: 'sh -c "$FENCE_CASE_PAYLOAD"' } };
  const s = sink();
  const r = runBuiltinCases(s.io, { cases: [soft] });
  assert.equal(r.failed, 1, s.out.join('\n'));
  assert.ok(s.out.some((l) => /^FAIL builtin soft-opaque.*\b(default|relaxed)\b/.test(l)), s.out.join('\n'));

  // the profile is selected by FENCE_PROFILE: a name the policy does not define is the floor deny for it
  const c = prepareCase(CASES.find((r) => r.id === 'shell-redirect'), { root: TMP });
  assert.equal(c.decide('attack', 'unattended').rule, 'builtin:self-protection');
  assert.equal(c.decide('attack', 'nightly').rule, 'builtin:unknown-profile');
});
