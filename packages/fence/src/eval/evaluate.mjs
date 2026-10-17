// Evaluator: applies the spec's fixed precedence to one canonical call (trusted path).
//
// evaluate(policy, call, normalized, {profile, grants, ctx}) -> {decision, rule, reason, scope}
//   policy      a validated policy (loadPolicy or validatePolicy output)
//   call        the canonical call; file tools give `paths: [{path, access, repo?}]` (absolute
//               realpaths; `repo` per path, else `call.repo`), MCP calls `mcp` (the tool name),
//               fetches `url`
//   normalized  {commands: EffectiveCommand[]} | {opaque: {reason, construct}} | null (no shell)
//   profile     the active profile name (default "default"); an unknown name denies every call
//   grants      allow-once grants already loaded and checked by the caller: [{path, ...}]
//   ctx         {home, platform, caseInsensitive, realpath?}
//
// A call is a list of parts: each effective command, each file a file tool touches, the MCP
// tool, the fetched URL. Precedence:
//   0. a grant for the exact realpath lifts the built-in self-protection deny on that write
//   1. built-in self-protection (paths, ancestor operations, protected commands)
//   2. opaque -> deny
//   3. protected-branch rules (built-in), then policy deny rules (minus `except`)
//   4. allow, only when every part is covered by some allow rule or by a grant (rule "grant",
//      under every profile); an allow rule covers a part only when it judges every effect
//   5. undecided -> the profile (`host` -> undecided, `deny` -> deny)
// Unknown (a value the normalizer could not determine, or a malformed value from the caller)
// satisfies every deny predicate and no allow predicate or `except`. An unresolvable
// `${repo}`/`${cwd}` makes a deny glob match, an allow glob not match, a deny rule's except not
// match and an allow rule's except match (it can not be ruled out). evaluate never throws: an
// internal error is a deny (`builtin:internal-error`).

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { compileGlob, resolveGlobPrefix } from '../match/glob.mjs';
import { UNKNOWN, isUnknown } from '../norm/unknown.mjs';
import { ARGV_COVERED_CLASSES, exceptKindAllowed } from '../policy/classes.mjs';
import { checkAncestorOp, checkCommandArgv, checkPathWrite } from './builtin.mjs';

const SELF = 'builtin:self-protection';
const SHOW_UNKNOWN = '<unknown>';
const PER_CALL_PLACEHOLDER = /\$\{(?:repo|cwd)\}/;
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

const noRealpath = () => {
  throw new Error('no realpath');
};

// ---- input normalisation -----------------------------------------------------------------------

const fold = (s, ci) => (ci ? s.normalize('NFC').toLowerCase() : s);

// An absolute path with no `.`/`..` segment and no NUL, else UNKNOWN.
function asPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\u0000')) return UNKNOWN;
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) return UNKNOWN;
  return p;
}

const asAccess = (a) => (a === 'read' || a === 'write' ? a : UNKNOWN);

function asDomain(d) {
  if (typeof d !== 'string' || d === '') return UNKNOWN;
  return d.toLowerCase().replace(/\.$/, '');
}

function hostOf(url) {
  if (typeof url !== 'string') return UNKNOWN;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return UNKNOWN;
  }
  // An IPv6 literal or an empty host is not a name a domain glob can judge.
  if (host === '' || host.startsWith('[')) return UNKNOWN;
  return asDomain(host);
}

// A list field of an effective command: absent is empty, anything but an array is [UNKNOWN].
function listOf(v, map) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return [UNKNOWN];
  return v.map(map);
}

const asWord = (w) => (typeof w === 'string' ? w : UNKNOWN);

function commandPart(c) {
  if (c === null || typeof c !== 'object' || !Array.isArray(c.argv)) {
    throw new TypeError('an effective command must be an object with an argv array');
  }
  if (c.ops !== undefined && !Array.isArray(c.ops)) throw new TypeError('an effective command ops must be an array');
  return {
    type: 'command',
    argv: c.argv.map(asWord),
    cwd: asPath(c.cwd),
    classes: listOf(c.classes, asWord),
    reads: listOf(c.reads, asPath),
    writes: listOf(c.writes, asPath),
    domains: listOf(c.domains, asDomain),
    ops: (c.ops ?? []).map((op) => ({ path: asPath(op?.path), op: op?.op })),
    repo: c.repo === undefined ? null : c.repo,
  };
}

