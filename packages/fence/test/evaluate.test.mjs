import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluate } from '../src/eval/evaluate.mjs';
import { loadPolicy } from '../src/policy/load.mjs';
import { renderRules } from '../src/policy/render.mjs';
import { validatePolicy } from '../src/policy/schema.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// A fake home and project root that never touch the real file system: `noReal` makes every
// realpath lookup fail, so globs stay as written.
const HOME = '/home/tester';
const ROOT = '/work/repo';
const noReal = () => {
  throw new Error('ENOENT');
};
const CTX = { home: HOME, platform: 'linux', caseInsensitive: false, realpath: noReal };
const OPTS = { profile: 'default', grants: [], ctx: CTX };


function policy(rules, extra = {}) {
  return validatePolicy({
    version: 1,
    profiles: { default: { undecided: 'host' }, unattended: { undecided: 'deny' } },
    rules,
    ...extra,
  });
}

function rule(id, decision, match, more = {}) {
  return { id, decision, match, why: `why ${id}`, ...more };
}

// An effective command as the normalizer would produce it.
function cmd(argv, more = {}) {
  return {
    argv,
    cwd: ROOT,
    env: {},
    classes: [],
    reads: [],
    writes: [],
    domains: [],
    repo: { root: ROOT, branch: 'feature' },
    ops: [],
    ...more,
  };
}

const shell = (command, more = {}) => ({ host: 'claude', tool: 'Bash', kind: 'shell', cwd: ROOT, command, paths: [], ...more });
const file = (tool, p, access, more = {}) => ({ host: 'claude', tool, kind: 'file', cwd: ROOT, paths: [{ path: p, access }], ...more });
const run = (pol, call, normalized = null, opts = OPTS) => evaluate(pol, call, normalized, opts);

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-eval-')));
}

test('precedence: builtin beats deny beats allow beats undecided', () => {
  const pol = policy([
    rule('allow-all-writes', 'allow', { paths: ['/**'], access: 'write' }),
    rule('no-claude', 'deny', { paths: ['~/.claude/**'], access: 'any' }),
    rule('no-secret', 'deny', { paths: ['${repo}/secret.txt'], access: 'any' }),
  ]);
  const repo = { repo: { root: ROOT, branch: 'feature' } };
  const b = run(pol, file('Write', `${HOME}/.claude/settings.json`, 'write', repo));
  assert.equal(b.decision, 'deny');
  assert.equal(b.rule, 'builtin:self-protection');
  const d = run(pol, file('Write', `${ROOT}/secret.txt`, 'write', repo));
  assert.equal(d.decision, 'deny');
  assert.equal(d.rule, 'no-secret');
  assert.match(d.reason, /why no-secret/);
  const a = run(pol, file('Write', `${ROOT}/a.txt`, 'write', repo));
  assert.equal(a.decision, 'allow');
  assert.equal(a.rule, 'allow-all-writes');
  const u = run(pol, file('Read', '/tmp/x', 'read', repo));
  assert.equal(u.decision, 'undecided');
  assert.equal(u.rule, null);
  assert.equal(typeof u.reason, 'string');
});

test('opaque is always deny and names the construct', () => {
  const pol = policy([rule('everything', 'allow', { argv: [['f']] })]);
  const r = run(pol, shell('f() { rm -rf /; }; f'), { opaque: { reason: 'function definition', construct: 'f() {' } });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:opaque');
  assert.ok(r.reason.includes('f() {'));
  assert.ok(r.reason.includes('function definition'));
  // also with an empty policy and a malformed opaque payload
  const r2 = run(policy([]), shell('x'), { opaque: null });
  assert.equal(r2.decision, 'deny');
  // a self-protected path in the same call is still reported by its built-in rule first
  const r3 = run(policy([]), shell('x', { paths: [{ path: `${HOME}/.zshrc`, access: 'write' }] }), {
    opaque: { reason: 'r', construct: 'c' },
  });
  assert.equal(r3.rule, 'builtin:self-protection');
});

test('an allow rule never overrides a deny', () => {
  for (const order of ['allow-first', 'deny-first']) {
    const allow = rule('ok', 'allow', { argv: [['curl']] });
    const deny = rule('no-net', 'deny', { class: ['network-fetch'] });
    const pol = policy(order === 'allow-first' ? [allow, deny] : [deny, allow]);
    const r = run(pol, shell('curl https://example.com'), {
      commands: [cmd(['curl', 'https://example.com'], { classes: ['network-fetch'], domains: ['example.com'] })],
    });
    assert.equal(r.decision, 'deny', order);
    assert.equal(r.rule, 'no-net');
  }
});

test('an allow covers a call only when every part is matched by an allow', () => {
  const pol = policy([rule('repo-reads', 'allow', { paths: ['${repo}/**'], access: 'read' })]);
  const repo = { root: ROOT, branch: 'feature' };
  const two = {
    host: 'claude',
    tool: 'Artifact',
    kind: 'file',
    cwd: ROOT,
    repo,
    paths: [
      { path: `${ROOT}/a`, access: 'read' },
      { path: '/etc/hosts', access: 'read' },
    ],
  };
  assert.equal(run(pol, two).decision, 'undecided');
  two.paths[1].path = `${ROOT}/b`;
  assert.equal(run(pol, two).decision, 'allow');
  // a call with no parts is never covered (no vacuous allow)
  assert.equal(run(pol, { host: 'claude', tool: 'Skill', kind: 'other', cwd: ROOT, paths: [] }).decision, 'undecided');
  assert.equal(run(pol, shell(':'), { commands: [] }).decision, 'undecided');
  // a read-only allow does not cover a write to the same path
  assert.equal(run(pol, file('Write', `${ROOT}/a`, 'write', { repo })).decision, 'undecided');
  // a command part is covered only when all its paths are
  const c = cmd(['cat', `${ROOT}/a`, '/etc/hosts'], { reads: [`${ROOT}/a`, '/etc/hosts'] });
  const pol2 = policy([rule('cat-in-repo', 'allow', { argv: [['cat']], paths: ['${repo}/**'], access: 'read' })]);
  assert.equal(run(pol2, shell('cat a /etc/hosts'), { commands: [c] }).decision, 'undecided');
  c.reads = [`${ROOT}/a`];
  assert.equal(run(pol2, shell('cat a'), { commands: [c] }).decision, 'allow');
  // a part with no paths does not satisfy an allow `paths` predicate
  assert.equal(run(pol2, shell('cat'), { commands: [cmd(['cat'])] }).decision, 'undecided');
});

