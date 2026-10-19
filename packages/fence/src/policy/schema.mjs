// Hand-written, dependency-free policy schema validator (trusted path).
//
// validatePolicy(obj) treats `obj` as untrusted: it reads only own data
// properties (an accessor is refused without being invoked), accepts only plain
// objects (prototype null or Object.prototype) and plain arrays (no holes, no
// extra properties), never mutates its input, and returns a fresh Policy built
// from null-prototype objects with defaults filled. The first violation throws a
// PolicyError whose `pointer` is an RFC 6901 JSON pointer to it:
//   type           wrong JSON type, non-plain object/array, accessor, hole, symbol value
//   value          right type, disallowed value (version, decision, id, why, empty list, ...)
//   missing-key    a required key is absent
//   unknown-key    a key the schema does not define (including symbol keys)
//   duplicate-id   two rules share an id
//   unknown-class  a match.class entry outside CLASS_NAMES
//   glob           an invalid glob pattern (a rule glob, or a `projects` path)
//   forbidden-key  __proto__, constructor or prototype inside an example

import { PolicyError } from './errors.mjs';
import { CLASS_NAMES } from './classes.mjs';

const DEFAULT_PROTECTED = ['main', 'master', 'develop'];
const ID_RE = /^[a-z0-9-]+$/;
const PROFILE_RE = /^[a-z][a-z0-9-]*$/;
const INDEX_RE = /^(?:0|[1-9][0-9]*)$/;
const PLACEHOLDERS = ['${repo}', '${cwd}'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CLASS_SET = new Set(CLASS_NAMES);

const TOP_KEYS = ['version', 'profiles', 'projects', 'branches', 'rules'];
const PROFILE_KEYS = ['undecided', 'uncertain', 'certain', 'rules'];
const UNCERTAIN_KEYS = ['opaque', 'selfProtection', 'rules', 'constructs'];
const UNCERTAIN_CATEGORIES = ['opaque', 'selfProtection', 'rules'];
const PROJECT_KEYS = ['path', 'profile'];
const ACTIONS = ['deny', 'audit'];
const BRANCH_KEYS = ['protected', 'denyFileWrites'];
const RULE_KEYS = ['id', 'decision', 'match', 'except', 'why', 'examples'];
const MATCH_KEYS = ['class', 'paths', 'access', 'argv', 'mcp', 'domains'];
const EXCEPT_KEYS = ['paths', 'domains'];
const EXAMPLE_KEYS = ['deny', 'allow'];

const token = (key) => '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const fail = (code, message, pointer) => {
  throw new PolicyError(code, `${message} at ${JSON.stringify(pointer)}`, { pointer });
};
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

function newObject() {
  return Object.create(null);
}

function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

// Snapshot of a plain object's own data properties as a null-prototype object.
// `allowed` is a key list, or null for any string key.
function readObject(v, ptr, allowed) {
  if (!isPlainObject(v)) fail('type', `expected an object, got ${kind(v)}`, ptr);
  const out = newObject();
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key === 'symbol') fail('unknown-key', `unexpected symbol key ${String(key)}`, ptr);
    if (allowed !== null && !allowed.includes(key)) fail('unknown-key', `unknown key ${JSON.stringify(key)}`, ptr + token(key));
    const desc = Object.getOwnPropertyDescriptor(v, key);
    if (!desc || !Object.hasOwn(desc, 'value')) fail('type', 'expected a data property, got an accessor', ptr + token(key));
    put(out, key, desc.value);
  }
  return out;
}

// Snapshot of a plain array's elements; holes and extra properties are refused.
function readArray(v, ptr) {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) fail('type', `expected an array, got ${kind(v)}`, ptr);
  const lenDesc = Object.getOwnPropertyDescriptor(v, 'length');
  const len = lenDesc.value;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key === 'symbol') fail('unknown-key', `unexpected symbol key ${String(key)}`, ptr);
    if (key === 'length') continue;
    if (!INDEX_RE.test(key) || Number(key) >= len) fail('unknown-key', `unexpected array property ${JSON.stringify(key)}`, ptr + token(key));
  }
  const out = [];
  for (let i = 0; i < len; i++) {
    const desc = Object.getOwnPropertyDescriptor(v, String(i));
    if (!desc) fail('type', 'array has a hole', ptr + token(i));
    if (!Object.hasOwn(desc, 'value')) fail('type', 'expected a data element, got an accessor', ptr + token(i));
    out.push(desc.value);
  }
  return out;
}

function nonEmptyList(v, ptr) {
  const list = readArray(v, ptr);
  if (list.length === 0) fail('value', 'list must not be empty', ptr);
  return list;
}

