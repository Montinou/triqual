import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validatePolicy } from '../src/policy/schema.mjs';
import { CLASS_NAMES } from '../src/policy/classes.mjs';
import { parseStrictJson } from '../src/policy/parse.mjs';
import { PolicyError } from '../src/policy/errors.mjs';

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

// A minimal valid rule; `over` replaces or adds top-level rule keys.
function rule(over = {}) {
  return { id: 'r', decision: 'deny', match: { class: ['delete'] }, why: 'because', ...over };
}

// A minimal valid policy holding `rules`; `over` replaces or adds top-level keys.
function policy(rules = [rule()], over = {}) {
  return { version: 1, rules, ...over };
}

// Asserts validatePolicy(obj) throws a PolicyError with `code` and, when given, `pointer`.
function rejects(obj, code, pointer) {
  assert.throws(
    () => validatePolicy(obj),
    (err) => {
      assert.ok(err instanceof PolicyError, `expected PolicyError, got ${err && err.name}: ${err && err.message}`);
      assert.equal(err.code, code, `code: ${err.message} (pointer ${err.pointer})`);
      if (pointer !== undefined) assert.equal(err.pointer, pointer, `pointer: ${err.message}`);
      return true;
    },
  );
}

// Every object in the tree has a null prototype; arrays are plain arrays.
function assertNullProtoTree(value) {
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    for (const v of value) assertNullProtoTree(v);
  } else if (value !== null && typeof value === 'object') {
    assert.equal(Object.getPrototypeOf(value), null);
    for (const k of Object.keys(value)) assertNullProtoTree(value[k]);
  }
}

test('accepts the spec example policy', () => {
  const input = parseStrictJson(SPEC_EXAMPLE);
  const before = JSON.stringify(input);
  const p = validatePolicy(input);
  assert.equal(JSON.stringify(input), before, 'input must not be mutated');
  // Defaults are filled: every profile carries all mode settings, and `projects` is [].
  const expected = JSON.parse(SPEC_EXAMPLE);
  const DENY_ALL = { opaque: 'deny', selfProtection: 'deny', rules: 'deny', constructs: {} };
  expected.profiles = {
    default: { undecided: 'host', uncertain: DENY_ALL, certain: 'deny', rules: {} },
    unattended: { undecided: 'deny', uncertain: DENY_ALL, certain: 'deny', rules: {} },
  };
  expected.projects = [];
  assert.deepEqual(JSON.parse(JSON.stringify(p)), expected);
  assertNullProtoTree(p);
  // Fresh copies, never the input's own objects.
  assert.notEqual(p.rules, input.rules);
  assert.notEqual(p.rules[0], input.rules[0]);
  assert.notEqual(p.rules[0].match, input.rules[0].match);
  assert.notEqual(p.rules[0].match.paths, input.rules[0].match.paths);
  assert.notEqual(p.rules[0].examples.deny[0], input.rules[0].examples.deny[0]);
  // Plain (Object.prototype) objects are accepted too.
  assert.equal(JSON.stringify(validatePolicy(JSON.parse(SPEC_EXAMPLE))), JSON.stringify(p));
});

test('rejects unknown keys at every level', () => {
  rejects({ ...policy(), extra: 1 }, 'unknown-key', '/extra');
  rejects(policy([rule()], { profiles: { default: { undecided: 'host', relax: true } } }), 'unknown-key', '/profiles/default/relax');
  rejects(policy([rule()], { branches: { protected: [], extra: true } }), 'unknown-key', '/branches/extra');
  rejects(policy([rule({ severity: 'high' })]), 'unknown-key', '/rules/0/severity');
  rejects(policy([rule({ match: { class: ['delete'], program: ['rm'] } })]), 'unknown-key', '/rules/0/match/program');
  rejects(policy([rule({ except: { class: ['delete'] } })]), 'unknown-key', '/rules/0/except/class');
  rejects(policy([rule({ except: { argv: [['rm']] } })]), 'unknown-key', '/rules/0/except/argv');
  rejects(policy([rule({ examples: { deny: [], maybe: [] } })]), 'unknown-key', '/rules/0/examples/maybe');
  // Pointer tokens are RFC 6901 escaped.
  rejects({ ...policy(), 'a/b~c': 1 }, 'unknown-key', '/a~1b~0c');
  // Symbol keys are never accepted.
  rejects({ ...policy(), [Symbol('s')]: 1 }, 'unknown-key', '');
  // Prototype keys arriving through a null-prototype object are unknown keys, not assignments.
  const proto = Object.create(null);
  Object.defineProperty(proto, '__proto__', { value: {}, enumerable: true });
  rejects(Object.assign(proto, policy()), 'unknown-key', '/__proto__');
});