test('git status; rm -rf x with an allow on git status stays undecided or denied', () => {
  const normalized = {
    commands: [
      cmd(['git', 'status']),
      cmd(['rm', '-rf', 'x'], { classes: ['delete'], writes: [`${ROOT}/x`], ops: [{ path: `${ROOT}/x`, op: 'delete' }] }),
    ],
  };
  const allowOnly = policy([rule('git-status', 'allow', { argv: [['git', 'status']] })]);
  const r1 = run(allowOnly, shell('git status; rm -rf x'), normalized);
  assert.equal(r1.decision, 'undecided');
  const r1u = run(allowOnly, shell('git status; rm -rf x'), normalized, { ...OPTS, profile: 'unattended' });
  assert.equal(r1u.decision, 'deny');
  const withDeny = policy([
    rule('git-status', 'allow', { argv: [['git', 'status']] }),
    rule('no-delete', 'deny', { class: ['delete'] }),
  ]);
  const r2 = run(withDeny, shell('git status; rm -rf x'), normalized);
  assert.equal(r2.decision, 'deny');
  assert.equal(r2.rule, 'no-delete');
  // git status alone is allowed
  assert.equal(run(allowOnly, shell('git status'), { commands: [cmd(['git', 'status'])] }).decision, 'allow');
});

test('Unknown satisfies a deny path match and never an except', () => {
  const pol = policy([
    rule('creds', 'deny', { paths: ['**/.env'], access: 'any' }, { except: { paths: ['**/.env.example', '/**'] } }),
    rule('repo', 'allow', { paths: ['${repo}/**'], access: 'any' }),
  ]);
  const r = run(pol, shell('cat $F'), { commands: [cmd(['cat', UNKNOWN], { reads: [UNKNOWN] })] });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'creds');
  // a non-absolute or non-string path from the caller is read as Unknown
  assert.equal(run(pol, file('Read', 'relative/.env', 'read')).rule, 'creds');
  assert.equal(run(pol, file('Read', 42, 'read')).rule, 'creds');
  assert.equal(run(pol, { host: 'claude', tool: 'Read', kind: 'file', cwd: ROOT, paths: [{ access: 'read' }] }).rule, 'creds');
  // Unknown never satisfies an allow
  const allowOnly = policy([rule('repo', 'allow', { paths: ['/**'], access: 'any' })]);
  assert.equal(run(allowOnly, shell('cat $F'), { commands: [cmd(['cat', UNKNOWN], { reads: [UNKNOWN] })] }).decision, 'undecided');
  // Unknown argv words, domains and classes satisfy deny predicates and no allow predicate
  const argvDeny = policy([rule('no-rm', 'deny', { argv: [['rm', '-rf']] })]);
  assert.equal(run(argvDeny, shell('rm $X'), { commands: [cmd(['rm', UNKNOWN])] }).decision, 'deny');
  assert.equal(run(argvDeny, shell('$X'), { commands: [cmd([UNKNOWN, '-rf'])] }).decision, 'deny');
  assert.equal(run(argvDeny, shell('rm -i'), { commands: [cmd(['rm', '-i'])] }).decision, 'undecided');
  // a program named by path meets a deny on its name, but never an allow
  assert.equal(run(argvDeny, shell('/bin/rm -rf x'), { commands: [cmd(['/bin/rm', '-rf', 'x'])] }).decision, 'deny');
  const gitAllow = policy([rule('st', 'allow', { argv: [['git', 'status']] })]);
  assert.equal(run(gitAllow, shell('/tmp/git status'), { commands: [cmd(['/tmp/git', 'status'])] }).decision, 'undecided');
  // a caller path with a `.` or `..` segment is read as Unknown
  assert.equal(run(pol, file('Read', `${ROOT}/sub/../.env`, 'read')).rule, 'creds');
  assert.equal(run(allowOnly, file('Read', `${ROOT}/./a`, 'read')).decision, 'undecided');
  const argvAllow = policy([rule('st', 'allow', { argv: [['git', 'status']] })]);
  assert.equal(run(argvAllow, shell('git $X'), { commands: [cmd(['git', UNKNOWN])] }).decision, 'undecided');
  const domDeny = policy([rule('evil', 'deny', { domains: ['evil.example'] })]);
  assert.equal(
    run(domDeny, shell('curl $U'), { commands: [cmd(['curl', UNKNOWN], { classes: ['network-fetch'], domains: [UNKNOWN] })] }).decision,
    'deny',
  );
  const domAllow = policy([rule('good', 'allow', { domains: ['*'] })]);
  assert.equal(
    run(domAllow, shell('curl $U'), { commands: [cmd(['curl', UNKNOWN], { classes: ['network-fetch'], domains: [UNKNOWN] })] }).decision,
    'undecided',
  );
  const classDeny = policy([rule('no-del', 'deny', { class: ['delete'] })]);
  assert.equal(run(classDeny, shell('x'), { commands: [cmd(['x'], { classes: [UNKNOWN] })] }).decision, 'deny');
  assert.equal(run(classDeny, shell('x'), { commands: [cmd(['x'], { classes: 'delete' })] }).decision, 'deny');
  const classAllow = policy([rule('srch', 'allow', { class: ['search'] })]);
  assert.equal(run(classAllow, shell('grep'), { commands: [cmd(['grep'], { classes: ['search', UNKNOWN] })] }).decision, 'undecided');
  assert.equal(run(classAllow, shell('grep'), { commands: [cmd(['grep'], { classes: ['search'] })] }).decision, 'allow');
  // an allow `class` predicate never covers a part that also has another class
  assert.equal(
    run(classAllow, shell('find . -delete'), { commands: [cmd(['find', '.', '-delete'], { classes: ['search', 'delete'] })] }).decision,
    'undecided',
  );
  // an unknown access satisfies both a read and a write deny rule
  const writeDeny = policy([rule('w', 'deny', { paths: ['/etc/**'], access: 'write' })]);
  assert.equal(run(writeDeny, file('X', '/etc/hosts', 'weird')).decision, 'deny');
  assert.equal(run(writeDeny, file('Read', '/etc/hosts', 'read')).decision, 'undecided');
});