function nonEmptyString(v, ptr, what) {
  if (typeof v !== 'string') fail('type', `${what} must be a string, got ${kind(v)}`, ptr);
  if (v === '' || v.includes('\u0000')) fail('value', `${what} must be non-empty and contain no NUL`, ptr);
  return v;
}

function oneOf(v, values, ptr, what) {
  if (!values.includes(v)) fail('value', `${what} must be one of ${values.join(', ')}, got ${JSON.stringify(v) ?? kind(v)}`, ptr);
  return v;
}

// Glob syntax: `*`, `?`, `**`, `[...]` classes (optional leading `!` or `^`; a `]`
// right after the opener is literal), placeholders `~`, `${repo}`, `${cwd}`.
function checkGlob(v, ptr) {
  if (typeof v !== 'string') fail('type', `glob must be a string, got ${kind(v)}`, ptr);
  if (v === '') fail('glob', 'glob must not be empty', ptr);
  if (v.includes('\u0000')) fail('glob', 'glob must not contain NUL', ptr);
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '[') {
      let j = i + 1;
      if (v[j] === '!' || v[j] === '^') j++;
      if (v[j] === ']') j++;
      const close = v.indexOf(']', j);
      if (close === -1) fail('glob', `unclosed "[" at index ${i} in ${JSON.stringify(v)}`, ptr);
      i = close;
    } else if (ch === '$' && v[i + 1] === '{') {
      const placeholder = PLACEHOLDERS.find((p) => v.startsWith(p, i));
      if (!placeholder) fail('glob', `unknown placeholder at index ${i} in ${JSON.stringify(v)} (allowed: ~, \${repo}, \${cwd})`, ptr);
      i += placeholder.length - 1;
    }
  }
  return v;
}

function globList(v, ptr) {
  return nonEmptyList(v, ptr).map((g, i) => checkGlob(g, ptr + token(i)));
}

// Deep copy of a JSON value (example fragments); contents are checked later by `fence test`.
function copyJson(v, ptr) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail('type', 'number must be finite', ptr);
    return v;
  }
  if (Array.isArray(v)) return readArray(v, ptr).map((e, i) => copyJson(e, ptr + token(i)));
  if (isPlainObject(v)) return copyExampleObject(v, ptr);
  return fail('type', `expected a JSON value, got ${kind(v)}`, ptr);
}

function copyExampleObject(v, ptr) {
  const src = readObject(v, ptr, null);
  const out = newObject();
  for (const key of Object.keys(src)) {
    if (FORBIDDEN_KEYS.has(key)) fail('forbidden-key', `forbidden key ${JSON.stringify(key)}`, ptr + token(key));
    put(out, key, copyJson(src[key], ptr + token(key)));
  }
  return out;
}

function validateMatch(v, ptr) {
  const src = readObject(v, ptr, MATCH_KEYS);
  if (Object.keys(src).length === 0) fail('value', 'match must have at least one key', ptr);
  const out = newObject();
  if (Object.hasOwn(src, 'class')) {
    const p = ptr + token('class');
    out.class = nonEmptyList(src.class, p).map((c, i) => {
      if (typeof c !== 'string') fail('type', `class must be a string, got ${kind(c)}`, p + token(i));
      if (!CLASS_SET.has(c)) fail('unknown-class', `unknown class ${JSON.stringify(c)}`, p + token(i));
      return c;
    });
  }
  if (Object.hasOwn(src, 'paths')) out.paths = globList(src.paths, ptr + token('paths'));
  if (Object.hasOwn(src, 'access')) {
    const p = ptr + token('access');
    if (!Object.hasOwn(src, 'paths')) fail('value', 'access is allowed only with paths', p);
    out.access = oneOf(src.access, ['read', 'write', 'any'], p, 'access');
  }
  if (Object.hasOwn(src, 'argv')) {
    const p = ptr + token('argv');
    out.argv = nonEmptyList(src.argv, p).map((prefix, i) =>
      nonEmptyList(prefix, p + token(i)).map((w, j) => nonEmptyString(w, p + token(i) + token(j), 'argv word')),
    );
  }
  if (Object.hasOwn(src, 'mcp')) out.mcp = globList(src.mcp, ptr + token('mcp'));
  if (Object.hasOwn(src, 'domains')) out.domains = globList(src.domains, ptr + token('domains'));
  return out;
}

function validateExcept(v, ptr) {
  const src = readObject(v, ptr, EXCEPT_KEYS);
  if (Object.keys(src).length === 0) fail('value', 'except must have at least one key', ptr);
  const out = newObject();
  if (Object.hasOwn(src, 'paths')) out.paths = globList(src.paths, ptr + token('paths'));
  if (Object.hasOwn(src, 'domains')) out.domains = globList(src.domains, ptr + token('domains'));
  return out;
}