test('rejects a rule without why', () => {
  const r = rule();
  delete r.why;
  rejects(policy([r]), 'missing-key', '/rules/0/why');
  rejects(policy([rule({ why: '' })]), 'value', '/rules/0/why');
  rejects(policy([rule({ why: '   ' })]), 'value', '/rules/0/why');
  rejects(policy([rule({ why: 3 })]), 'type', '/rules/0/why');
});

test('rejects duplicate rule ids', () => {
  rejects(policy([rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'a' })]), 'duplicate-id', '/rules/2/id');
});

test('rejects an id outside [a-z0-9-]+', () => {
  for (const id of ['', 'Upper', 'snake_case', 'has space', 'dot.ted', 'ünï', 'a\u0000b', 'a\n']) {
    rejects(policy([rule({ id })]), 'value', '/rules/0/id');
  }
  rejects(policy([rule({ id: 7 })]), 'type', '/rules/0/id');
  const r = rule();
  delete r.id;
  rejects(policy([r]), 'missing-key', '/rules/0/id');
  assert.equal(validatePolicy(policy([rule({ id: 'a-1-b' })])).rules[0].id, 'a-1-b');
});

test('rejects an unknown class', () => {
  rejects(policy([rule({ match: { class: ['delete', 'nuke'] } })]), 'unknown-class', '/rules/0/match/class/1');
  rejects(policy([rule({ match: { class: ['Delete'] } })]), 'unknown-class', '/rules/0/match/class/0');
  rejects(policy([rule({ match: { class: 'delete' } })]), 'type', '/rules/0/match/class');
  rejects(policy([rule({ match: { class: [] } })]), 'value', '/rules/0/match/class');
  assert.deepEqual(CLASS_NAMES, [
    'delete', 'overwrite', 'perm-change', 'privilege', 'network-fetch',
    'vcs-write', 'env-dump', 'package-install', 'runs-repo-code', 'search',
  ]);
  for (const c of CLASS_NAMES) validatePolicy(policy([rule({ match: { class: [c] } })]));
});

test('rejects access without paths', () => {
  rejects(policy([rule({ match: { class: ['delete'], access: 'read' } })]), 'value', '/rules/0/match/access');
  rejects(policy([rule({ match: { paths: ['**'], access: 'exec' } })]), 'value', '/rules/0/match/access');
  for (const access of ['read', 'write', 'any']) {
    assert.equal(validatePolicy(policy([rule({ match: { paths: ['**'], access } })])).rules[0].match.access, access);
  }
});