test('except removes only the excepted path', () => {
  const pol = policy([
    rule('creds', 'deny', { paths: ['**/.env', '**/.env.*'], access: 'any' }, { except: { paths: ['**/.env.example'] } }),
  ]);
  assert.equal(run(pol, file('Read', `${ROOT}/.env.example`, 'read')).decision, 'undecided');
  assert.equal(run(pol, file('Read', `${ROOT}/.env`, 'read')).rule, 'creds');
  assert.equal(run(pol, file('Read', `${ROOT}/.env.local`, 'read')).rule, 'creds');
  const both = cmd(['cat', '.env.example', '.env'], { reads: [`${ROOT}/.env.example`, `${ROOT}/.env`] });
  assert.equal(run(pol, shell('cat .env.example .env'), { commands: [both] }).rule, 'creds');
  const onlyExample = cmd(['cat', '.env.example'], { reads: [`${ROOT}/.env.example`] });
  assert.equal(run(pol, shell('cat .env.example'), { commands: [onlyExample] }).decision, 'undecided');
  // except.paths with no match.paths: the part is excused only when all its paths are excepted
  const del = policy([rule('del-outside', 'deny', { class: ['delete'] }, { except: { paths: ['${repo}/**'] } })]);
  const rm = (paths) => cmd(['rm', ...paths], { classes: ['delete'], writes: paths, ops: paths.map((p) => ({ path: p, op: 'delete' })) });
  assert.equal(run(del, shell('rm a'), { commands: [rm([`${ROOT}/a`])] }).decision, 'undecided');
  assert.equal(run(del, shell('rm a /tmp/b'), { commands: [rm([`${ROOT}/a`, '/tmp/b'])] }).rule, 'del-outside');
  // (an Unknown delete target is already denied by self-protection, before policy rules)
  assert.equal(run(del, shell('rm $X'), { commands: [rm([UNKNOWN])] }).decision, 'deny');
  const unknownRead = cmd(['shred'], { classes: ['delete'], reads: [UNKNOWN] });
  assert.equal(run(del, shell('shred $X'), { commands: [unknownRead] }).rule, 'del-outside');
  assert.equal(run(del, shell('rm'), { commands: [rm([])] }).rule, 'del-outside');
  // except domains removes only that domain
  const net = policy([rule('net', 'deny', { domains: ['*.example'] }, { except: { domains: ['ok.example'] } })]);
  const curl = (domains) => cmd(['curl'], { classes: ['network-fetch'], domains });
  assert.equal(run(net, shell('curl'), { commands: [curl(['ok.example'])] }).decision, 'undecided');
  assert.equal(run(net, shell('curl'), { commands: [curl(['ok.example', 'bad.example'])] }).rule, 'net');
  assert.equal(run(net, shell('curl'), { commands: [curl([UNKNOWN])] }).rule, 'net');
});

test('an unresolvable placeholder matches in a deny rule and in an allow rule except, never in an allow match or a deny rule except', () => {
  const noRepo = { repo: null };
  // deny with ${repo} and no repo for the part: matches (fail closed)
  const deny = policy([rule('repo-secret', 'deny', { paths: ['${repo}/secret'], access: 'any' })]);
  assert.equal(run(deny, file('Read', '/anywhere/x', 'read', noRepo)).rule, 'repo-secret');
  const denyCmd = cmd(['cat', '/x'], { reads: ['/x'], repo: null });
  assert.equal(run(deny, shell('cat /x'), { commands: [denyCmd] }).rule, 'repo-secret');
  // ${cwd} with no cwd: also matches
  const denyCwd = policy([rule('cwd-secret', 'deny', { paths: ['${cwd}/secret'], access: 'any' })]);
  assert.equal(run(denyCwd, { ...file('Read', '/x', 'read'), cwd: undefined }).rule, 'cwd-secret');
  // allow with ${repo} and no repo: never matches
  const allow = policy([rule('repo-reads', 'allow', { paths: ['${repo}/**'], access: 'any' })]);
  assert.equal(run(allow, file('Read', '/anywhere/x', 'read', noRepo)).decision, 'undecided');
  assert.equal(run(allow, file('Read', '/work/repo/x', 'read', { repo: { root: ROOT, branch: null } })).decision, 'allow');
  // a deny rule's except with ${repo} and no repo never matches: the deny stays
  const denyExcept = policy([rule('d', 'deny', { paths: ['/**'], access: 'any' }, { except: { paths: ['${repo}/**'] } })]);
  assert.equal(run(denyExcept, file('Read', '/anywhere/x', 'read', noRepo)).rule, 'd');
  assert.equal(run(denyExcept, file('Read', `${ROOT}/x`, 'read', { repo: { root: ROOT, branch: null } })).decision, 'undecided');
  // an allow rule's except with ${repo} and no repo can not be ruled out: no allow
  const allowExcept = policy([rule('a', 'allow', { paths: ['/**'], access: 'any' }, { except: { paths: ['${repo}/**'] } })]);
  assert.equal(run(allowExcept, file('Read', '/anywhere/x', 'read', noRepo)).decision, 'undecided');
  assert.equal(run(allowExcept, file('Read', '/anywhere/x', 'read', { repo: { root: ROOT, branch: null } })).decision, 'allow');
});

test('profile unattended turns undecided into deny and default leaves host', () => {
  const pol = policy([rule('ok', 'allow', { paths: ['/ok/**'], access: 'any' })]);
  const u = run(pol, file('Read', '/tmp/x', 'read'));
  assert.equal(u.decision, 'undecided');
  const d = run(pol, file('Read', '/tmp/x', 'read'), null, { ...OPTS, profile: 'unattended' });
  assert.equal(d.decision, 'deny');
  assert.match(d.rule, /^builtin:/);
  assert.ok(d.reason.includes('unattended'));
  // the profile never changes an allow
  assert.equal(run(pol, file('Read', '/ok/x', 'read'), null, { ...OPTS, profile: 'unattended' }).decision, 'allow');
  // a missing profile option means default
  assert.equal(run(pol, file('Read', '/tmp/x', 'read'), null, { grants: [], ctx: CTX }).decision, 'undecided');
});

test('bypassPermissions does not force deny under the default profile', () => {
  const pol = policy([]);
  const r = run(pol, file('Read', '/tmp/x', 'read', { permission_mode: 'bypassPermissions' }));
  assert.equal(r.decision, 'undecided');
  const s = run(pol, shell('ls', { permission_mode: 'bypassPermissions' }), { commands: [cmd(['ls'])] });
  assert.equal(s.decision, 'undecided');
});

test('an unknown profile name denies with the name in the reason', () => {
  const pol = policy([rule('ok', 'allow', { paths: ['/**'], access: 'any' })]);
  const r = run(pol, file('Read', '/tmp/x', 'read'), null, { ...OPTS, profile: 'nightly' });
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes('nightly'));
  assert.equal(run(pol, file('Read', '/tmp/x', 'read'), null, { ...OPTS, profile: '__proto__' }).decision, 'deny');
  assert.equal(run(pol, file('Read', '/tmp/x', 'read'), null, { ...OPTS, profile: 7 }).decision, 'deny');
});