function validateExamples(v, ptr) {
  const src = readObject(v, ptr, EXAMPLE_KEYS);
  const out = newObject();
  for (const key of EXAMPLE_KEYS) {
    if (!Object.hasOwn(src, key)) continue;
    const p = ptr + token(key);
    out[key] = readArray(src[key], p).map((e, i) => {
      if (!isPlainObject(e)) fail('type', `example must be an object, got ${kind(e)}`, p + token(i));
      return copyExampleObject(e, p + token(i));
    });
  }
  return out;
}

function validateRule(v, ptr, seenIds) {
  const src = readObject(v, ptr, RULE_KEYS);
  for (const key of ['id', 'decision', 'match', 'why']) {
    if (!Object.hasOwn(src, key)) fail('missing-key', `rule is missing ${JSON.stringify(key)}`, ptr + token(key));
  }
  const out = newObject();
  const idPtr = ptr + token('id');
  if (typeof src.id !== 'string') fail('type', `id must be a string, got ${kind(src.id)}`, idPtr);
  if (!ID_RE.test(src.id)) fail('value', `id ${JSON.stringify(src.id)} must match [a-z0-9-]+`, idPtr);
  if (seenIds.has(src.id)) fail('duplicate-id', `duplicate rule id ${JSON.stringify(src.id)}`, idPtr);
  seenIds.add(src.id);
  out.id = src.id;
  out.decision = oneOf(src.decision, ['deny', 'allow', 'audit'], ptr + token('decision'), 'decision');
  out.match = validateMatch(src.match, ptr + token('match'));
  if (Object.hasOwn(src, 'except')) out.except = validateExcept(src.except, ptr + token('except'));
  const whyPtr = ptr + token('why');
  if (typeof src.why !== 'string') fail('type', `why must be a string, got ${kind(src.why)}`, whyPtr);
  if (src.why.trim() === '') fail('value', 'why must not be blank', whyPtr);
  out.why = src.why;
  if (Object.hasOwn(src, 'examples')) out.examples = validateExamples(src.examples, ptr + token('examples'));
  return out;
}

function uncertainActions(v, ptr) {
  const out = newObject();
  if (typeof v === 'string') {
    // a string applies to every category; `constructs` stays empty
    const action = oneOf(v, ACTIONS, ptr, 'uncertain');
    for (const key of UNCERTAIN_CATEGORIES) out[key] = action;
    out.constructs = newObject();
    return out;
  }
  const src = v === undefined ? newObject() : readObject(v, ptr, UNCERTAIN_KEYS);
  for (const key of UNCERTAIN_CATEGORIES) {
    out[key] = Object.hasOwn(src, key) ? oneOf(src[key], ACTIONS, ptr + token(key), key) : 'deny';
  }
  out.constructs = newObject();
  if (Object.hasOwn(src, 'constructs')) {
    const p = ptr + token('constructs');
    const names = readObject(src.constructs, p, null);
    // Construct names are free strings: the normalizer builds some at run time. `fence check` warns on unknown ones.
    for (const name of Object.keys(names)) put(out.constructs, name, oneOf(names[name], ACTIONS, p + token(name), 'construct action'));
  }
  return out;
}

function validateProfileRules(v, ptr) {
  const out = newObject();
  if (v === undefined) return out;
  const src = readObject(v, ptr, null);
  for (const id of Object.keys(src)) put(out, id, oneOf(src[id], [...ACTIONS, 'off'], ptr + token(id), 'rule action'));
  return out;
}

function validateProfiles(v, ptr) {
  const out = newObject();
  if (v !== undefined) {
    const src = readObject(v, ptr, null);
    for (const name of Object.keys(src)) {
      const p = ptr + token(name);
      if (!PROFILE_RE.test(name)) fail('value', `profile name ${JSON.stringify(name)} must match [a-z][a-z0-9-]*`, p);
      const prof = readObject(src[name], p, PROFILE_KEYS);
      if (!Object.hasOwn(prof, 'undecided')) fail('missing-key', 'profile is missing "undecided"', p + token('undecided'));
      const entry = newObject();
      entry.undecided = oneOf(prof.undecided, ['host', 'deny'], p + token('undecided'), 'undecided');
      entry.uncertain = uncertainActions(prof.uncertain, p + token('uncertain'));
      entry.certain = Object.hasOwn(prof, 'certain') ? oneOf(prof.certain, ACTIONS, p + token('certain'), 'certain') : 'deny';
      entry.rules = validateProfileRules(prof.rules, p + token('rules'));
      put(out, name, entry);
    }
  }
  if (!Object.hasOwn(out, 'default')) {
    const entry = newObject();
    entry.undecided = 'host';
    entry.uncertain = uncertainActions(undefined, '/profiles/default/uncertain');
    entry.certain = 'deny';
    entry.rules = newObject();
    out.default = entry;
  }
  return out;
}