test('rejects an invalid glob (unclosed bracket)', () => {
  const at = (paths) => policy([rule({ match: { paths } })]);
  rejects(at(['**/[abc']), 'glob', '/rules/0/match/paths/0');
  rejects(at(['ok/**', 'x[!a']), 'glob', '/rules/0/match/paths/1');
  rejects(at(['x[]']), 'glob', '/rules/0/match/paths/0');
  rejects(at(['']), 'glob', '/rules/0/match/paths/0');
  rejects(at(['a\u0000b']), 'glob', '/rules/0/match/paths/0');
  rejects(at([3]), 'type', '/rules/0/match/paths/0');
  rejects(at(['${home}/x']), 'glob', '/rules/0/match/paths/0');
  rejects(at(['${repo']), 'glob', '/rules/0/match/paths/0');
  rejects(at(['${']), 'glob', '/rules/0/match/paths/0');
  // Every glob-bearing key is checked.
  rejects(policy([rule({ match: { mcp: ['mcp__[x'] } })]), 'glob', '/rules/0/match/mcp/0');
  rejects(policy([rule({ match: { domains: ['[a.com'] } })]), 'glob', '/rules/0/match/domains/0');
  rejects(policy([rule({ match: { class: ['delete'] }, except: { paths: ['['] } })]), 'glob', '/rules/0/except/paths/0');
  rejects(policy([rule({ match: { class: ['delete'] }, except: { domains: [''] } })]), 'glob', '/rules/0/except/domains/0');
  // Valid: classes (including a leading ']' and negation), placeholders.
  const ok = ['[abc]/*', '[]x]', '[!a]?', '[^a-z]', '~/.ssh/**', '${repo}/**', '${cwd}/x', 'a$b'];
  assert.deepEqual([...validatePolicy(at(ok)).rules[0].match.paths], ok);
});

test('rejects a profile undecided value other than host or deny', () => {
  rejects(policy([rule()], { profiles: { default: { undecided: 'allow' } } }), 'value', '/profiles/default/undecided');
  rejects(policy([rule()], { profiles: { ci: {} } }), 'missing-key', '/profiles/ci/undecided');
  rejects(policy([rule()], { profiles: { ci: 'deny' } }), 'type', '/profiles/ci');
  rejects(policy([rule()], { profiles: { 'Bad_Name': { undecided: 'deny' } } }), 'value', '/profiles/Bad_Name');
  rejects(policy([rule()], { profiles: { '9ci': { undecided: 'deny' } } }), 'value', '/profiles/9ci');
  rejects(policy([rule()], { profiles: [] }), 'type', '/profiles');
});

test('rejects version other than 1', () => {
  for (const version of [0, 2, '1', 1.5, true, null]) rejects(policy([rule()], { version }), 'value', '/version');
  const p = policy();
  delete p.version;
  rejects(p, 'missing-key', '/version');
});

test('rejects a match with no keys', () => {
  rejects(policy([rule({ match: {} })]), 'value', '/rules/0/match');
  const r = rule();
  delete r.match;
  rejects(policy([r]), 'missing-key', '/rules/0/match');
  rejects(policy([rule({ match: [] })]), 'type', '/rules/0/match');
});

test('fills defaults', () => {
  const p = validatePolicy({ version: 1, rules: [] });
  assert.equal(p.version, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(p.profiles)), {
    default: { undecided: 'host', uncertain: { opaque: 'deny', selfProtection: 'deny', rules: 'deny', constructs: {} }, certain: 'deny', rules: {} },
  });
  assert.deepEqual(p.projects, []);
  assert.deepEqual([...p.branches.protected], ['main', 'master', 'develop']);
  assert.equal(p.branches.denyFileWrites, false);
  assert.deepEqual(p.rules, []);
  assertNullProtoTree(p);
  // A partial branches object keeps what is given and fills the rest.
  const q = validatePolicy({ version: 1, rules: [], branches: { denyFileWrites: true } });
  assert.deepEqual([...q.branches.protected], ['main', 'master', 'develop']);
  assert.equal(q.branches.denyFileWrites, true);
  // `default` is added beside other profiles and never overrides a given one.
  const r = validatePolicy({ version: 1, rules: [], profiles: { ci: { undecided: 'deny' } } });
  assert.deepEqual(Object.keys(r.profiles).sort(), ['ci', 'default']);
  assert.equal(r.profiles.default.undecided, 'host');
  const s = validatePolicy({ version: 1, rules: [], profiles: { default: { undecided: 'deny' } } });
  assert.equal(s.profiles.default.undecided, 'deny');
  // The default list is not shared between results.
  p.branches.protected.push('x');
  assert.deepEqual([...validatePolicy({ version: 1, rules: [] }).branches.protected], ['main', 'master', 'develop']);
});

