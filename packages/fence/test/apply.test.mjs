import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, applyFacts, edit } from '../src/cli/apply.mjs';
import { requiresGate } from '../src/cli/humanonly.mjs';
import { classifyChange } from '../src/cli/weakening.mjs';
import { loadPolicy } from '../src/policy/load.mjs';

// Hermetic: every test builds its own temp root holding a temp HOME (with a policy under
// .config/fence and a host config under .claude), and a drafts directory. sudo is never run: the
// gate is an injected function. The editor is never spawned: edit gets an injected spawn. The
// example runner works in its own temp directories and removes them.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-apply-test-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function newDir(name) {
  const d = path.join(TMP, `${name}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (v) => structuredClone(v);

// The base policy: one deny with an except and examples, two profiles, protected branches.
const BASE = {
  version: 1,
  profiles: { default: { undecided: 'host' }, unattended: { undecided: 'deny' } },
  branches: { protected: ['main', 'master'], denyFileWrites: true },
  rules: [
    {
      id: 'credentials',
      decision: 'deny',
      match: { paths: ['**/.env', '**/.aws/**'], access: 'any' },
      except: { paths: ['**/.env.example'] },
      why: 'Credential files are never read or written by the agent.',
      examples: { deny: [{ tool: 'Read', path: '.env' }], allow: [{ tool: 'Read', path: '.env.example' }] },
    },
  ],
};

const NEW_DENY = {
  id: 'no-keys',
  decision: 'deny',
  match: { paths: ['**/*.pem'] },
  why: 'Private keys stay out of reach.',
  examples: { deny: [{ tool: 'Read', path: 'server.pem' }] },
};

const text = (p) => `${JSON.stringify(p, null, 2)}\n`;

// A temp root: home/.config/fence/policy.json (BASE), home/.claude/settings.json, drafts/.
function world(policy = BASE) {
  const root = newDir('world');
  const home = path.join(root, 'home');
  const policyPath = path.join(home, '.config', 'fence', 'policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, text(policy));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{"hooks":{}}\n');
  const drafts = path.join(root, 'drafts');
  fs.mkdirSync(drafts);
  const draft = (p, name = 'draft.json') => {
    const file = path.join(drafts, name);
    fs.writeFileSync(file, typeof p === 'string' ? p : text(p));
    return file;
  };
  return { root, home, policyPath, settings, drafts, draft };
}

// Records the calls to confirm and gate; confirm answers `answer`, gate answers `gateResult`.
function hooks({ answer = true, gateResult = { ok: true } } = {}) {
  const calls = { confirm: [], gate: 0 };
  return {
    calls,
    confirm: async (summary) => (calls.confirm.push(summary), answer),
    gate: () => (calls.gate++, gateResult),
  };
}

const quiet = () => {
  const lines = [];
  return { lines, io: { out: (s) => lines.push(s), err: (s) => lines.push(s) } };
};

// Every path under `root` -> content hash (files), "dir" or "link:<target>", plus mtimes.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(root, p);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(p);
      } else out[rel] = `${sha256(fs.readFileSync(p))} ${st.mtimeMs} ${st.ino}`;
    }
  };
  walk(root);
  return out;
}

test('adding a deny is not weakening', () => {
  const next = clone(BASE);
  next.rules.push(clone(NEW_DENY));
  assert.deepEqual(classifyChange(BASE, next), { weakening: false, reasons: [] });
  // widening an existing deny (a glob appended, the except removed) and editing only `why` or
  // the examples are not weakening either
  const wider = clone(BASE);
  wider.rules[0].match.paths.push('**/.netrc');
  delete wider.rules[0].except;
  wider.rules[0].why = 'Reworded.';
  wider.rules[0].examples = { deny: [] };
  assert.deepEqual(classifyChange(BASE, wider), { weakening: false, reasons: [] });
  const anyAccess = clone(BASE);
  anyAccess.rules[0].match.access = 'write';
  assert.deepEqual(classifyChange(anyAccess, BASE), { weakening: false, reasons: [] });
  const protectedMore = clone(BASE);
  protectedMore.branches.protected.push('release');
  assert.deepEqual(classifyChange(BASE, protectedMore), { weakening: false, reasons: [] });
  // reordering rules changes nothing (precedence is fixed, not first-match)
  const two = clone(BASE);
  two.rules.push(clone(NEW_DENY));
  const reordered = clone(two);
  reordered.rules.reverse();
  assert.deepEqual(classifyChange(two, reordered), { weakening: false, reasons: [] });
});

test('removing a deny is weakening', () => {
  const next = clone(BASE);
  next.rules = [];
  const r = classifyChange(BASE, next);
  assert.equal(r.weakening, true);
  assert.ok(r.reasons.some((s) => /credentials/.test(s) && /removed/.test(s)), r.reasons.join('\n'));
  // a rename is a removal plus an addition
  const renamed = clone(BASE);
  renamed.rules[0].id = 'creds';
  assert.equal(classifyChange(BASE, renamed).weakening, true);
  // a deny turned into an allow, an allow added, a protected branch removed
  const flipped = clone(BASE);
  flipped.rules[0].decision = 'allow';
  assert.equal(classifyChange(BASE, flipped).weakening, true);
  const allowed = clone(BASE);
  allowed.rules.push({ id: 'ok-ls', decision: 'allow', match: { argv: [['ls']] }, why: 'Listing is fine.' });
  assert.equal(classifyChange(BASE, allowed).weakening, true);
  const unprotected = clone(BASE);
  unprotected.branches.protected = ['main'];
  const u = classifyChange(BASE, unprotected);
  assert.equal(u.weakening, true);
  assert.ok(u.reasons.some((s) => /master/.test(s)), u.reasons.join('\n'));
  // a match key added to a deny narrows it
  const narrowed = clone(BASE);
  narrowed.rules[0].match.class = ['delete'];
  assert.equal(classifyChange(BASE, narrowed).weakening, true);
  // no current policy, or a new one that does not validate: never proven to tighten
  assert.equal(classifyChange(null, BASE).weakening, true);
  assert.equal(classifyChange(BASE, { ...clone(BASE), extra: true }).weakening, true);
});

test('adding a path to an except is weakening', () => {
  const next = clone(BASE);
  next.rules[0].except.paths.push('**/.env.local');
  const r = classifyChange(BASE, next);
  assert.equal(r.weakening, true);
  assert.ok(r.reasons.some((s) => /except/.test(s) && /\.env\.local/.test(s)), r.reasons.join('\n'));
  // an except added to a deny that had none
  const noExcept = clone(BASE);
  delete noExcept.rules[0].except;
  assert.equal(classifyChange(noExcept, BASE).weakening, true);
});

test('editing a glob in place counts as weakening', () => {
  const next = clone(BASE);
  next.rules[0].match.paths[1] = '**/.aws/credentials';
  const r = classifyChange(BASE, next);
  assert.equal(r.weakening, true);
  assert.ok(r.reasons.some((s) => /\.aws\/\*\*/.test(s)), r.reasons.join('\n'));
  // the same for an argv prefix and a domain
  const argv = { version: 1, rules: [{ id: 'r', decision: 'deny', match: { argv: [['git', 'push']] }, why: 'w' }] };
  const argvEdited = clone(argv);
  argvEdited.rules[0].match.argv = [['git', 'push', '--force']];
  assert.equal(classifyChange(argv, argvEdited).weakening, true);
  const dom = { version: 1, rules: [{ id: 'r', decision: 'deny', match: { class: ['network-fetch'], domains: ['*.example.com'] }, why: 'w' }] };
  const domEdited = clone(dom);
  domEdited.rules[0].match.domains = ['api.example.com'];
  assert.equal(classifyChange(dom, domEdited).weakening, true);
  // an access narrowed from any to write
  const access = clone(BASE);
  access.rules[0].match.access = 'write';
  assert.equal(classifyChange(BASE, access).weakening, true);
  // an allow glob edited in place widens it as far as anyone can prove
  const allow = { version: 1, rules: [{ id: 'a', decision: 'allow', match: { paths: ['/srv/public/**'], access: 'read' }, why: 'w' }] };
  const allowEdited = clone(allow);
  allowEdited.rules[0].match.paths = ['/srv/**'];
  assert.equal(classifyChange(allow, allowEdited).weakening, true);
  // narrowing an allow (a glob removed) is not
  const allowTwo = clone(allow);
  allowTwo.rules[0].match.paths.push('/srv/docs/**');
  assert.equal(classifyChange(allowTwo, allow).weakening, false);
});

test('changing undecided from deny to host is weakening', () => {
  const next = clone(BASE);
  next.profiles.unattended.undecided = 'host';
  const r = classifyChange(BASE, next);
  assert.equal(r.weakening, true);
  assert.ok(r.reasons.some((s) => /unattended/.test(s)), r.reasons.join('\n'));
  // the other way tightens
  const stricter = clone(BASE);
  stricter.profiles.default.undecided = 'deny';
  assert.equal(classifyChange(BASE, stricter).weakening, false);
  // a profile added is a profile change that is not proven to tighten
  const added = clone(BASE);
  added.profiles.ci = { undecided: 'deny' };
  assert.equal(classifyChange(BASE, added).weakening, true);
});

test('denyFileWrites true to false is weakening', () => {
  const next = clone(BASE);
  next.branches.denyFileWrites = false;
  const r = classifyChange(BASE, next);
  assert.equal(r.weakening, true);
  assert.ok(r.reasons.some((s) => /denyFileWrites/.test(s)), r.reasons.join('\n'));
  // omitting it means false
  const omitted = clone(BASE);
  delete omitted.branches.denyFileWrites;
  assert.equal(classifyChange(BASE, omitted).weakening, true);
  assert.equal(classifyChange(omitted, BASE).weakening, false);
});

test('a failing example blocks apply', async () => {
  const w = world();
  const next = clone(BASE);
  // a deny example the rule does not deny
  next.rules.push({ ...clone(NEW_DENY), examples: { deny: [{ tool: 'Read', path: 'notes.txt' }] } });
  const draftPath = w.draft(next);
  const before = fs.readFileSync(w.policyPath);
  const h = hooks();
  const q = quiet();
  const r = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: q.io });
  assert.equal(r.ok, false);
  assert.match(r.reason, /example/);
  assert.ok(q.lines.some((l) => /FAIL no-keys/.test(l)), q.lines.join('\n'));
  assert.equal(h.calls.confirm.length, 0);
  assert.equal(h.calls.gate, 0);
  assert.deepEqual(fs.readFileSync(w.policyPath), before);
  // an invalid draft is refused before anything else
  const invalid = w.draft({ version: 1, rules: [{ id: 'x', decision: 'deny', match: { paths: ['**/a'] } }] }, 'invalid.json');
  const r2 = await apply({ draftPath: invalid, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: q.io });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /missing-key|why/);
  assert.equal(h.calls.confirm.length, 0);
  assert.deepEqual(fs.readFileSync(w.policyPath), before);
});

test('apply writes atomically and records the sha', async () => {
  const w = world();
  const next = clone(BASE);
  next.rules.push(clone(NEW_DENY));
  const draftPath = w.draft(next);
  const draftBytes = fs.readFileSync(draftPath);
  const oldIno = fs.statSync(w.policyPath).ino;
  // the human-only table gets the fact from the classifier: a tightening apply needs no sudo gate
  assert.equal(requiresGate('apply', applyFacts({ draftPath, policyPath: w.policyPath })), false);
  const h = hooks();
  const q = quiet();
  const r = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: q.io });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.weakening, false);
  // a tightening change needs no gate, but it is confirmed after the diffs were shown
  assert.equal(h.calls.gate, 0);
  assert.equal(h.calls.confirm.length, 1);
  const summary = h.calls.confirm[0];
  assert.match(summary.renderedDiff, /^\+ no-keys: deny paths\(any\)=\*\*\/\*\.pem/m);
  assert.match(summary.jsonDiff, /^\+ .*"no-keys"/m);
  assert.equal(summary.weakening, false);
  assert.ok(q.lines.some((l) => /^\+ no-keys/m.test(l)), 'the rendered-rule diff is printed');
  assert.ok(q.lines.some((l) => /PASS no-keys deny\[0\]/.test(l)), 'the examples ran on the draft');
  // the policy now holds exactly the draft's bytes, put in place by a rename (a new inode)
  assert.deepEqual(fs.readFileSync(w.policyPath), draftBytes);
  assert.notEqual(fs.statSync(w.policyPath).ino, oldIno);
  assert.deepEqual(fs.readdirSync(path.dirname(w.policyPath)), ['policy.json']);
  // policy_sha is the sha256 of the written bytes, the value the engine and doctor compute
  assert.equal(r.policySha, sha256(draftBytes));
  assert.equal(r.policySha, loadPolicy(w.policyPath, { home: w.home }).sha);
  assert.ok(q.lines.some((l) => l.includes(`policy_sha ${r.policySha}`)), q.lines.join('\n'));
  // a declined confirmation writes nothing
  const w2 = world();
  const before = fs.readFileSync(w2.policyPath);
  const no = hooks({ answer: false });
  const r2 = await apply({ draftPath: w2.draft(next), policyPath: w2.policyPath, home: w2.home, confirm: no.confirm, gate: no.gate, io: quiet().io });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not confirmed/);
  assert.deepEqual(fs.readFileSync(w2.policyPath), before);
});

test('a weakening apply without the gate is refused', async () => {
  const w = world();
  const next = clone(BASE);
  next.branches.denyFileWrites = false;
  const draftPath = w.draft(next);
  const before = fs.readFileSync(w.policyPath);
  // the human-only table gets the fact from the classifier: this apply needs the sudo gate
  assert.equal(requiresGate('apply', applyFacts({ draftPath, policyPath: w.policyPath })), true);
  // no gate at all
  const h = hooks();
  const r = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, io: quiet().io });
  assert.equal(r.ok, false);
  assert.equal(r.weakening, true);
  assert.match(r.reason, /sudo/);
  assert.deepEqual(fs.readFileSync(w.policyPath), before);
  // a gate that fails
  const denied = hooks({ gateResult: { ok: false, reason: 'sudo -v failed (exit 1)' } });
  const r2 = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: denied.confirm, gate: denied.gate, io: quiet().io });
  assert.equal(r2.ok, false);
  assert.equal(denied.calls.gate, 1);
  assert.match(r2.reason, /sudo -v failed/);
  assert.deepEqual(fs.readFileSync(w.policyPath), before);
  // a gate that passes: written
  const passed = hooks();
  const r3 = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: passed.confirm, gate: passed.gate, io: quiet().io });
  assert.equal(r3.ok, true, r3.reason);
  assert.equal(passed.calls.gate, 1);
  assert.ok(r3.reasons.some((s) => /denyFileWrites/.test(s)));
  assert.deepEqual(fs.readFileSync(w.policyPath), fs.readFileSync(draftPath));
});

test('apply never writes outside the policy path', async () => {
  const w = world();
  const next = clone(BASE);
  next.rules = [clone(NEW_DENY)]; // weakening: the credentials deny is removed
  const draftPath = w.draft(next);
  const before = snapshot(w.root);
  const h = hooks();
  const r = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(r.ok, true, r.reason);
  const after = snapshot(w.root);
  const rel = path.relative(w.root, w.policyPath);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [rel]);
  // the host config is untouched, the draft too
  assert.equal(after[path.relative(w.root, w.settings)], before[path.relative(w.root, w.settings)]);
  // the policy file itself is not a draft
  const self = await apply({ draftPath: w.policyPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(self.ok, false);
  assert.match(self.reason, /policy file itself/);
  const link = path.join(w.drafts, 'link.json');
  fs.symlinkSync(w.policyPath, link);
  const viaLink = await apply({ draftPath: link, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.reason, /policy file itself/);
  // the write goes into the policy's own directory by temp-and-rename: a temp name elsewhere would
  // show up in the snapshot above; nothing is left beside it either
  assert.deepEqual(fs.readdirSync(path.dirname(w.policyPath)), ['policy.json']);
});

test('edit opens a copy of the policy in $EDITOR through the injected spawn', () => {
  const w = world();
  const before = snapshot(w.root);
  const spawned = [];
  const spawn = (cmd, args, opts) => (spawned.push({ cmd, args, opts }), { status: 0 });
  const r = edit({ policyPath: w.policyPath, env: { EDITOR: 'nano -w' }, spawn, draftDir: w.drafts });
  assert.equal(r.ok, true, r.reason);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'nano');
  assert.deepEqual(spawned[0].args, ['-w', r.draftPath]);
  assert.notEqual(r.draftPath, w.policyPath);
  assert.equal(path.dirname(path.dirname(r.draftPath)), w.drafts);
  assert.deepEqual(fs.readFileSync(r.draftPath), fs.readFileSync(w.policyPath));
  // the policy and the host config are untouched
  const after = snapshot(w.root);
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], k);
  // no spawn given: refused, nothing spawned
  assert.throws(() => edit({ policyPath: w.policyPath, env: { EDITOR: 'vi' }, draftDir: w.drafts }), /spawn/);
});

// ---- fix round 1 -------------------------------------------------------------------------------

test('a current policy that does not load makes any apply weakening', async () => {
  // The schema accepts each of these current policies; the loader refuses them (an except kind the
  // match can not carry; a relative except glob that never matches a realpath; not JSON at all).
  // Fixing them in a draft moves from deny-everything to a working policy: never proven tightening.
  const exceptKind = {
    version: 1,
    rules: [{ id: 'net-del', decision: 'deny', match: { class: ['network-fetch', 'delete'] }, except: { paths: ['**/keep/**'] }, why: 'w' }],
  };
  const exceptKindFixed = clone(exceptKind);
  delete exceptKindFixed.rules[0].except;
  const relative = { version: 1, rules: [{ id: 'env', decision: 'deny', match: { paths: ['**/.env'] }, except: { paths: ['relative/x'] }, why: 'w' }] };
  const relativeFixed = clone(relative);
  delete relativeFixed.rules[0].except;
  const tighter = clone(BASE);
  tighter.rules.push(clone(NEW_DENY));
  const cases = [
    ['except kind', text(exceptKind), exceptKindFixed],
    ['relative except glob', text(relative), relativeFixed],
    ['not JSON', '{ "version": 1, ', tighter],
  ];
  for (const [label, currentText, draft] of cases) {
    // the classifier alone, given the parsed objects, would call the first two tightening
    if (label !== 'not JSON') assert.equal(classifyChange(JSON.parse(currentText), draft).weakening, false, label);
    const w = world();
    fs.writeFileSync(w.policyPath, currentText);
    const draftPath = w.draft(draft);
    assert.equal(applyFacts({ draftPath, policyPath: w.policyPath, home: w.home }).provenTightening, false, label);
    assert.equal(requiresGate('apply', applyFacts({ draftPath, policyPath: w.policyPath, home: w.home })), true, label);
    const h = hooks();
    const r = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
    assert.equal(r.ok, true, `${label}: ${r.reason}`);
    assert.equal(r.weakening, true, label);
    assert.ok(r.reasons.some((s) => /current policy/.test(s)), `${label}: ${r.reasons.join('\n')}`);
    assert.equal(h.calls.gate, 1, label);
    // without the gate it is refused
    fs.writeFileSync(w.policyPath, currentText);
    const refused = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, io: quiet().io });
    assert.equal(refused.ok, false, label);
    assert.equal(fs.readFileSync(w.policyPath, 'utf8'), currentText, label);
  }
});

test('apply writes through a symlinked policy path and keeps the link', async () => {
  const w = world();
  const real = path.join(w.home, 'dotfiles', 'policy.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.renameSync(w.policyPath, real);
  fs.symlinkSync(real, w.policyPath);
  const next = clone(BASE);
  next.rules.push(clone(NEW_DENY));
  const draftPath = w.draft(next);
  const h = hooks();
  const r = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.lstatSync(w.policyPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(w.policyPath), real);
  assert.deepEqual(fs.readFileSync(real), fs.readFileSync(draftPath));
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ['policy.json']);
  assert.deepEqual(fs.readdirSync(path.dirname(w.policyPath)), ['policy.json']);
  // a dangling link is refused, not replaced by a regular file
  fs.rmSync(real);
  const dangling = await apply({ draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(dangling.ok, false);
  assert.match(dangling.reason, /symlink/);
  assert.equal(fs.lstatSync(w.policyPath).isSymbolicLink(), true);
});

test('applyFacts reports an unreadable draft as weakening instead of throwing', () => {
  const w = world();
  const draftPath = w.draft(BASE);
  fs.chmodSync(draftPath, 0o000);
  try {
    const f = applyFacts({ draftPath, policyPath: w.policyPath, home: w.home });
    assert.equal(f.weakening, true);
    assert.equal(f.provenTightening, false);
    assert.match(f.error, /EACCES|read/);
    assert.equal(requiresGate('apply', f), true);
  } finally {
    fs.chmodSync(draftPath, 0o644);
  }
});

test('a successful apply removes the edit draft directory; a failed one keeps it', async () => {
  const w = world();
  // the fake editor writes a tightening change into the copy it was given
  const editTo = (policy) => (cmd, args) => (fs.writeFileSync(args[args.length - 1], text(policy)), { status: 0 });
  const tighter = clone(BASE);
  tighter.rules.push(clone(NEW_DENY));
  const e = edit({ policyPath: w.policyPath, env: { EDITOR: 'vi' }, spawn: editTo(tighter), draftDir: w.drafts });
  assert.equal(e.ok, true, e.reason);
  const h = hooks();
  const r = await apply({ draftPath: e.draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.existsSync(path.dirname(e.draftPath)), false);
  assert.deepEqual(fs.readdirSync(w.drafts), []);
  // a failing example: apply refuses and the draft stays for the human to fix
  const failing = clone(BASE);
  failing.rules.push({ ...clone(NEW_DENY), examples: { deny: [{ tool: 'Read', path: 'notes.txt' }] } });
  const e2 = edit({ policyPath: w.policyPath, env: { EDITOR: 'vi' }, spawn: editTo(failing), draftDir: w.drafts });
  const r2 = await apply({ draftPath: e2.draftPath, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(r2.ok, false);
  assert.equal(fs.existsSync(e2.draftPath), true);
  // a draft that edit did not make is never removed
  const plain = w.draft(tighter, 'plain.json');
  const r3 = await apply({ draftPath: plain, policyPath: w.policyPath, home: w.home, confirm: h.confirm, gate: h.gate, io: quiet().io });
  assert.equal(r3.ok, true, r3.reason);
  assert.equal(fs.existsSync(plain), true);
});