test('protected branch denies vcs-write on main but not on a feature branch', () => {
  const pol = policy([rule('commit-ok', 'allow', { class: ['vcs-write'] })]);
  const commit = (branch, more = {}) => ({
    commands: [cmd(['git', 'commit', '-m', 'x'], { classes: ['vcs-write'], repo: { root: ROOT, branch }, ...more })],
  });
  const r = run(pol, shell('git commit -m x'), commit('main'));
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:protected-branch');
  assert.ok(r.reason.includes('main'));
  assert.ok(r.reason.includes('master'));
  assert.ok(r.reason.includes('develop'));
  assert.equal(run(pol, shell('git commit -m x'), commit('feature')).decision, 'allow');
  // an Unknown branch counts as protected; a detached HEAD (null) does not
  assert.equal(run(pol, shell('git commit'), commit(UNKNOWN)).rule, 'builtin:protected-branch');
  assert.equal(run(pol, shell('git commit'), commit(null)).decision, 'allow');
  // an Unknown repo counts as protected too; no repo at all does not
  assert.equal(run(pol, shell('git commit'), commit('x', { repo: UNKNOWN })).rule, 'builtin:protected-branch');
  assert.equal(run(pol, shell('git commit'), commit('x', { repo: null })).decision, 'allow');
  // an Unknown class may be vcs-write
  const unk = { commands: [cmd(['git', UNKNOWN], { classes: [UNKNOWN], repo: { root: ROOT, branch: 'main' } })] };
  assert.equal(run(policy([]), shell('git $X'), unk).rule, 'builtin:protected-branch');
  // the protected list comes from the policy
  const custom = policy([rule('commit-ok', 'allow', { class: ['vcs-write'] })], { branches: { protected: ['release'] } });
  assert.equal(run(custom, shell('git commit'), commit('main')).decision, 'allow');
  assert.equal(run(custom, shell('git commit'), commit('release')).rule, 'builtin:protected-branch');
});

test('denyFileWrites false allows a file write on main, true denies it', () => {
  const rules = [rule('repo-writes', 'allow', { paths: ['${repo}/**'], access: 'any' })];
  const onMain = { repo: { root: ROOT, branch: 'main' } };
  const off = policy(rules, { branches: { denyFileWrites: false } });
  const on = policy(rules, { branches: { denyFileWrites: true } });
  assert.equal(run(off, file('Write', `${ROOT}/a.txt`, 'write', onMain)).decision, 'allow');
  const r = run(on, file('Write', `${ROOT}/a.txt`, 'write', onMain));
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:protected-branch');
  assert.ok(r.reason.includes('main'));
  // reads, writes outside the repo and writes on a feature branch are not affected
  assert.equal(run(on, file('Read', `${ROOT}/a.txt`, 'read', onMain)).decision, 'allow');
  assert.equal(run(on, file('Write', '/tmp/a.txt', 'write', onMain)).decision, 'undecided');
  assert.equal(run(on, file('Write', `${ROOT}/a.txt`, 'write', { repo: { root: ROOT, branch: 'feature' } })).decision, 'allow');
  // per-path repo wins over the call's repo
  const perPath = file('Write', `${ROOT}/a.txt`, 'write', { repo: { root: ROOT, branch: 'feature' } });
  perPath.paths[0].repo = { root: ROOT, branch: 'main' };
  assert.equal(run(on, perPath).rule, 'builtin:protected-branch');
  // shell writes inside the repo, and Unknown write targets
  const sh = (writes, branch = 'main') => ({ commands: [cmd(['tee'], { writes, repo: { root: ROOT, branch } })] });
  assert.equal(run(on, shell('tee a'), sh([`${ROOT}/a`])).rule, 'builtin:protected-branch');
  assert.equal(run(on, shell('tee $X'), sh([UNKNOWN])).decision, 'deny');
  assert.equal(run(off, shell('tee a'), sh([`${ROOT}/a`])).decision, 'allow');
  assert.equal(run(on, shell('tee a'), sh([`${ROOT}/a`], 'feature')).decision, 'allow');
});

test('a valid grant turns a builtin deny on that one path into allow and never a policy deny', () => {
  const settings = `${HOME}/.claude/settings.json`;
  const withGrant = { ...OPTS, grants: [{ path: settings }] };
  const r = run(policy([]), file('Write', settings, 'write'), null, withGrant);
  assert.equal(r.decision, 'allow');
  assert.equal(r.rule, 'grant');
  // under every profile
  const unattended = { ...withGrant, profile: 'unattended' };
  const ru = run(policy([]), file('Write', settings, 'write'), null, unattended);
  assert.equal(ru.decision, 'allow');
  assert.equal(ru.rule, 'grant');
  // another protected path is still denied
  assert.equal(run(policy([]), file('Write', `${HOME}/.claude/settings.local.json`, 'write'), null, withGrant).rule, 'builtin:self-protection');
  // a call that writes the granted path and another protected path is denied
  const twoPaths = file('Write', settings, 'write');
  twoPaths.paths.push({ path: `${HOME}/.zshrc`, access: 'write' });
  assert.equal(run(policy([]), twoPaths, null, withGrant).rule, 'builtin:self-protection');
  // a policy deny is never lifted
  const deny = policy([rule('no-claude', 'deny', { paths: ['~/.claude/**'], access: 'any' })]);
  assert.equal(run(deny, file('Write', settings, 'write'), null, withGrant).rule, 'no-claude');
  // an opaque verdict is never lifted
  assert.equal(run(policy([]), shell('x', { paths: [{ path: settings, access: 'write' }] }), { opaque: { reason: 'r', construct: 'c' } }, withGrant).rule, 'builtin:opaque');
  // a shell command whose only effect is the granted write is allowed, under every profile
  const sh = { commands: [cmd(['tee', settings], { classes: ['overwrite'], writes: [settings] })] };
  const rs = run(policy([]), shell('tee'), sh, withGrant);
  assert.equal(rs.decision, 'allow');
  assert.equal(rs.rule, 'grant');
  assert.equal(run(policy([]), shell('tee'), sh, unattended).rule, 'grant');
  assert.equal(run(policy([]), shell('tee'), sh).rule, 'builtin:self-protection');
  // a command with other effects keeps only the self-protection deny lifted: its read is still judged
  const cp = { commands: [cmd(['cp', '/tmp/src', settings], { reads: ['/tmp/src'], writes: [settings] })] };
  assert.equal(run(policy([]), shell('cp'), cp, withGrant).decision, 'undecided');
  assert.equal(run(policy([]), shell('cp'), cp, unattended).decision, 'deny');
  // a call with the granted write and another uncovered part is not allowed by the grant
  const mixed = file('Write', settings, 'write');
  mixed.paths.push({ path: '/tmp/other', access: 'write' });
  assert.equal(run(policy([]), mixed, null, withGrant).decision, 'undecided');
  // a protected command is never lifted
  assert.equal(run(policy([]), shell('fence install'), { commands: [cmd(['fence', 'install'])] }, withGrant).rule, 'builtin:fence-command');
  // malformed grants do nothing
  assert.equal(run(policy([]), file('Write', settings, 'write'), null, { ...OPTS, grants: [null, { path: 3 }, 'x'] }).decision, 'deny');
  assert.equal(run(policy([]), file('Write', settings, 'write'), null, { ...OPTS, grants: 'nope' }).decision, 'deny');
});