// Builds the parts of a call. Returns {parts, opaque}; `opaque` is null or the opaque record.
function buildParts(call, normalized) {
  if (call === null || typeof call !== 'object') throw new TypeError('the call must be an object');
  const parts = [];
  if (call.paths !== undefined && call.paths !== null) {
    if (!Array.isArray(call.paths)) throw new TypeError('call.paths must be an array');
    for (const entry of call.paths) {
      const e = entry !== null && typeof entry === 'object' ? entry : {};
      const repo = e.repo !== undefined ? e.repo : call.repo === undefined ? null : call.repo;
      parts.push({ type: 'path', path: asPath(e.path), access: asAccess(e.access), repo, cwd: asPath(call.cwd) });
    }
  }
  if (call.mcp !== undefined && call.mcp !== null) {
    parts.push({ type: 'mcp', name: typeof call.mcp === 'string' && call.mcp !== '' ? call.mcp : UNKNOWN });
  }
  if (call.url !== undefined && call.url !== null) parts.push({ type: 'url', domain: hostOf(call.url) });

  let opaque = null;
  if (normalized === null || normalized === undefined) {
    if (call.command !== undefined && call.command !== null) {
      throw new TypeError('a shell call arrived without a normalized reading');
    }
  } else if (typeof normalized === 'object' && Object.hasOwn(normalized, 'opaque')) {
    opaque = normalized.opaque !== null && typeof normalized.opaque === 'object' ? normalized.opaque : {};
  } else if (typeof normalized === 'object' && Array.isArray(normalized.commands)) {
    for (const c of normalized.commands) parts.push(commandPart(c));
  } else {
    throw new TypeError('normalized must be {commands}, {opaque} or null');
  }
  return { parts, opaque };
}

function readOptions(opts) {
  if (opts === null || typeof opts !== 'object') throw new TypeError('evaluate options are required');
  const ctx = opts.ctx;
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.home !== 'string' || !ctx.home.startsWith('/')) {
    throw new TypeError('evaluate needs ctx.home as an absolute path');
  }
  return {
    profile: opts.profile === undefined ? 'default' : opts.profile,
    grants: Array.isArray(opts.grants) ? opts.grants : [],
    home: ctx.home,
    platform: ctx.platform,
    ci: ctx.caseInsensitive === true,
    realpath: typeof ctx.realpath === 'function' ? ctx.realpath : nodeFs.realpathSync.native,
  };
}

function checkPolicyShape(policy) {
  const ok =
    policy !== null &&
    typeof policy === 'object' &&
    Array.isArray(policy.rules) &&
    policy.profiles !== null &&
    typeof policy.profiles === 'object' &&
    policy.branches !== null &&
    typeof policy.branches === 'object' &&
    Array.isArray(policy.branches.protected);
  if (!ok) throw new TypeError('the policy is not a validated policy');
}

// ---- part accessors ----------------------------------------------------------------------------

function pathsOf(part) {
  if (part.type === 'path') return [{ path: part.path, access: part.access }];
  if (part.type !== 'command') return [];
  return [
    ...part.reads.map((p) => ({ path: p, access: 'read' })),
    ...part.writes.map((p) => ({ path: p, access: 'write' })),
    ...part.ops.map((op) => ({ path: op.path, access: 'write' })),
  ];
}

function domainsOf(part) {
  if (part.type === 'command') return part.domains;
  if (part.type === 'url') return [part.domain];
  return [];
}

function writeTargets(part) {
  return pathsOf(part)
    .filter(({ access }) => access === 'write' || isUnknown(access))
    .map(({ path }) => path);
}

function repoRootOf(part) {
  const repo = part.repo;
  if (repo === null || typeof repo !== 'object' || isUnknown(repo)) return undefined;
  return typeof repo.root === 'string' && repo.root.startsWith('/') ? repo.root : undefined;
}

function cwdOf(part) {
  return typeof part.cwd === 'string' ? part.cwd : undefined;
}

// ---- glob matching -----------------------------------------------------------------------------

// Result for a glob that can not be resolved or compiled, per use.
const UNRESOLVED = { deny: true, allow: false, exceptDeny: false, exceptAllow: true };

const compiled = new Map();
const COMPILED_CAP = 2000;