test('rejects non-plain values where objects, arrays and scalars belong', () => {
  for (const bad of [null, undefined, [], 'x', 1, () => {}, new Date(0), new Map(), Object.create({})]) {
    rejects(bad, 'type', '');
  }
  rejects(policy([rule()], { rules: {} }), 'type', '/rules');
  rejects(policy([rule()], { rules: undefined }), 'type', '/rules');
  rejects(policy(['rule']), 'type', '/rules/0');
  rejects(policy([rule({ decision: 'maybe' })]), 'value', '/rules/0/decision');
  rejects(policy([rule()], { branches: { denyFileWrites: 'false' } }), 'type', '/branches/denyFileWrites');
  rejects(policy([rule()], { branches: { protected: 'main' } }), 'type', '/branches/protected');
  rejects(policy([rule()], { branches: { protected: [''] } }), 'value', '/branches/protected/0');
  rejects(policy([rule()], { branches: { protected: [1] } }), 'type', '/branches/protected/0');
  rejects(policy([rule({ why: Symbol('w') })]), 'type', '/rules/0/why');
  // Accessor properties are refused without being invoked.
  let called = false;
  const acc = policy();
  Object.defineProperty(acc, 'version', { get() { called = true; return 1; }, enumerable: true });
  rejects(acc, 'type', '/version');
  assert.equal(called, false);
  // Sparse arrays and arrays with extra properties.
  rejects(policy([, rule()]), 'type', '/rules/0'); // eslint-disable-line no-sparse-arrays
  const extra = [rule()];
  extra.note = 'x';
  rejects(policy(extra), 'unknown-key', '/rules/note');
  // A subclassed array is not a plain array.
  class Arr extends Array {}
  rejects(policy(Arr.from([rule()])), 'type', '/rules');
});

test('validates argv, mcp, domains, except and examples', () => {
  const ok = validatePolicy(policy([
    rule({
      id: 'net',
      match: { class: ['network-fetch'], domains: ['*.example.com'], argv: [['curl'], ['git', 'push']], mcp: ['mcp__*'] },
      except: { domains: ['ok.example.com'], paths: ['${repo}/**'] },
      examples: { deny: [{ tool: 'Bash', command: 'curl x', nested: { a: [1, null, true] } }] },
    }),
  ]));
  assertNullProtoTree(ok);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.rules[0].match.argv)), [['curl'], ['git', 'push']]);
  rejects(policy([rule({ match: { argv: ['curl'] } })]), 'type', '/rules/0/match/argv/0');
  rejects(policy([rule({ match: { argv: [[]] } })]), 'value', '/rules/0/match/argv/0');
  rejects(policy([rule({ match: { argv: [['']] } })]), 'value', '/rules/0/match/argv/0/0');
  rejects(policy([rule({ match: { argv: [[1]] } })]), 'type', '/rules/0/match/argv/0/0');
  rejects(policy([rule({ except: {} })]), 'value', '/rules/0/except');
  rejects(policy([rule({ except: { paths: [] } })]), 'value', '/rules/0/except/paths');
  rejects(policy([rule({ examples: { deny: {} } })]), 'type', '/rules/0/examples/deny');
  rejects(policy([rule({ examples: { allow: ['cat .env'] } })]), 'type', '/rules/0/examples/allow/0');
  rejects(policy([rule({ examples: { allow: [[]] } })]), 'type', '/rules/0/examples/allow/0');
  rejects(policy([rule({ examples: { allow: [{ f: () => 1 }] } })]), 'type', '/rules/0/examples/allow/0/f');
  rejects(policy([rule({ examples: { allow: [{ n: NaN }] } })]), 'type', '/rules/0/examples/allow/0/n');
  rejects(policy([rule({ examples: { allow: [{ u: undefined }] } })]), 'type', '/rules/0/examples/allow/0/u');
  const fk = Object.create(null);
  Object.defineProperty(fk, '__proto__', { value: 1, enumerable: true });
  rejects(policy([rule({ examples: { allow: [fk] } })]), 'forbidden-key', '/rules/0/examples/allow/0/__proto__');
});