// A profile's `rules` overrides may name only rules whose own decision is deny or audit.
function checkProfileRules(profiles, rules) {
  const decisions = new Map(rules.map((r) => [r.id, r.decision]));
  for (const name of Object.keys(profiles)) {
    for (const id of Object.keys(profiles[name].rules)) {
      const p = '/profiles' + token(name) + '/rules' + token(id);
      if (!decisions.has(id)) fail('value', `rule override names ${JSON.stringify(id)}, which is not a rule`, p);
      if (decisions.get(id) === 'allow') fail('value', `rule override names ${JSON.stringify(id)}, which is an allow rule (only deny and audit rules can be overridden)`, p);
    }
  }
}

// The text of a glob before its first glob character (`*`, `?`, `[`).
function literalPrefix(glob) {
  const at = glob.search(/[*?[]/);
  return at === -1 ? glob : glob.slice(0, at);
}

function validateProjects(v, ptr, profiles) {
  if (v === undefined) return [];
  const prefixes = new Map();
  return readArray(v, ptr).map((entry, i) => {
    const p = ptr + token(i);
    const src = readObject(entry, p, PROJECT_KEYS);
    for (const key of PROJECT_KEYS) {
      if (!Object.hasOwn(src, key)) fail('missing-key', `project entry is missing ${JSON.stringify(key)}`, p + token(key));
    }
    const out = newObject();
    out.path = checkGlob(src.path, p + token('path'));
    const profilePtr = p + token('profile');
    if (typeof src.profile !== 'string') fail('type', `profile must be a string, got ${kind(src.profile)}`, profilePtr);
    if (!Object.hasOwn(profiles, src.profile)) fail('value', `profile ${JSON.stringify(src.profile)} is not defined in profiles`, profilePtr);
    out.profile = src.profile;
    // Two entries with the same literal prefix would tie on "longest literal prefix": refused here, statically.
    const prefix = literalPrefix(out.path);
    if (prefixes.has(prefix)) {
      fail('value', `projects entries ${prefixes.get(prefix)} and ${i} have the same literal prefix ${JSON.stringify(prefix)}`, p + token('path'));
    }
    prefixes.set(prefix, i);
    return out;
  });
}

function validateBranches(v, ptr) {
  const src = v === undefined ? newObject() : readObject(v, ptr, BRANCH_KEYS);
  const out = newObject();
  if (Object.hasOwn(src, 'protected')) {
    const p = ptr + token('protected');
    out.protected = readArray(src.protected, p).map((b, i) => nonEmptyString(b, p + token(i), 'branch name'));
  } else {
    out.protected = [...DEFAULT_PROTECTED];
  }
  if (Object.hasOwn(src, 'denyFileWrites')) {
    const p = ptr + token('denyFileWrites');
    if (typeof src.denyFileWrites !== 'boolean') fail('type', `denyFileWrites must be a boolean, got ${kind(src.denyFileWrites)}`, p);
    out.denyFileWrites = src.denyFileWrites;
  } else {
    out.denyFileWrites = false;
  }
  return out;
}

export function validatePolicy(obj) {
  const src = readObject(obj, '', TOP_KEYS);
  for (const key of ['version', 'rules']) {
    if (!Object.hasOwn(src, key)) fail('missing-key', `policy is missing ${JSON.stringify(key)}`, token(key));
  }
  const out = newObject();
  if (src.version !== 1) fail('value', `version must be 1, got ${JSON.stringify(src.version) ?? kind(src.version)}`, '/version');
  out.version = 1;
  if (Object.hasOwn(src, 'profiles') && src.profiles === undefined) fail('type', 'expected an object, got undefined', '/profiles');
  if (Object.hasOwn(src, 'branches') && src.branches === undefined) fail('type', 'expected an object, got undefined', '/branches');
  out.profiles = validateProfiles(src.profiles, '/profiles');
  out.branches = validateBranches(src.branches, '/branches');
  const seenIds = new Set();
  if (Object.hasOwn(src, 'projects') && src.projects === undefined) fail('type', 'expected an array, got undefined', '/projects');
  out.projects = validateProjects(src.projects, '/projects', out.profiles);
  out.rules = readArray(src.rules, '/rules').map((r, i) => validateRule(r, '/rules' + token(i), seenIds));
  checkProfileRules(out.profiles, out.rules);
  return out;
}