function regexFor(glob, home) {
  const key = `${home}\u0000${glob}`;
  let re = compiled.get(key);
  if (!re) {
    re = compileGlob(glob, { home });
    if (compiled.size >= COMPILED_CAP) compiled.clear();
    compiled.set(key, re);
  }
  return re;
}

// True when `value` (a known string) matches one of `patterns` for a part. `kind` is "path",
// "domain" or "mcp"; `use` a key of UNRESOLVED.
function globHit(patterns, value, part, kind, use, o) {
  const vars = { home: o.home, repo: repoRootOf(part), cwd: cwdOf(part) };
  for (const pattern of patterns) {
    let forms;
    try {
      if (kind === 'path' && PER_CALL_PLACEHOLDER.test(pattern)) {
        forms = [resolveGlobPrefix(pattern, vars, o.realpath)];
        // A deny also meets the placeholder value as written (a dangling or unresolved link).
        if (use === 'deny') forms.push(resolveGlobPrefix(pattern, vars, noRealpath));
      } else if (PER_CALL_PLACEHOLDER.test(pattern)) {
        // Placeholders in a name glob: expanded to literal text, then compiled.
        forms = [resolveGlobPrefix(pattern, vars, noRealpath)];
      } else {
        forms = [pattern];
      }
      for (const form of forms) {
        let g = form;
        let v = value;
        let home = o.home;
        if (kind === 'domain') {
          g = g.toLowerCase();
        } else if (kind === 'path' && o.ci) {
          g = fold(g, true);
          v = fold(v, true);
          home = fold(home, true);
        }
        if (regexFor(g, home).test(v)) return true;
      }
    } catch {
      if (UNRESOLVED[use]) return true;
    }
  }
  return false;
}

// ---- deny rules --------------------------------------------------------------------------------

function accessMeetsDeny(ruleAccess, access) {
  if (ruleAccess === 'any' || isUnknown(access)) return true;
  return ruleAccess === access;
}

function accessMeetsAllow(ruleAccess, access) {
  if (isUnknown(access)) return false;
  return ruleAccess === 'any' || ruleAccess === access;
}

function hasClassDeny(part, classes) {
  return part.type === 'command' && part.classes.some((c) => isUnknown(c) || classes.includes(c));
}

function argvHitDeny(prefixes, part) {
  if (part.type !== 'command') return false;
  const argv = part.argv;
  return prefixes.some((prefix) => {
    for (let i = 0; i < prefix.length; i++) {
      const a = argv[i];
      // An Unknown word inside the prefix may stand for the rest of it (`git $X` may be
      // `git push --force`), so the remaining prefix words count as matched.
      if (isUnknown(a)) return true;
      if (a === undefined) return false;
      if (a === prefix[i]) continue;
      // A program named by path (`/bin/rm`) still meets a deny on its name.
      if (i === 0 && !prefix[i].includes('/') && nodePath.posix.basename(a) === prefix[i]) continue;
      return false;
    }
    return true;
  });
}

function ruleDeniesPart(rule, part, o) {
  const m = rule.match;
  const ex = rule.except;
  if (m.class && !hasClassDeny(part, m.class)) return false;
  if (m.argv && !argvHitDeny(m.argv, part)) return false;
  if (m.mcp) {
    if (part.type !== 'mcp') return false;
    if (!isUnknown(part.name) && !globHit(m.mcp, part.name, part, 'mcp', 'deny', o)) return false;
  }
  if (m.domains) {
    const hit = domainsOf(part).some(
      (d) =>
        isUnknown(d) ||
        (globHit(m.domains, d, part, 'domain', 'deny', o) && !(ex?.domains && globHit(ex.domains, d, part, 'domain', 'exceptDeny', o))),
    );
    if (!hit) return false;
  }
  if (m.paths) {
    const access = m.access ?? 'any';
    const hit = pathsOf(part).some(
      ({ path, access: a }) =>
        accessMeetsDeny(access, a) &&
        (isUnknown(path) ||
          (globHit(m.paths, path, part, 'path', 'deny', o) && !(ex?.paths && globHit(ex.paths, path, part, 'path', 'exceptDeny', o)))),
    );
    if (!hit) return false;
  }
  // An `except` key with no matching `match` key excuses the part only when every one of its
  // paths (domains) is known and excepted.
  if (ex?.paths && !m.paths && exceptKindAllowed(m, 'paths')) {
    const ps = pathsOf(part);
    if (ps.length > 0 && ps.every(({ path }) => !isUnknown(path) && globHit(ex.paths, path, part, 'path', 'exceptDeny', o))) return false;
  }
  if (ex?.domains && !m.domains && exceptKindAllowed(m, 'domains')) {
    const ds = domainsOf(part);
    if (ds.length > 0 && ds.every((d) => !isUnknown(d) && globHit(ex.domains, d, part, 'domain', 'exceptDeny', o))) return false;
  }
  return true;
}