test('lifted lists each path a grant lifted, with its grant, on a non-deny decision only', () => {
  const settings = `${HOME}/.claude/settings.json`;
  const grant = { path: settings, sha: 'a'.repeat(64) };
  const withGrant = { ...OPTS, grants: [grant] };
  const r = run(policy([]), file('Write', settings, 'write'), null, withGrant);
  assert.equal(r.rule, 'grant');
  assert.deepEqual(r.lifted, [{ path: settings, grant }]);
  assert.equal(r.lifted[0].grant, grant);
  // the same path written by two parts is listed once
  const sh = { commands: [cmd(['tee', settings], { classes: ['overwrite'], writes: [settings] }), cmd(['tee', settings], { classes: ['overwrite'], writes: [settings] })] };
  assert.equal(run(policy([]), shell('tee'), sh, withGrant).lifted.length, 1);
  // an undecided call that a grant made possible lists it too
  const cp = { commands: [cmd(['cp', '/tmp/src', settings], { reads: ['/tmp/src'], writes: [settings] })] };
  const u = run(policy([]), shell('cp'), cp, withGrant);
  assert.equal(u.decision, 'undecided');
  assert.deepEqual(u.lifted, [{ path: settings, grant }]);
  // a deny never carries lifted, nor does a call no grant took part in
  const deny = policy([rule('no-claude', 'deny', { paths: ['~/.claude/**'], access: 'any' })]);
  assert.equal(run(deny, file('Write', settings, 'write'), null, withGrant).lifted, undefined);
  assert.equal(run(policy([]), file('Write', '/tmp/x', 'write'), null, withGrant).lifted, undefined);
  // on a case-insensitive volume grants match with the resolver's full fold (foldCase)
  const ci = { ...withGrant, ctx: { ...CTX, caseInsensitive: true } };
  const upper = `${HOME}/.claude/SETTINGS.json`;
  assert.deepEqual(run(policy([]), file('Write', upper, 'write'), null, ci).lifted, [{ path: upper, grant }]);
  const sharp = { path: `${HOME}/.claude/settingsß.json` };
  const ciSharp = { ...OPTS, grants: [sharp], ctx: { ...CTX, caseInsensitive: true } };
  // foldCase: ß -> ss, so a grant for settingsß.json lifts settingsSS.json ...
  assert.equal(run(policy([]), file('Write', `${HOME}/.claude/settingsSS.json`, 'write'), null, ciSharp).rule, 'grant');
  // ... while ẞ folds to ß (not ss): no lift, the deny stays
  assert.equal(run(policy([]), file('Write', `${HOME}/.claude/settingsẞ.json`, 'write'), null, ciSharp).rule, 'builtin:self-protection');
});

test('builtin checks cover shell writes, ancestor operations and protected commands', () => {
  const pol = policy([rule('all', 'allow', { argv: [['rm'], ['claude'], ['tee']] })]);
  const rmClaude = cmd(['rm', '-rf', `${HOME}/.claude`], { classes: ['delete'], writes: [`${HOME}/.claude`], ops: [{ path: `${HOME}/.claude`, op: 'delete' }] });
  assert.equal(run(pol, shell('rm -rf ~/.claude'), { commands: [rmClaude] }).rule, 'builtin:self-protection');
  const opOnly = cmd(['rm', '-rf', HOME], { classes: ['delete'], ops: [{ path: HOME, op: 'delete' }] });
  assert.equal(run(pol, shell('rm -rf ~'), { commands: [opOnly] }).rule, 'builtin:self-protection');
  const badOp = cmd(['rm'], { ops: [{ path: '/tmp/x', op: 'explode' }] });
  assert.equal(run(pol, shell('rm'), { commands: [badOp] }).decision, 'deny');
  assert.equal(run(pol, shell('claude plugin disable fence'), { commands: [cmd(['claude', 'plugin', 'disable', 'fence'])] }).rule, 'builtin:host-config');
  // a project .claude/settings.json under the part's repo root is protected
  const proj = cmd(['tee', `${ROOT}/.claude/settings.json`], { writes: [`${ROOT}/.claude/settings.json`] });
  assert.equal(run(pol, shell('tee'), { commands: [proj] }).rule, 'builtin:self-protection');
  // an Unknown write target is denied by self-protection
  assert.equal(run(pol, shell('tee $X'), { commands: [cmd(['tee', UNKNOWN], { writes: [UNKNOWN] })] }).rule, 'builtin:self-protection');
});

test('a shell call without a normalized reading is denied', () => {
  const r = run(policy([]), shell('ls'), null);
  assert.equal(r.decision, 'deny');
  assert.match(r.rule, /^builtin:/);
});

test('evaluate never throws and fails closed on malformed input', () => {
  const bad = [
    [null, file('Read', '/x', 'read'), null],
    [policy([]), null, null],
    [policy([]), shell('x'), { commands: 'nope' }],
    [policy([]), shell('x'), { commands: [null] }],
    [policy([]), shell('x'), { commands: [{ argv: 'ls' }] }],
    [policy([]), shell('x'), 'weird'],
    [policy([]), { ...file('Read', '/x', 'read'), paths: 'nope' }, null],
  ];
  for (const [pol, call, norm] of bad) {
    const r = evaluate(pol, call, norm, OPTS);
    assert.equal(r.decision, 'deny', JSON.stringify(call));
    assert.match(r.rule, /^builtin:/);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.scope && typeof r.scope === 'object');
  }
  const r = evaluate(policy([]), file('Read', '/x', 'read'), null, undefined);
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:internal-error');
});

test('case-insensitive volumes fold both the path and the policy glob', () => {
  const pol = policy([rule('creds', 'deny', { paths: ['**/.env'], access: 'any' })]);
  const ci = { ...OPTS, ctx: { ...CTX, caseInsensitive: true } };
  assert.equal(run(pol, file('Read', `${ROOT}/.ENV`, 'read'), null, ci).rule, 'creds');
  assert.equal(run(pol, file('Read', `${ROOT}/.ENV`, 'read')).decision, 'undecided');
  const pol2 = policy([rule('creds2', 'deny', { paths: ['/Work/REPO/secret'], access: 'any' })]);
  assert.equal(run(pol2, file('Read', `${ROOT}/secret`, 'read'), null, ci).rule, 'creds2');
});

test('mcp tools and fetched URLs are parts', () => {
  const pol = policy([
    rule('evil-mcp', 'deny', { mcp: ['mcp__evil__*'] }),
    rule('docs', 'allow', { domains: ['docs.example'] }),
    rule('bad-host', 'deny', { domains: ['bad.example'] }),
    rule('ok-mcp', 'allow', { mcp: ['mcp__good__*'] }),
  ]);
  const mcp = (name) => ({ host: 'claude', tool: name, kind: 'mcp', cwd: ROOT, paths: [], mcp: name });
  assert.equal(run(pol, mcp('mcp__evil__run')).rule, 'evil-mcp');
  assert.equal(run(pol, mcp('mcp__good__read')).decision, 'allow');
  assert.equal(run(pol, mcp('mcp__other__x')).decision, 'undecided');
  assert.equal(run(pol, { ...mcp('x'), mcp: 42 }).rule, 'evil-mcp');
  const fetch = (url) => ({ host: 'claude', tool: 'WebFetch', kind: 'fetch', cwd: ROOT, paths: [], url });
  assert.equal(run(pol, fetch('https://docs.example/page')).decision, 'allow');
  assert.equal(run(pol, fetch('https://BAD.example:8443/x')).rule, 'bad-host');
  assert.equal(run(pol, fetch('https://user@bad.example/x')).rule, 'bad-host');
  // a trailing dot does not dodge a domain deny
  assert.equal(run(pol, fetch('https://bad.example./x')).rule, 'bad-host');
  // an IPv6 literal is an Unknown domain
  assert.equal(run(pol, fetch('http://[::1]/x')).rule, 'bad-host');
  // an unparseable URL is an Unknown domain: denied by a domain deny, never allowed
  assert.equal(run(pol, fetch('not a url')).rule, 'bad-host');
  const allowOnly = policy([rule('docs', 'allow', { domains: ['*'] })]);
  assert.equal(run(allowOnly, fetch('::::')).decision, 'undecided');
});