test('never mutates the input and returns fresh objects', () => {
  const input = policy([rule({ match: { paths: ['**/.env'], access: 'read' }, examples: { deny: [{ tool: 'Read' }] } })]);
  const snapshot = structuredClone(input);
  Object.freeze(input.rules[0].match);
  const p = validatePolicy(input);
  assert.deepEqual(input, snapshot);
  assert.equal(Object.hasOwn(input, 'profiles'), false);
  assert.equal(Object.hasOwn(input, 'branches'), false);
  p.rules[0].match.paths.push('x');
  p.rules[0].examples.deny[0].tool = 'Write';
  assert.deepEqual(input, snapshot);
});

// ---- mode settings (profiles are modes) and projects ----

const MODES_EXAMPLE = {
  profiles: {
    default: { undecided: 'host', uncertain: 'audit' },
    strict: { undecided: 'host', uncertain: 'deny' },
    relaxed: { undecided: 'host', uncertain: 'audit', certain: 'audit' },
    unattended: { undecided: 'deny', uncertain: 'deny' },
  },
  projects: [{ path: '~/Projectos/sandbox/**', profile: 'relaxed' }],
};

test('the four-profile modes example loads and normalizes', () => {
  const p = validatePolicy(policy([rule()], MODES_EXAMPLE));
  assertNullProtoTree(p);
  const all = (a) => ({ opaque: a, selfProtection: a, rules: a, constructs: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(p.profiles)), {
    default: { undecided: 'host', uncertain: all('audit'), certain: 'deny', rules: {} },
    strict: { undecided: 'host', uncertain: all('deny'), certain: 'deny', rules: {} },
    relaxed: { undecided: 'host', uncertain: all('audit'), certain: 'audit', rules: {} },
    unattended: { undecided: 'deny', uncertain: all('deny'), certain: 'deny', rules: {} },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(p.projects)), [{ path: '~/Projectos/sandbox/**', profile: 'relaxed' }]);
  assert.equal(Object.getPrototypeOf(p.projects[0]), null);
});

test('an uncertain object fills omitted categories with deny and keeps constructs', () => {
  const p = validatePolicy(
    policy([rule()], {
      profiles: { ci: { undecided: 'host', uncertain: { opaque: 'audit', constructs: { eval: 'deny', 'process-substitution': 'audit' } } } },
    }),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(p.profiles.ci.uncertain)), {
    opaque: 'audit',
    selfProtection: 'deny',
    rules: 'deny',
    constructs: { eval: 'deny', 'process-substitution': 'audit' },
  });
  assertNullProtoTree(p);
});

test('rules overrides accept deny, audit and off on deny and audit rules', () => {
  const rules = [rule({ id: 'x' }), rule({ id: 'y', decision: 'audit' })];
  const p = validatePolicy(policy(rules, { profiles: { ci: { undecided: 'host', rules: { x: 'off', y: 'deny' } } } }));
  assert.deepEqual(JSON.parse(JSON.stringify(p.profiles.ci.rules)), { x: 'off', y: 'deny' });
  // a rule whose own decision is audit loads, and `rules: {x: "deny"}` on it loads
  assert.equal(p.rules[1].decision, 'audit');
  validatePolicy(policy([rule({ id: 'x', decision: 'audit' })], { profiles: { default: { undecided: 'host', rules: { x: 'deny' } } } }));
});