// ---- allow rules -------------------------------------------------------------------------------

// True when any effect of the part is a value fence could not determine.
function hasUnknownEffect(part) {
  if (part.type === 'command') {
    return (
      part.argv.some(isUnknown) ||
      part.classes.some(isUnknown) ||
      part.domains.some(isUnknown) ||
      pathsOf(part).some(({ path }) => isUnknown(path))
    );
  }
  if (part.type === 'path') return isUnknown(part.path) || isUnknown(part.access);
  if (part.type === 'url') return isUnknown(part.domain);
  if (part.type === 'mcp') return isUnknown(part.name);
  return true;
}

// An allow rule covers a part only when every match key holds on it and every effect of the
// part is judged by the rule: path effects by `paths` (all of them, compatible access), domains
// by `domains`, the MCP tool by `mcp`, and each class by an explicit `class` entry (an `argv`
// match alone also covers ARGV_COVERED_CLASSES). Any Unknown effect blocks coverage.
function ruleCoversPart(rule, part, o) {
  const m = rule.match;
  const ex = rule.except;
  if (hasUnknownEffect(part)) return false;

  let argvMatched = false;
  if (m.argv) {
    if (part.type !== 'command') return false;
    const argv = part.argv;
    if (!m.argv.some((prefix) => prefix.every((w, i) => argv[i] === w))) return false;
    argvMatched = true;
  }
  if (m.class && (part.type !== 'command' || !part.classes.some((c) => m.class.includes(c)))) return false;
  if (part.type === 'command') {
    const classOk = (c) => (m.class && m.class.includes(c)) || (argvMatched && ARGV_COVERED_CLASSES.includes(c));
    if (!part.classes.every(classOk)) return false;
  }

  if (part.type === 'mcp' || m.mcp) {
    if (part.type !== 'mcp' || !m.mcp) return false;
    if (!globHit(m.mcp, part.name, part, 'mcp', 'allow', o)) return false;
  }

  const ds = domainsOf(part);
  if (ds.length > 0 || m.domains) {
    if (!m.domains || ds.length === 0) return false;
    const domainOk = (d) =>
      globHit(m.domains, d, part, 'domain', 'allow', o) && !(ex?.domains && globHit(ex.domains, d, part, 'domain', 'exceptAllow', o));
    if (!ds.every(domainOk)) return false;
  }

  const ps = pathsOf(part);
  if (ps.length > 0 || m.paths) {
    if (!m.paths || ps.length === 0) return false;
    const access = m.access ?? 'any';
    const pathOk = ({ path, access: a }) =>
      accessMeetsAllow(access, a) &&
      globHit(m.paths, path, part, 'path', 'allow', o) &&
      !(ex?.paths && globHit(ex.paths, path, part, 'path', 'exceptAllow', o));
    if (!ps.every(pathOk)) return false;
  }
  return true;
}

// ---- built-in rules ----------------------------------------------------------------------------

function projectRootsOf(parts) {
  const roots = new Set();
  for (const part of parts) {
    if (part.repo !== null && part.repo !== undefined) {
      // An Unknown repo or root reaches the checks as a non-absolute root: they deny writes.
      roots.add(typeof part.repo === 'object' && !isUnknown(part.repo) && typeof part.repo.root === 'string' ? part.repo.root : UNKNOWN);
    }
    if (typeof part.cwd === 'string') roots.add(part.cwd);
  }
  return [...roots];
}

function grantFor(target, o) {
  if (isUnknown(target)) return null;
  const t = fold(target, o.ci);
  return o.grants.find((g) => g !== null && typeof g === 'object' && typeof g.path === 'string' && fold(g.path, o.ci) === t) ?? null;
}

// A command part a grant alone covers: its only effects are writes a grant lifted (no reads,
// ops, domains or Unknown values) and its only class, if any, is `overwrite`.
function grantOnlyCommand(part, lifted) {
  return (
    lifted === part.writes.length &&
    lifted > 0 &&
    part.reads.length === 0 &&
    part.ops.length === 0 &&
    part.domains.length === 0 &&
    !part.argv.some(isUnknown) &&
    part.classes.every((c) => c === 'overwrite')
  );
}