test('scope lists written files, deleted files, domains and vcs ops', () => {
  const normalized = {
    commands: [
      cmd(['rm', 'a'], { classes: ['delete'], writes: [`${ROOT}/a`], ops: [{ path: `${ROOT}/a`, op: 'delete' }] }),
      cmd(['tee', 'b'], { classes: ['overwrite'], writes: [`${ROOT}/b`, UNKNOWN], reads: [`${ROOT}/r`] }),
      cmd(['curl', 'https://example.com'], { classes: ['network-fetch'], domains: ['example.com'] }),
      cmd(['git', '-C', ROOT, 'commit', '-m', 'msg'], { classes: ['vcs-write'] }),
      cmd(['make'], { classes: ['runs-repo-code'] }),
    ],
  };
  const r = run(policy([]), shell('...'), normalized);
  assert.deepEqual(r.scope.deletes, [`${ROOT}/a`]);
  assert.ok(r.scope.writes.includes(`${ROOT}/a`));
  assert.ok(r.scope.writes.includes(`${ROOT}/b`));
  assert.ok(r.scope.writes.includes('<unknown>'));
  assert.deepEqual(r.scope.reads, [`${ROOT}/r`]);
  assert.deepEqual(r.scope.domains, ['example.com']);
  assert.deepEqual(r.scope.vcs, ['git commit']);
  assert.equal(r.scope.runsRepoCode, true);
  const f = run(policy([]), file('Write', `${ROOT}/w`, 'write'));
  assert.deepEqual(f.scope.writes, [`${ROOT}/w`]);
  assert.equal(f.scope.runsRepoCode, false);
  const m = run(policy([]), { host: 'claude', tool: 'mcp__s__t', kind: 'mcp', cwd: ROOT, paths: [], mcp: 'mcp__s__t' });
  assert.deepEqual(m.scope.mcp, ['mcp__s__t']);
  const w = run(policy([]), { host: 'claude', tool: 'WebFetch', kind: 'fetch', cwd: ROOT, paths: [], url: 'https://x.example/a' });
  assert.deepEqual(w.scope.domains, ['x.example']);
  // a deny still reports its scope
  const d = run(policy([rule('no-del', 'deny', { class: ['delete'] })]), shell('rm a'), { commands: [normalized.commands[0]] });
  assert.equal(d.decision, 'deny');
  assert.deepEqual(d.scope.deletes, [`${ROOT}/a`]);
});

test('renderRules emits id: decision summary — why and shortens the longest why first', () => {
  const pol = policy([
    rule('creds', 'deny', { paths: ['**/.env'], access: 'any' }, { except: { paths: ['**/.env.example'] }, why: 'Short why.' }),
    rule('net', 'allow', { class: ['network-fetch'], domains: ['docs.example'] }, { why: 'x'.repeat(500) }),
  ]);
  const full = renderRules(pol);
  const lines = full.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^creds: deny .*\*\*\/\.env.* — Short why\.$/);
  assert.ok(lines[0].includes('except'));
  assert.match(lines[1], /^net: allow .*network-fetch.*docs\.example.* — x+$/);
  const short = renderRules(pol, 200);
  assert.ok(short.length <= 200, `${short.length}`);
  assert.ok(short.includes('— Short why.'), 'the shorter why is kept');
  assert.ok(short.includes('…'));
  const tiny = renderRules(pol, 20);
  assert.ok(tiny.length <= 20);
});

// ---- loader -------------------------------------------------------------------------------------

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