test('rejects bad mode settings', () => {
  const prof = (over) => policy([rule({ id: 'x' }), rule({ id: 'a', decision: 'allow' })], { profiles: { default: { undecided: 'host', ...over } } });
  rejects(prof({ uncertain: { weird: 'deny' } }), 'unknown-key', '/profiles/default/uncertain/weird');
  rejects(prof({ uncertain: { opaque: 'off' } }), 'value', '/profiles/default/uncertain/opaque');
  rejects(prof({ uncertain: 'allow' }), 'value', '/profiles/default/uncertain');
  rejects(prof({ uncertain: 7 }), 'type', '/profiles/default/uncertain');
  rejects(prof({ uncertain: { constructs: { eval: 'off' } } }), 'value', '/profiles/default/uncertain/constructs/eval');
  rejects(prof({ certain: 'off' }), 'value', '/profiles/default/certain');
  rejects(prof({ certain: 'host' }), 'value', '/profiles/default/certain');
  rejects(prof({ rules: { x: 'allow' } }), 'value', '/profiles/default/rules/x');
  rejects(prof({ rules: { nope: 'deny' } }), 'value', '/profiles/default/rules/nope');
  rejects(prof({ rules: { a: 'deny' } }), 'value', '/profiles/default/rules/a');
  rejects(prof({ rules: [] }), 'type', '/profiles/default/rules');
});

test('rejects a rule decision other than deny, allow or audit', () => {
  rejects(policy([rule({ decision: 'off' })]), 'value', '/rules/0/decision');
  validatePolicy(policy([rule({ decision: 'audit' })]));
});

test('rejects bad projects entries', () => {
  const proj = (projects, profiles) => policy([rule()], { projects, ...(profiles ? { profiles } : {}) });
  rejects(proj([{ path: '~/a/**', profile: 'nope' }]), 'value', '/projects/0/profile');
  rejects(proj([{ path: '~/a/**', profile: 'default', extra: 1 }]), 'unknown-key', '/projects/0/extra');
  rejects(proj([{ path: '~/a/**' }]), 'missing-key', '/projects/0/profile');
  rejects(proj([{ profile: 'default' }]), 'missing-key', '/projects/0/path');
  rejects(proj([{ path: '', profile: 'default' }]), 'glob', '/projects/0/path');
  rejects(proj([{ path: '~/a/[', profile: 'default' }]), 'glob', '/projects/0/path');
  rejects(proj({}), 'type', '/projects');
  rejects(proj(['x']), 'type', '/projects/0');
  // two entries with the same literal prefix are a load error, whatever the rest of the glob says
  rejects(proj([{ path: '~/a/**', profile: 'default' }, { path: '~/a/*', profile: 'default' }]), 'value', '/projects/1/path');
  rejects(proj([{ path: '~/a/**', profile: 'default' }, { path: '~/a/**', profile: 'default' }]), 'value', '/projects/1/path');
  rejects(proj([{ path: '~/a/b', profile: 'default' }, { path: '~/a/b', profile: 'ci' }], { ci: { undecided: 'deny' } }), 'value', '/projects/1/path');
  // different literal prefixes are fine, and so is a prefix that only contains the other
  const ok = validatePolicy(proj([{ path: '~/a/**', profile: 'default' }, { path: '~/a/b/**', profile: 'default' }, { path: '~/b*', profile: 'default' }]));
  assert.equal(ok.projects.length, 3);
});

test('a policy with no mode keys normalizes to all deny, empty rules and no projects', () => {
  const p = validatePolicy({ version: 1, rules: [], profiles: { ci: { undecided: 'deny' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(p.profiles.ci)), {
    undecided: 'deny',
    uncertain: { opaque: 'deny', selfProtection: 'deny', rules: 'deny', constructs: {} },
    certain: 'deny',
    rules: {},
  });
  assert.deepEqual(p.projects, []);
  // each profile owns its constructs and rules objects
  const q = validatePolicy({ version: 1, rules: [], profiles: { a: { undecided: 'deny' }, b: { undecided: 'deny' } } });
  assert.notEqual(q.profiles.a.uncertain, q.profiles.b.uncertain);
  assert.notEqual(q.profiles.a.uncertain.constructs, q.profiles.b.uncertain.constructs);
  assert.notEqual(q.profiles.a.rules, q.profiles.b.rules);
});