// Returns {deny} or {granted: Set<part>}: parts whose effects are only writes a grant lifted.
function builtinCheck(parts, o) {
  const bopts = { home: o.home, platform: o.platform, caseInsensitive: o.ci, projectRoots: projectRootsOf(parts), realpath: o.realpath };
  const granted = new Set();
  const writeCheck = (target) => {
    const r = checkPathWrite(target, bopts);
    if (r && r.rule === SELF && grantFor(target, o)) return { lifted: true };
    return r ? { deny: r } : {};
  };
  for (const part of parts) {
    if (part.type === 'command') {
      const r = checkCommandArgv(part.argv);
      if (r) return { deny: r };
      let lifted = 0;
      for (const w of part.writes) {
        const c = writeCheck(w);
        if (c.deny) return c;
        if (c.lifted) lifted++;
      }
      for (const op of part.ops) {
        const r2 = checkAncestorOp(op.path, op.op, bopts);
        if (r2) return { deny: r2 };
      }
      if (grantOnlyCommand(part, lifted)) granted.add(part);
    } else if (part.type === 'path' && part.access !== 'read') {
      const c = writeCheck(part.path);
      if (c.deny) return c;
      if (c.lifted && part.access === 'write') granted.add(part);
    }
  }
  return { granted };
}

// The protected state of a part's repo: null (no repo or not protected) or the branch shown.
function protectedBranch(repo, list) {
  if (repo === null || repo === undefined) return null;
  if (typeof repo !== 'object' || isUnknown(repo)) return { branch: SHOW_UNKNOWN };
  const b = repo.branch;
  if (b === null) return null;
  if (typeof b !== 'string') return { branch: SHOW_UNKNOWN };
  return list.includes(b) ? { branch: b } : null;
}

function insideRepo(target, repo, o) {
  if (isUnknown(target)) return true;
  const root = repo !== null && typeof repo === 'object' && !isUnknown(repo) ? repo.root : undefined;
  if (typeof root !== 'string' || !root.startsWith('/')) return true;
  const t = fold(target, o.ci);
  const r = fold(root.replace(/\/+$/, ''), o.ci);
  return r === '' || t === r || t.startsWith(`${r}/`);
}

function branchCheck(parts, policy, o) {
  const list = policy.branches.protected;
  const shownList = list.length ? list.join(', ') : '(none)';
  for (const part of parts) {
    const prot = protectedBranch(part.repo, list);
    if (!prot) continue;
    const name = prot.branch === SHOW_UNKNOWN ? 'a branch fence could not determine' : `the protected branch "${prot.branch}"`;
    if (hasClassDeny(part, ['vcs-write'])) {
      return {
        rule: 'builtin:protected-branch',
        reason: `"${showArgv(part.argv)}" changes history on ${name} (protected: ${shownList}); work on a feature branch.`,
      };
    }
    if (policy.branches.denyFileWrites === true) {
      const target = writeTargets(part).find((w) => insideRepo(w, part.repo, o));
      if (target !== undefined) {
        return {
          rule: 'builtin:protected-branch',
          reason: `Writing ${isUnknown(target) ? 'an undetermined file' : target} inside a repository on ${name} is denied (protected: ${shownList}; branches.denyFileWrites is on); work on a feature branch.`,
        };
      }
    }
  }
  return null;
}

// ---- scope -------------------------------------------------------------------------------------

const show = (v) => (isUnknown(v) ? SHOW_UNKNOWN : v);
const showArgv = (argv) => argv.map(show).join(' ');

function vcsName(argv) {
  if (argv.length === 0) return SHOW_UNKNOWN;
  const prog = isUnknown(argv[0]) ? SHOW_UNKNOWN : nodePath.posix.basename(argv[0]);
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i];
    if (isUnknown(w)) return `${prog} ${SHOW_UNKNOWN}`;
    if (prog === 'git' && GIT_VALUE_FLAGS.has(w)) {
      i++;
      continue;
    }
    if (!w.startsWith('-')) return `${prog} ${w}`;
  }
  return prog;
}

function emptyScope() {
  return { reads: [], writes: [], deletes: [], domains: [], vcs: [], mcp: [], runsRepoCode: false };
}