function writePolicy(dir, text, name = 'policy.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

test('loadPolicy returns a stable sha', () => {
  const dir = tmpDir();
  const p = writePolicy(dir, SPEC_EXAMPLE);
  const a = loadPolicy(p, { mode: 'user', home: HOME });
  const b = loadPolicy(p, { mode: 'user', home: HOME });
  assert.equal(a.sha, b.sha);
  assert.equal(a.sha, createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  assert.equal(a.policy.rules[0].id, 'credentials');
  fs.writeFileSync(p, SPEC_EXAMPLE + '\n');
  assert.notEqual(loadPolicy(p, { mode: 'user', home: HOME }).sha, a.sha);
});

test("loadPolicy realpath-resolves each glob's literal prefix", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  const text = JSON.stringify({
    version: 1,
    rules: [
      { id: 'linked', decision: 'deny', match: { paths: [`${dir}/link/**`] }, why: 'w' },
      { id: 'home', decision: 'deny', match: { paths: ['~/secrets/*'] }, why: 'w' },
      { id: 'repo', decision: 'allow', match: { paths: ['${repo}/**'] }, why: 'w' },
    ],
  });
  const p = writePolicy(dir, text);
  const { policy: pol } = loadPolicy(p, { mode: 'user', home: dir });
  assert.ok(pol.rules[0].match.paths.includes(`${dir}/real/**`), JSON.stringify(pol.rules[0].match.paths));
  assert.ok(pol.rules[1].match.paths.includes(`${dir}/secrets/*`), JSON.stringify(pol.rules[1].match.paths));
  // placeholders other than ~ are resolved per call, not at load
  assert.deepEqual(pol.rules[2].match.paths, ['${repo}/**']);
  // a call on the realpath meets the rule written with the symlink
  const ctx = { home: dir, platform: process.platform, caseInsensitive: false };
  const r = evaluate(pol, file('Read', `${dir}/real/x`, 'read'), null, { profile: 'default', grants: [], ctx });
  assert.equal(r.rule, 'linked');
  // ${repo} with a symlinked repo root resolves per call
  const r2 = evaluate(pol, file('Read', `${dir}/real/y`, 'read', { repo: { root: `${dir}/link`, branch: null } }), null, {
    profile: 'default',
    grants: [],
    ctx,
  });
  assert.equal(r2.rule, 'linked');
  const allowOnly = policy([rule('repo', 'allow', { paths: ['${repo}/**'], access: 'any' })]);
  const r3 = evaluate(allowOnly, file('Read', `${dir}/real/y`, 'read', { repo: { root: `${dir}/link`, branch: null } }), null, {
    profile: 'default',
    grants: [],
    ctx,
  });
  assert.equal(r3.decision, 'allow');
});

test('loadPolicy rejects globs the matcher cannot use and names the file and pointer', () => {
  const dir = tmpDir();
  const cases = [
    [{ paths: ['/a/[z-a]'] }, '/rules/0/match/paths/0'],
    [{ paths: ['~/./x'] }, '/rules/0/match/paths/0'],
    [{ paths: ['${repo}/../x'] }, '/rules/0/match/paths/0'],
    [{ paths: ['/a/b/..'] }, '/rules/0/match/paths/0'],
    [{ mcp: ['mcp__[z-a]'] }, '/rules/0/match/mcp/0'],
    [{ domains: ['[9-0].example'] }, '/rules/0/match/domains/0'],
  ];
  for (const [match, pointer] of cases) {
    const p = writePolicy(dir, JSON.stringify({ version: 1, rules: [{ id: 'r', decision: 'deny', match, why: 'w' }] }));
    assert.throws(
      () => loadPolicy(p, { mode: 'user', home: HOME }),
      (err) => err.name === 'PolicyError' && err.code === 'glob' && err.pointer === pointer && err.path === p,
      JSON.stringify(match),
    );
  }
  const exc = writePolicy(
    dir,
    JSON.stringify({ version: 1, rules: [{ id: 'r', decision: 'deny', match: { class: ['delete'] }, except: { paths: ['/x/./y'] }, why: 'w' }] }),
  );
  assert.throws(() => loadPolicy(exc, { mode: 'user', home: HOME }), (err) => err.code === 'glob' && err.pointer === '/rules/0/except/paths/0');
  // parse, schema and read errors carry the path too
  const bad = writePolicy(dir, '{"version": 1, "rules": [],}');
  assert.throws(() => loadPolicy(bad, { mode: 'user', home: HOME }), (err) => err.code === 'syntax' && err.path === bad);
  const schema = writePolicy(dir, '{"version": 1, "rules": [{"id": "r", "decision": "deny", "match": {"class": ["delete"]}}]}');
  assert.throws(() => loadPolicy(schema, { mode: 'user', home: HOME }), (err) => err.code === 'missing-key' && err.pointer === '/rules/0/why' && err.path === schema);
  const missing = path.join(dir, 'missing.json');
  assert.throws(() => loadPolicy(missing, { mode: 'user', home: HOME }), (err) => err.name === 'PolicyError' && err.code === 'read' && err.path === missing);
  const latin = path.join(dir, 'latin.json');
  fs.writeFileSync(latin, Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d]));
  assert.throws(() => loadPolicy(latin, { mode: 'user', home: HOME }), (err) => err.code === 'syntax' && err.path === latin);
  assert.throws(() => loadPolicy(writePolicy(dir, SPEC_EXAMPLE), { mode: 'other', home: HOME }), (err) => err.name === 'PolicyError');
});

test('locked mode refuses a user-writable policy', () => {
  const dir = tmpDir();
  const p = writePolicy(dir, SPEC_EXAMPLE);
  assert.throws(
    () => loadPolicy(p, { mode: 'locked', home: HOME }),
    (err) => err.name === 'PolicyError' && err.code === 'writable' && err.path === p,
  );
  // a root-owned, non-group/world-writable file in a root-owned directory loads
  const stat = (mode, uid = 0) => ({ uid, mode, isFile: () => mode & 0o100000, isDirectory: () => !(mode & 0o100000) });
  const fakeFs = (fileStat, dirStat) => ({
    readFileSync: fs.readFileSync,
    realpathSync: Object.assign((x) => x, { native: (x) => x }),
    statSync: (x) => (x === p ? fileStat : dirStat),
  });
  const ok = loadPolicy(p, { mode: 'locked', home: HOME, fs: fakeFs(stat(0o100644), stat(0o040755)) });
  assert.equal(ok.policy.rules[0].id, 'credentials');
  for (const [fileStat, dirStat] of [
    [stat(0o100664), stat(0o040755)],
    [stat(0o100646), stat(0o040755)],
    [stat(0o100644, 501), stat(0o040755)],
    [stat(0o100644), stat(0o040775)],
    [stat(0o100644), stat(0o040755, 501)],
  ]) {
    assert.throws(() => loadPolicy(p, { mode: 'locked', home: HOME, fs: fakeFs(fileStat, dirStat) }), (err) => err.code === 'writable');
  }
});

test('an allow covers a part only when it judges every effect of the part', () => {
  const R = (match) => policy([rule('a', 'allow', match)]);
  const one = (pol, c) => run(pol, shell('...'), { commands: [c] }).decision;
  // any Unknown effect blocks coverage
  assert.equal(one(R({ argv: [['cat']] }), cmd(['cat', UNKNOWN], { reads: [UNKNOWN] })), 'undecided');
  assert.equal(one(R({ argv: [['cat']], paths: ['/**'] }), cmd(['cat', 'x'], { reads: [UNKNOWN] })), 'undecided');
  assert.equal(one(R({ argv: [['curl']], class: ['network-fetch'], domains: ['*'] }), cmd(['curl', 'u'], { classes: ['network-fetch'], domains: [UNKNOWN] })), 'undecided');
  // path effects need a paths key matching all of them
  const grepWrite = cmd(['grep', 'x'], { classes: ['search'], writes: [`${ROOT}/src/app.js`] });
  assert.equal(one(R({ class: ['search'] }), grepWrite), 'undecided');
  assert.equal(one(R({ class: ['search'], paths: ['${repo}/**'], access: 'any' }), grepWrite), 'allow');
  assert.equal(one(R({ class: ['search'], paths: ['${repo}/**'], access: 'read' }), grepWrite), 'undecided');
  assert.equal(one(R({ argv: [['cat']] }), cmd(['cat', 'a'], { reads: [`${ROOT}/a`] })), 'undecided');
  // a part with no path effects needs no paths key
  assert.equal(one(R({ argv: [['git', 'status']] }), cmd(['git', 'status'])), 'allow');
  // domains need a domains key
  const curl = cmd(['curl', 'https://x.example'], { classes: ['network-fetch'], domains: ['x.example'] });
  assert.equal(one(R({ class: ['network-fetch'] }), curl), 'undecided');
  assert.equal(one(R({ class: ['network-fetch'], domains: ['x.example'] }), curl), 'allow');
  // classes: each needs an explicit class entry, except that an argv match covers
  // runs-repo-code, package-install and search
  const repoReads = R({ paths: ['${repo}/**'], access: 'read' });
  assert.equal(one(repoReads, cmd(['python', 'tests/evil.py'], { classes: ['runs-repo-code'], reads: [`${ROOT}/tests/evil.py`] })), 'undecided');
  assert.equal(one(repoReads, cmd(['sudo', 'cat', 'a'], { classes: ['privilege'], reads: [`${ROOT}/a`] })), 'undecided');
  assert.equal(one(repoReads, cmd(['cat', 'a'], { reads: [`${ROOT}/a`] })), 'allow');
  const npmTest = cmd(['npm', 'test'], { classes: ['runs-repo-code'] });
  assert.equal(one(R({ argv: [['npm', 'test']] }), npmTest), 'allow');
  assert.equal(one(R({ argv: [['npm', 'ci']] }), cmd(['npm', 'ci'], { classes: ['package-install', 'runs-repo-code'] })), 'allow');
  assert.equal(one(R({ argv: [['grep']] }), cmd(['grep', 'x'], { classes: ['search'] })), 'allow');
  for (const cls of ['privilege', 'perm-change', 'delete', 'overwrite', 'vcs-write', 'env-dump', 'network-fetch']) {
    assert.equal(one(R({ argv: [['p']] }), cmd(['p'], { classes: [cls] })), 'undecided', cls);
    assert.equal(one(R({ argv: [['p']], class: [cls] }), cmd(['p'], { classes: [cls] })), 'allow', cls);
  }
  // a class key must hold: no listed class on the part, no coverage
  assert.equal(one(R({ class: ['search'] }), cmd(['ls'])), 'undecided');
  // file, fetch and mcp parts need the matching key
  assert.equal(run(R({ argv: [['x']] }), file('Read', `${ROOT}/a`, 'read')).decision, 'undecided');
  assert.equal(run(R({ paths: ['/**'] }), { host: 'claude', tool: 'mcp__s__t', kind: 'mcp', cwd: ROOT, paths: [], mcp: 'mcp__s__t' }).decision, 'undecided');
  assert.equal(run(R({ paths: ['/**'] }), { host: 'claude', tool: 'WebFetch', kind: 'fetch', cwd: ROOT, paths: [], url: 'https://x.example/' }).decision, 'undecided');
});