function computeScope(parts) {
  const sets = { reads: new Set(), writes: new Set(), deletes: new Set(), domains: new Set(), vcs: new Set(), mcp: new Set() };
  let runsRepoCode = false;
  for (const part of parts) {
    if (part.type === 'path') {
      sets[part.access === 'read' ? 'reads' : 'writes'].add(show(part.path));
    } else if (part.type === 'mcp') {
      sets.mcp.add(show(part.name));
    } else if (part.type === 'url') {
      sets.domains.add(show(part.domain));
    } else {
      for (const p of part.reads) sets.reads.add(show(p));
      for (const p of part.writes) sets.writes.add(show(p));
      for (const op of part.ops) sets[op.op === 'delete' ? 'deletes' : 'writes'].add(show(op.path));
      for (const d of part.domains) sets.domains.add(show(d));
      if (part.classes.includes('vcs-write')) sets.vcs.add(vcsName(part.argv));
      if (part.classes.includes('runs-repo-code')) runsRepoCode = true;
    }
  }
  const out = emptyScope();
  for (const key of Object.keys(sets)) out[key] = [...sets[key]];
  out.runsRepoCode = runsRepoCode;
  return out;
}

// ---- decision ----------------------------------------------------------------------------------

const deny = (rule, reason) => ({ decision: 'deny', rule, reason });

function decide(policy, parts, opaque, o) {
  checkPolicyShape(policy);
  if (typeof o.profile !== 'string' || !Object.hasOwn(policy.profiles, o.profile)) {
    const name = typeof o.profile === 'string' ? o.profile : String(o.profile);
    return deny(
      'builtin:unknown-profile',
      `The fence profile ${JSON.stringify(name)} (FENCE_PROFILE) is not defined in the policy (defined: ${Object.keys(policy.profiles).join(', ')}); every call is denied until it is fixed.`,
    );
  }

  const builtin = builtinCheck(parts, o);
  if (builtin.deny) return deny(builtin.deny.rule, builtin.deny.reason);

  if (opaque) {
    const reason = typeof opaque.reason === 'string' ? opaque.reason : 'unknown reason';
    const construct = typeof opaque.construct === 'string' ? opaque.construct : 'unknown construct';
    return deny('builtin:opaque', `fence could not tell what this command would run (${reason}: ${construct}); commands fence can not read are always denied.`);
  }

  const branch = branchCheck(parts, policy, o);
  if (branch) return deny(branch.rule, branch.reason);

  for (const rule of policy.rules) {
    if (rule.decision !== 'deny') continue;
    if (parts.some((part) => ruleDeniesPart(rule, part, o))) {
      return deny(rule.id, `${rule.why} (fence rule "${rule.id}")`);
    }
  }

  if (parts.length > 0) {
    const allows = policy.rules.filter((r) => r.decision === 'allow');
    const covering = [];
    for (const part of parts) {
      if (builtin.granted.has(part)) {
        covering.push('grant');
        continue;
      }
      const r = allows.find((rule) => ruleCoversPart(rule, part, o));
      if (!r) {
        covering.length = 0;
        break;
      }
      covering.push(r.id);
    }
    if (covering.length === parts.length) {
      // A grant that took part in the allow is what the log and the engine need to see.
      if (covering.includes('grant')) {
        return { decision: 'allow', rule: 'grant', reason: 'A human granted this one write with fence allow-once.' };
      }
      const ruleId = covering[0];
      return { decision: 'allow', rule: ruleId, reason: `${allows.find((r) => r.id === ruleId).why} (fence rule "${ruleId}")` };
    }
  }

  if (policy.profiles[o.profile].undecided === 'deny') {
    return deny('builtin:profile', `No fence rule decided this call and the active profile ${JSON.stringify(o.profile)} denies undecided calls.`);
  }
  return { decision: 'undecided', rule: null, reason: "No fence rule decided this call; the host's normal permission flow applies." };
}

export function evaluate(policy, call, normalized, opts) {
  let scope = emptyScope();
  try {
    const o = readOptions(opts);
    const { parts, opaque } = buildParts(call, normalized);
    scope = computeScope(parts);
    return { ...decide(policy, parts, opaque, o), scope };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: 'deny',
      rule: 'builtin:internal-error',
      reason: `fence could not evaluate this call (${message}); it is denied.`,
      scope,
    };
  }
}