test('an Unknown word inside a deny argv prefix matches the rest of the prefix', () => {
  const D = (prefix) => policy([rule('d', 'deny', { argv: [prefix] })]);
  const one = (pol, argv) => run(pol, shell('...'), { commands: [cmd(argv)] }).decision;
  assert.equal(one(D(['git', 'push', '--force']), ['git', UNKNOWN]), 'deny');
  assert.equal(one(D(['rm', '-r', '-f']), ['rm', UNKNOWN]), 'deny');
  assert.equal(one(D(['rm', '-r', '-f']), [UNKNOWN]), 'deny');
  assert.equal(one(D(['git', 'push', '--force']), ['git', 'push', UNKNOWN]), 'deny');
  // known words that differ before the Unknown do not match
  assert.equal(one(D(['git', 'push', '--force']), ['git', 'status', UNKNOWN]), 'undecided');
  // a known argv shorter than the prefix does not match
  assert.equal(one(D(['git', 'push', '--force']), ['git', 'push']), 'undecided');
  // allow prefixes keep requiring exact known words
  const A = policy([rule('a', 'allow', { argv: [['git', 'status']] })]);
  assert.equal(one(A, ['git', UNKNOWN]), 'undecided');
});

test('loadPolicy rejects relative, empty-segment and trailing-slash path globs', () => {
  const dir = tmpDir();
  const load = (match, except) => {
    const r = { id: 'r', decision: 'deny', match, why: 'w' };
    if (except) r.except = except;
    return () => loadPolicy(writePolicy(dir, JSON.stringify({ version: 1, rules: [r] })), { mode: 'user', home: HOME });
  };
  for (const g of ['.env', 'secrets/**', '/a//b', '/a/b/', '*.env', 'src/*.js']) {
    assert.throws(load({ paths: [g] }), (err) => err.code === 'glob' && err.pointer === '/rules/0/match/paths/0', g);
  }
  assert.throws(load({ class: ['delete'] }, { paths: ['tmp/**'] }), (err) => err.code === 'glob' && err.pointer === '/rules/0/except/paths/0');
  for (const g of ['/abs/**', '~/.ssh/**', '${repo}/**', '${cwd}/x', '**/.env', '/**', '~']) {
    assert.doesNotThrow(load({ paths: [g] }), g);
  }
});

test('loadPolicy rejects an except kind the match does not judge', () => {
  const dir = tmpDir();
  const load = (match, except) => () =>
    loadPolicy(writePolicy(dir, JSON.stringify({ version: 1, rules: [{ id: 'r', decision: 'deny', match, except, why: 'w' }] })), {
      mode: 'user',
      home: HOME,
    });
  assert.throws(load({ class: ['network-fetch'] }, { paths: ['${repo}/**'] }), (err) => err.code === 'value' && err.pointer === '/rules/0/except/paths');
  assert.throws(load({ class: ['delete', 'network-fetch'] }, { paths: ['${repo}/**'] }), (err) => err.pointer === '/rules/0/except/paths');
  assert.throws(load({ argv: [['rm']] }, { paths: ['${repo}/**'] }), (err) => err.pointer === '/rules/0/except/paths');
  assert.throws(load({ class: ['delete'] }, { domains: ['ok.example'] }), (err) => err.code === 'value' && err.pointer === '/rules/0/except/domains');
  assert.throws(load({ paths: ['/**'] }, { domains: ['ok.example'] }), (err) => err.pointer === '/rules/0/except/domains');
  for (const [match, except] of [
    [{ class: ['delete', 'overwrite', 'perm-change'] }, { paths: ['${repo}/**'] }],
    [{ paths: ['/**'] }, { paths: ['${repo}/**'] }],
    [{ class: ['network-fetch'] }, { domains: ['ok.example'] }],
    [{ domains: ['*'] }, { domains: ['ok.example'] }],
  ]) {
    assert.doesNotThrow(load(match, except), JSON.stringify([match, except]));
  }
});

test('a network-fetch deny is not excused by the paths a fetch writes', () => {
  const curl = cmd(['curl', 'https://evil.com', '-o', `${ROOT}/a`], { classes: ['network-fetch'], domains: ['evil.com'], writes: [`${ROOT}/a`] });
  const valid = policy([rule('net', 'deny', { class: ['network-fetch'] }, { except: { domains: ['ok.example'] } })]);
  assert.equal(run(valid, shell('curl'), { commands: [curl] }).rule, 'net');
  // a policy that skipped the loader with an except kind the match does not judge: the except
  // is ignored, the deny stays
  const invalid = policy([rule('net', 'deny', { class: ['network-fetch'] }, { except: { paths: ['${repo}/**'] } })]);
  assert.equal(run(invalid, shell('curl'), { commands: [curl] }).rule, 'net');
  // an except.paths on a delete rule still needs every path effect known and excepted
  const del = policy([rule('del', 'deny', { class: ['delete'] }, { except: { paths: ['${repo}/**'] } })]);
  const rm = cmd(['rm', 'a', 'b'], { classes: ['delete'], writes: [`${ROOT}/a`, '/tmp/b'] });
  assert.equal(run(del, shell('rm'), { commands: [rm] }).rule, 'del');
});
