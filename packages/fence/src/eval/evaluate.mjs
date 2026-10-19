// Evaluator: applies the spec's precedence, under the active mode, to one canonical call (trusted path).
//
// evaluate(policy, call, normalized, {profile, grants, ctx, modeOf, raw})
//   -> {decision, rule, reason, scope, lifted?, wouldDeny?, category?, floor?, marker?}
//   lifted      only on a non-deny decision that a grant made possible: [{path, grant}], each
//               distinct path whose built-in self-protection deny a grant lifted, with the grant
//   wouldDeny   the audited denies met (at most 8): [{rule, category, construct?, certain?, reason}];
//               `category` is opaque | selfProtection | rules; `certain: true` on a rule or
//               protected-branch match that needed no Unknown (audited by `certain` or the rule's action)
//   floor       true on a floor deny (no mode relaxes it); `marker` the switch-off marker matched
//   category    on a returned uncertain deny: opaque | selfProtection | rules
//   policy      a validated policy (loadPolicy or validatePolicy output)
//   call        the canonical call; file tools give `paths: [{path, access, repo?}]` (absolute
//               realpaths; `repo` per path, else `call.repo`), MCP calls `mcp` (the tool name),
//               fetches `url`
//   normalized  {commands: EffectiveCommand[]} | {opaque: {reason, construct}} | null (no shell)
//   profile     the active profile (mode) name (default "default"); an unknown name denies every call
//   grants      allow-once grants already loaded and checked by the caller: [{path, ...}]
//   ctx         {home, platform, caseInsensitive, realpath?, envProfileSet?}; envProfileSet is true
//               when FENCE_PROFILE is set in the hook environment
//   modeOf      dir -> mode name | null (null: the dir's mode can not be resolved, counts as
//               different); omitted, every dir is in the active mode
//   raw         the call's command text (the switch-off marker and host-config tests read it)
//
// A call is a list of parts: each effective command, each file a file tool touches, the MCP
// tool, the fetched URL. Precedence:
//   0. a grant for the exact realpath lifts the built-in self-protection deny on that write
//   1. the floor, scanned over every part and target before anything else counts: an unknown
//      profile; a built-in deny marked floor (resolved self-protection, host config, fence
//      commands); the opaque reasons internal, size and depth and the host-config-var construct;
//      an opaque call without its raw text, or whose raw text sets, unsets or clears a
//      host-config name; an opaque call or an uncertain self-protection deny whose raw text names
//      a switch-off marker; a claude/codex part whose cwd maps to another mode (unless
//      ctx.envProfileSet). An internal error.
//   2. uncertain self-protection -> the mode's selfProtection action
//   3. opaque -> the mode's constructs[construct], else its opaque action
//   4. deny rules in policy order: the effective action is the mode's rules[id], else the rule's
//      decision; off skips. Then the protected-branch rule, whose effective action is always deny
//      (a mode's `rules` can not name it). Deny only when the effective action and the category
//      action (certain, or uncertain.rules) are both deny, else audit
//   5. any audited deny -> undecided under the mode's `undecided` (no allow rule applies)
//   6. allow, only when every part is covered by some allow rule or by a grant (rule "grant",
//      under every profile); an allow rule covers a part only when it judges every effect
//   7. undecided -> the mode (`host` -> undecided, `deny` -> deny)
// The first returned deny ends evaluation; an audited deny is only listed in wouldDeny.
// Unknown (a value the normalizer could not determine, or a malformed value from the caller)
// satisfies every deny predicate and no allow predicate or `except`. An unresolvable
// `${repo}`/`${cwd}` makes a deny glob match, an allow glob not match, a deny rule's except not
// match and an allow rule's except match (it can not be ruled out). A rule match is certain only
// when it holds without any of these (no Unknown value, guessed class, Unknown program or
// unresolved placeholder); otherwise it is uncertain. evaluate never throws: an internal error is
// a floor deny (`builtin:internal-error`).

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { compileGlob, resolveGlobPrefix } from '../match/glob.mjs';
import { UNKNOWN, isUnknown } from '../norm/unknown.mjs';
import { ARGV_COVERED_CLASSES, exceptKindAllowed } from '../policy/classes.mjs';
import { foldCase } from '../resolve/paths.mjs';
import { checkAncestorOp, checkCommandArgv, checkPathWrite, programName } from './builtin.mjs';
import { namesSwitchOff } from './markers.mjs';

const SELF = 'builtin:self-protection';
const OPAQUE = 'builtin:opaque';
const BRANCH = 'builtin:protected-branch';
// Opaque reasons that mean the normalizer itself failed or hit a limit: floor.
const FLOOR_OPAQUE_REASONS = new Set(['internal', 'size', 'depth']);
const HOST_CONFIG_VAR = 'host-config-var';
const WOULD_DENY_CAP = 8;
const HOST_PROGRAMS = new Set(['claude', 'codex']);
const SHOW_UNKNOWN = '<unknown>';
const PER_CALL_PLACEHOLDER = /\$\{(?:repo|cwd)\}/;
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

const noRealpath = () => {
  throw new Error('no realpath');
};

// ---- input normalisation -----------------------------------------------------------------------

// The resolver's full case fold (NFC + upper + lower on a case-insensitive volume), the same one
// builtin.mjs and the engine use, so a grant matches here exactly when it matches there.
const fold = foldCase;

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
    // classes given only because of an Unknown word: a match on one is uncertain
    guessed: listOf(c.guessedClasses, asWord),
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
  if (opts.modeOf !== undefined && opts.modeOf !== null && typeof opts.modeOf !== 'function') {
    throw new TypeError('evaluate modeOf must be a function');
  }
  return {
    profile: opts.profile === undefined ? 'default' : opts.profile,
    // null: every dir is in the active mode
    modeOf: typeof opts.modeOf === 'function' ? opts.modeOf : null,
    raw: typeof opts.raw === 'string' ? opts.raw : null,
    envProfileSet: ctx.envProfileSet === true,
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

// Result for a glob that can not be resolved or compiled, per use. `certainDeny` and
// `certainExceptDeny` are the uses of a certain deny match: an unresolved glob can not make it.
const UNRESOLVED = { deny: true, allow: false, exceptDeny: false, exceptAllow: true, certainDeny: false, certainExceptDeny: true };

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
        if (use === 'deny' || use === 'certainDeny') forms.push(resolveGlobPrefix(pattern, vars, noRealpath));
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

function accessMeetsDeny(ruleAccess, access, certain = false) {
  if (ruleAccess === 'any' || (!certain && isUnknown(access))) return true;
  return ruleAccess === access;
}

function accessMeetsAllow(ruleAccess, access) {
  if (isUnknown(access)) return false;
  return ruleAccess === 'any' || ruleAccess === access;
}

// With `certain`, only a known class the normalizer did not guess counts.
function hasClassDeny(part, classes, certain = false) {
  if (part.type !== 'command') return false;
  if (certain) return part.classes.some((c) => !isUnknown(c) && classes.includes(c) && !part.guessed.includes(c));
  return part.classes.some((c) => isUnknown(c) || classes.includes(c));
}

function argvHitDeny(prefixes, part, certain = false) {
  if (part.type !== 'command') return false;
  const argv = part.argv;
  return prefixes.some((prefix) => {
    for (let i = 0; i < prefix.length; i++) {
      const a = argv[i];
      // An Unknown word inside the prefix may stand for the rest of it (`git $X` may be
      // `git push --force`), so the remaining prefix words count as matched (not certainly).
      if (isUnknown(a)) return !certain;
      if (a === undefined) return false;
      if (a === prefix[i]) continue;
      // A program named by path (`/bin/rm`) still meets a deny on its name.
      if (i === 0 && !prefix[i].includes('/') && nodePath.posix.basename(a) === prefix[i]) continue;
      return false;
    }
    return true;
  });
}

// True when the deny rule matches the part. With `certain`, only a match that needs no Unknown
// value, guessed class, Unknown program or unresolved placeholder counts (every certain match is
// also a match).
function ruleDeniesPart(rule, part, o, certain = false) {
  const m = rule.match;
  const ex = rule.except;
  const use = certain ? 'certainDeny' : 'deny';
  const exUse = certain ? 'certainExceptDeny' : 'exceptDeny';
  // An Unknown value satisfies a deny predicate, but not certainly.
  const unknownHit = (v) => !certain && isUnknown(v);
  if (certain && part.type === 'command' && part.argv.length > 0 && isUnknown(part.argv[0])) return false;
  if (m.class && !hasClassDeny(part, m.class, certain)) return false;
  if (m.argv && !argvHitDeny(m.argv, part, certain)) return false;
  if (m.mcp) {
    if (part.type !== 'mcp') return false;
    if (isUnknown(part.name) ? certain : !globHit(m.mcp, part.name, part, 'mcp', use, o)) return false;
  }
  if (m.domains) {
    const hit = domainsOf(part).some(
      (d) =>
        unknownHit(d) ||
        (!isUnknown(d) && globHit(m.domains, d, part, 'domain', use, o) && !(ex?.domains && globHit(ex.domains, d, part, 'domain', exUse, o))),
    );
    if (!hit) return false;
  }
  if (m.paths) {
    const access = m.access ?? 'any';
    const hit = pathsOf(part).some(
      ({ path, access: a }) =>
        accessMeetsDeny(access, a, certain) &&
        (unknownHit(path) ||
          (!isUnknown(path) && globHit(m.paths, path, part, 'path', use, o) && !(ex?.paths && globHit(ex.paths, path, part, 'path', exUse, o)))),
    );
    if (!hit) return false;
  }
  // An `except` key with no matching `match` key excuses the part only when every one of its
  // paths (domains) is known and excepted. For a certain match an Unknown one may be excepted.
  const excused = (v, patterns, kind) => (isUnknown(v) ? certain : globHit(patterns, v, part, kind, exUse, o));
  if (ex?.paths && !m.paths && exceptKindAllowed(m, 'paths')) {
    const ps = pathsOf(part);
    if (ps.length > 0 && ps.every(({ path }) => excused(path, ex.paths, 'path'))) return false;
  }
  if (ex?.domains && !m.domains && exceptKindAllowed(m, 'domains')) {
    const ds = domainsOf(part);
    if (ds.length > 0 && ds.every((d) => excused(d, ex.domains, 'domain'))) return false;
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

// Scans every part and target. Returns {deny} for the first floor deny, else {granted: Set<part>,
// lifted: [{path, grant}], uncertain: [deny]}: `granted` holds the parts whose effects are only
// writes a grant lifted; `lifted` each distinct path a grant lifted the self-protection deny on,
// with that grant (the engine reserves exactly these); `uncertain` the built-in denies outside the
// floor (an unresolved target or root), in part order. A deny without a `floor` mark is floor.
function builtinCheck(parts, o) {
  const bopts = { home: o.home, platform: o.platform, caseInsensitive: o.ci, projectRoots: projectRootsOf(parts), realpath: o.realpath };
  const granted = new Set();
  const lifts = new Map();
  const uncertain = [];
  // the deny when it is floor; an uncertain one is kept for later
  const floorOf = (r) => {
    if (!r) return null;
    if (r.floor === false) {
      uncertain.push(r);
      return null;
    }
    return r;
  };
  const writeCheck = (target) => {
    const r = checkPathWrite(target, bopts);
    if (r && r.rule === SELF) {
      const grant = grantFor(target, o);
      if (grant) {
        const key = fold(target, o.ci);
        if (!lifts.has(key)) lifts.set(key, { path: target, grant });
        return { lifted: true };
      }
    }
    const deny = floorOf(r);
    return deny ? { deny } : {};
  };
  for (const part of parts) {
    if (part.type === 'command') {
      const r = floorOf(checkCommandArgv(part.argv));
      if (r) return { deny: r };
      let lifted = 0;
      for (const w of part.writes) {
        const c = writeCheck(w);
        if (c.deny) return c;
        if (c.lifted) lifted++;
      }
      for (const op of part.ops) {
        const r2 = floorOf(checkAncestorOp(op.path, op.op, bopts));
        if (r2) return { deny: r2 };
      }
      if (grantOnlyCommand(part, lifted)) granted.add(part);
    } else if (part.type === 'path' && part.access !== 'read') {
      const c = writeCheck(part.path);
      if (c.deny) return c;
      if (c.lifted && part.access === 'write') granted.add(part);
    }
  }
  return { granted, lifted: [...lifts.values()], uncertain };
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

// A write target certainly inside a known repository root.
function insideRepoCertain(target, repo, o) {
  if (isUnknown(target)) return false;
  const root = repo !== null && typeof repo === 'object' && !isUnknown(repo) ? repo.root : undefined;
  if (typeof root !== 'string' || !root.startsWith('/')) return false;
  return insideRepo(target, repo, o);
}

// The protected-branch hit of one part, or null: {rule, reason, certain}. It is certain only on a
// known protected branch of a known repository, by a known (not guessed) class or a known target
// inside the known root, with a known program.
function branchHit(part, policy, list, shownList, o) {
  const prot = protectedBranch(part.repo, list);
  if (!prot) return null;
  const knownBranch = prot.branch !== SHOW_UNKNOWN && !(part.type === 'command' && part.argv.length > 0 && isUnknown(part.argv[0]));
  const name = prot.branch === SHOW_UNKNOWN ? 'a branch fence could not determine' : `the protected branch "${prot.branch}"`;
  if (hasClassDeny(part, ['vcs-write'])) {
    return {
      rule: BRANCH,
      reason: `"${showArgv(part.argv)}" changes history on ${name} (protected: ${shownList}); work on a feature branch.`,
      certain: knownBranch && hasClassDeny(part, ['vcs-write'], true),
    };
  }
  if (policy.branches.denyFileWrites === true) {
    const targets = writeTargets(part);
    const target = targets.find((w) => insideRepo(w, part.repo, o));
    if (target !== undefined) {
      return {
        rule: BRANCH,
        reason: `Writing ${isUnknown(target) ? 'an undetermined file' : target} inside a repository on ${name} is denied (protected: ${shownList}; branches.denyFileWrites is on); work on a feature branch.`,
        certain: knownBranch && targets.some((w) => insideRepoCertain(w, part.repo, o)),
      };
    }
  }
  return null;
}

// The protected-branch deny of the call, or null: the first certain hit, else the first hit.
function branchCheck(parts, policy, o) {
  const list = policy.branches.protected;
  const shownList = list.length ? list.join(', ') : '(none)';
  let first = null;
  for (const part of parts) {
    const hit = branchHit(part, policy, list, shownList, o);
    if (!hit) continue;
    if (hit.certain) return hit;
    first ??= hit;
  }
  return first;
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

// ---- host-config net ---------------------------------------------------------------------------
//
// setsHostConfig(raw): true when the raw text of an opaque call assigns, unsets or clears a
// host-config variable. A linear word scan, no backtracking regex: the text is split into simple
// commands on `;` `|` `&` `(` `)` `{` `}` newline and backtick (so `&&`, `||` and `$(` too; not the
// braces of `${…}`, not the `&` of `>&`, `<&` or `&>`), each into words on whitespace and `<`/`>` (a
// redirection target and an fd number before `<`/`>` are dropped; quotes are stripped from a word's
// ends). It does not parse quoting: text inside quotes is scanned like any other, which can only add
// floor denies on a call fence already could not read. Nested shell text (eval, `sh -c` and other
// shells, `env -S`, find's -exec) is followed up to MAX_NEST levels; deeper nesting is a floor deny.
// A command word is matched by its program name, so `/usr/bin/env` and `\env` are env.

const HOST_NAMES = new Set(['HOME', 'FENCE_PROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_DIRS', 'CODEX_HOME']);
// A word in a name position: a host-config name, an XDG_ name, or a value fence can not read (`$X`).
const isHostName = (n) => typeof n === 'string' && (HOST_NAMES.has(n) || n.startsWith('XDG_') || n.startsWith('$'));

const SEPARATORS = new Set([';', '|', '&', '(', ')', '{', '}', '\n', '`']);
const SPACES = new Set([' ', '\t', '\r', '\v', '\f']);
const QUOTES = new Set(['"', "'"]);
// Reserved words that may start a simple command before its assignments.
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
// Wrappers skipped before the command word, with their flags that take a value word.
const WRAPPERS = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  // timeout also takes its duration word (skipped after the flags)
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  setsid: new Set(),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--replace', '--eof']),
};
const ENV_VALUE_FLAGS = 'uCSP';
const ENV_LONG_VALUE_FLAGS = new Set(['--unset', '--chdir', '--split-string', '--default-signal', '--ignore-signal', '--block-signal']);
// Shells whose `-c` string is scanned as commands; `-o`/`+o` take an option name.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_VALUE_FLAGS = new Set(['--rcfile', '--init-file', '-o', '+o', '-O', '+O']);
// find's actions that run a command, up to a `;`, `\;` or `+` word (`\` when the split cut `\;`).
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_ENDS = new Set([';', '\\;', '+', '\\']);
// How deep nested shell text (eval, sh -c, env -S) is followed; deeper text can not be checked: floor.
const MAX_NEST = 8;
// Builtins whose operands (after flags) name variables they assign, unset or export.
const NAMING_BUILTINS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'unset', 'export', 'declare', 'typeset', 'local', 'readonly', 'let']);
const DECLARING = new Set(['declare', 'typeset', 'local']);

const isNameStart = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isNameChar = (c) => isNameStart(c) || (c >= '0' && c <= '9');

function stripQuotes(w) {
  let a = 0;
  let b = w.length;
  while (a < b && QUOTES.has(w[a])) a++;
  while (b > a && QUOTES.has(w[b - 1])) b--;
  return w.slice(a, b);
}

// The simple commands of the text, each a list of words.
function simpleCommands(raw) {
  const cmds = [];
  let words = [];
  let start = -1;
  let redirect = false;
  const endWord = (at, dropFd = false) => {
    if (start === -1) return;
    const w = stripQuotes(raw.slice(start, at));
    start = -1;
    if (dropFd && /^\d+$/.test(w)) return;
    if (redirect) redirect = false;
    else if (w !== '') words.push(w);
  };
  const endCommand = (at) => {
    endWord(at);
    if (words.length > 0) cmds.push(words);
    words = [];
    redirect = false;
  };
  // open `${` expansions: their braces are word text, not separators
  let params = 0;
  const wordChar = (i) => {
    if (start === -1) start = i;
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '$' && raw[i + 1] === '{') {
      params++;
      wordChar(i);
      i++;
    } else if (c === '}' && params > 0) {
      params--;
      wordChar(i);
    } else if (c === '<' || c === '>' || (c === '&' && (raw[i + 1] === '>' || raw[i - 1] === '<' || raw[i - 1] === '>'))) {
      // a redirection operator: `<`, `>`, and the `&` of `>&`, `<&`, `&>` (not a command separator)
      endWord(i, true);
      redirect = true;
    } else if (SEPARATORS.has(c)) endCommand(i);
    else if (SPACES.has(c)) endWord(i);
    else wordChar(i);
  }
  endCommand(raw.length);
  return cmds;
}

// The name an assignment word assigns (`NAME=`, `NAME+=`, `NAME[…]=`, `NAME[…]+=`), else null.
function assignmentName(w) {
  if (!isNameStart(w[0] ?? '')) return null;
  let j = 1;
  while (j < w.length && isNameChar(w[j])) j++;
  const name = w.slice(0, j);
  if (w[j] === '[') {
    const close = w.indexOf(']', j);
    if (close === -1) return null;
    j = close + 1;
  }
  if (w[j] === '+') j++;
  return w[j] === '=' ? name : null;
}

// True when the word holds `${NAME=` or `${NAME:=` for a host-config NAME.
function defaultAssigns(w) {
  for (let k = w.indexOf('${'); k !== -1; k = w.indexOf('${', k + 2)) {
    let j = k + 2;
    while (j < w.length && isNameChar(w[j])) j++;
    const name = w.slice(k + 2, j);
    if (name !== '' && isHostName(name) && (w[j] === '=' || (w[j] === ':' && w[j + 1] === '='))) return true;
  }
  return false;
}

// The name part of a builtin operand: up to its first `=`, `+=` or `[`.
function operandName(w) {
  let j = 0;
  while (j < w.length && w[j] !== '=' && w[j] !== '[' && !(w[j] === '+' && w[j + 1] === '=')) j++;
  return w.slice(0, j);
}

// Skips a wrapper's flags (and the value words of `valueFlags`); returns the next index.
function skipFlags(words, i, valueFlags) {
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '--') return i + 1;
    i += valueFlags.has(words[i]) ? 2 : 1;
  }
  return i;
}

// env's options: {floor} when they clear the environment or unset a host-config name; {nested} (the
// words of a `-S` string, from its value word on) to scan as commands; else {next}, the index of the
// first word after them (an assignment or the program).
function envOptions(words, i) {
  // the -S / --split-string string: its value word (attached or not) and the words after it
  const split = (value, at) => ({ nested: value === undefined ? words.slice(at) : [value, ...words.slice(at)] });
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '-' || w === '--ignore-environment') return { floor: true };
    if (w === '--') return { next: i + 1 };
    if (!w.startsWith('-')) return { next: i };
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const flag = eq === -1 ? w : w.slice(0, eq);
      if (flag === '--split-string') return eq === -1 ? split(undefined, i + 1) : split(w.slice(eq + 1), i + 1);
      const value = eq === -1 ? (ENV_LONG_VALUE_FLAGS.has(flag) ? words[++i] : undefined) : w.slice(eq + 1);
      if (flag === '--unset' && isHostName(value ?? '')) return { floor: true };
      continue;
    }
    for (let k = 1; k < w.length; k++) {
      const c = w[k];
      if (c === 'i') return { floor: true };
      if (ENV_VALUE_FLAGS.includes(c)) {
        if (c === 'S') return k + 1 < w.length ? split(w.slice(k + 1), i + 1) : split(undefined, i + 1);
        const value = k + 1 < w.length ? w.slice(k + 1) : words[++i];
        if (c === 'u' && isHostName(value ?? '')) return { floor: true };
        break;
      }
    }
  }
  return { next: i };
}

// A shell's options: the index of its `-c` string's first word, or -1 when it runs no `-c` string.
function shellCommandStart(words, i) {
  let c = false;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--' || w === '-') return c ? i + 1 : -1;
    if (!(w.startsWith('-') || w.startsWith('+'))) return c ? i : -1;
    // --rcfile / --init-file take a file, -o / +o and -O / +O an option name
    if (SHELL_VALUE_FLAGS.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith('--')) continue;
    if (w.slice(1).includes('c')) c = true;
  }
  return -1;
}

// exec's options: {clears} when a short-flag cluster holds `c`; `-a` takes a value word.
function execOptions(words, i) {
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') return { clears: false, next: i + 1 };
    if (!w.startsWith('-') || w === '-') return { clears: false, next: i };
    for (let k = 1; k < w.length; k++) {
      if (w[k] === 'c') return { clears: true, next: i };
      if (w[k] === 'a') {
        if (k + 1 === w.length) i++;
        break;
      }
    }
  }
  return { clears: false, next: i };
}

// True when a builtin command word names a host-config variable among its operands.
function builtinNames(cmd, words, i) {
  if (cmd === 'for' || cmd === 'select') return isHostName(operandName(words[i] ?? ''));
  if (cmd === 'printf') {
    for (; i < words.length; i++) {
      const w = words[i];
      if (w === '-v') return isHostName(words[i + 1] ?? '');
      if (w.startsWith('-v')) return isHostName(w.slice(2));
      if (w === '--' || !w.startsWith('-')) return false;
    }
    return false;
  }
  if (!NAMING_BUILTINS.has(cmd)) return false;
  let nameref = false;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-') || (DECLARING.has(cmd) && w.startsWith('+'))) {
      if (DECLARING.has(cmd) && w.startsWith('-') && w.includes('n')) nameref = true;
      continue;
    }
    if (isHostName(operandName(w))) return true;
    // `declare -n r=HOME` makes r an alias of HOME
    if (nameref) {
      const eq = w.indexOf('=');
      if (eq !== -1 && isHostName(w.slice(eq + 1))) return true;
    }
  }
  return false;
}

// True when the simple command `words` (from `i`) sets, unsets or clears a host-config name. Nested
// shell text (eval's words, a shell's `-c` string, env's `-S` string) is scanned as a command from
// where it starts: the top-level split already cut every separator, quoted or not, so the words
// that follow are the nested text's own words and need no second split. `depth` counts the nesting.
function scanCommand(words, i, depth) {
  if (depth > MAX_NEST) return true;
  while (i < words.length) {
    const w = words[i];
    const assigned = assignmentName(w);
    // the command word's program: `/usr/bin/env` and `\env` are env
    const cmd = programName(w.startsWith('\\') ? w.slice(1) : w);
    if (assigned !== null) {
      if (isHostName(assigned)) return true;
      i++;
    } else if (RESERVED.has(w)) {
      i++;
    } else if (Object.hasOwn(WRAPPERS, cmd)) {
      i = skipFlags(words, i + 1, WRAPPERS[cmd]);
      if (cmd === 'timeout') i++;
    } else if (cmd === 'exec') {
      const r = execOptions(words, i + 1);
      if (r.clears) return true;
      i = r.next;
    } else if (cmd === 'env') {
      const r = envOptions(words, i + 1);
      if (r.floor) return true;
      if (r.nested) return scanCommand(r.nested, 0, depth + 1);
      i = r.next;
    } else if (cmd === 'eval') {
      return scanCommand(words, i + 1, depth + 1);
    } else if (SHELLS.has(cmd)) {
      const at = shellCommandStart(words, i + 1);
      return at !== -1 && scanCommand(words, at, depth + 1);
    } else if (cmd === 'find') {
      return findActions(words, i + 1, depth);
    } else if (FIND_ACTIONS.has(w)) {
      // a find action after a `{}` the split cut (`find . -exec a {} \; -exec b …`)
      return findActions(words, i, depth);
    } else {
      return builtinNames(cmd, words, i + 1);
    }
  }
  return false;
}

// True when one of find's -exec / -execdir / -ok / -okdir commands (from `i`) sets, unsets or
// clears a host-config name; each runs up to its `;`, `\;` or `+` word and is scanned as a command.
function findActions(words, i, depth) {
  for (; i < words.length; i++) {
    if (!FIND_ACTIONS.has(words[i])) continue;
    let end = i + 1;
    while (end < words.length && !FIND_ENDS.has(words[end])) end++;
    if (scanCommand(words.slice(i + 1, end), 0, depth + 1)) return true;
    i = end;
  }
  return false;
}

function commandSetsHostConfig(words) {
  return words.some(defaultAssigns) || scanCommand(words, 0, 0);
}

function setsHostConfig(raw) {
  return simpleCommands(raw).some(commandSetsHostConfig);
}

// ---- decision ----------------------------------------------------------------------------------

const deny = (rule, reason, more = {}) => ({ decision: 'deny', rule, reason, ...more });
const floorDeny = (rule, reason, more = {}) => deny(rule, reason, { ...more, floor: true });

const action = (v) => (v === 'audit' ? 'audit' : 'deny');

// A mode's actions; a key a policy object lacks is `deny` (an old policy decides as before).
function actionsOf(prof) {
  const u = prof.uncertain !== null && typeof prof.uncertain === 'object' ? prof.uncertain : {};
  const constructs = u.constructs !== null && typeof u.constructs === 'object' ? u.constructs : {};
  const rules = prof.rules !== null && typeof prof.rules === 'object' ? prof.rules : {};
  return {
    opaque: action(u.opaque),
    selfProtection: action(u.selfProtection),
    rules: action(u.rules),
    construct: (name) => (Object.hasOwn(constructs, name) ? action(constructs[name]) : action(u.opaque)),
    certain: action(prof.certain),
    // the mode's override for a rule id: deny | audit | off, else undefined
    ruleOverride: (id) => (Object.hasOwn(rules, id) && ['deny', 'audit', 'off'].includes(rules[id]) ? rules[id] : undefined),
  };
}

// The options for the switch-off marker test: the call's resolved reads (never write targets) and
// its effective cwds and project roots.
function markerOptions(parts, o) {
  const readPaths = [];
  for (const part of parts) {
    if (part.type === 'command') readPaths.push(...part.reads.filter((p) => typeof p === 'string'));
    else if (part.type === 'path' && part.access === 'read' && typeof part.path === 'string') readPaths.push(part.path);
  }
  const projectRoots = projectRootsOf(parts).filter((r) => typeof r === 'string' && r.startsWith('/'));
  return { home: o.home, platform: o.platform, readPaths, projectRoots, realpath: o.realpath };
}

// Floor item 4: a claude or codex part whose cwd maps to another mode than the session's. An
// Unknown cwd, or a dir modeOf can not resolve (null), counts as different.
function modeEscape(parts, o) {
  if (o.envProfileSet || o.modeOf === null) return null;
  for (const part of parts) {
    if (part.type !== 'command' || part.argv.length === 0 || typeof part.argv[0] !== 'string') continue;
    const prog = programName(part.argv[0]);
    if (!HOST_PROGRAMS.has(prog)) continue;
    const mode = isUnknown(part.cwd) ? null : o.modeOf(part.cwd);
    if (mode === o.profile) continue;
    const where = isUnknown(part.cwd) ? 'a directory fence could not determine' : part.cwd;
    const target = typeof mode === 'string' ? `the mode ${JSON.stringify(mode)}` : 'a mode fence could not resolve';
    return floorDeny(
      'builtin:mode-escape',
      `"${showArgv(part.argv)}" starts ${prog} in ${where}, which maps to ${target}, not this session's mode ${JSON.stringify(o.profile)}; a human launches it there (FENCE_PROFILE set at launch is inherited).`,
    );
  }
  return null;
}

function opaqueReason(reason, construct, tail) {
  return `fence could not tell what this command would run (${reason}: ${construct}); ${tail}`;
}

function decide(policy, parts, opaque, o) {
  checkPolicyShape(policy);
  if (typeof o.profile !== 'string' || !Object.hasOwn(policy.profiles, o.profile)) {
    const name = typeof o.profile === 'string' ? o.profile : String(o.profile);
    return floorDeny(
      'builtin:unknown-profile',
      `The fence profile ${JSON.stringify(name)} (FENCE_PROFILE) is not defined in the policy (defined: ${Object.keys(policy.profiles).join(', ')}); every call is denied until it is fixed.`,
    );
  }
  const prof = policy.profiles[o.profile];
  const act = actionsOf(prof);

  // 0-1. The floor, over every part and target, before any uncertain deny counts.
  const builtin = builtinCheck(parts, o);
  if (builtin.deny) return floorDeny(builtin.deny.rule, builtin.deny.reason);
  // `o` is this call's own options object: evaluate() reads the lifts back from it.
  o.lifted = builtin.lifted;

  const reason = opaque && typeof opaque.reason === 'string' ? opaque.reason : 'unknown reason';
  const construct = opaque && typeof opaque.construct === 'string' ? opaque.construct : 'unknown construct';
  const mopts = markerOptions(parts, o);
  if (opaque) {
    if (FLOOR_OPAQUE_REASONS.has(reason) || construct === HOST_CONFIG_VAR) {
      return floorDeny(OPAQUE, opaqueReason(reason, construct, 'this is always denied, in every mode.'));
    }
    // An opaque verdict comes only from shell text: without it the floor tests below can not run.
    if (o.raw === null) {
      return floorDeny(OPAQUE, opaqueReason(reason, construct, 'its command text was not passed to the evaluator, so it can not be checked; it is denied.'));
    }
    if (setsHostConfig(o.raw)) {
      return floorDeny(
        OPAQUE,
        opaqueReason(reason, construct, 'its text sets or unsets a variable that redirects the host or fence (HOME, FENCE_PROFILE, CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_DIRS, CODEX_HOME, XDG_*); it is always denied.'),
      );
    }
    const marker = namesSwitchOff(o.raw, mopts);
    if (marker !== null) {
      return floorDeny(OPAQUE, opaqueReason(reason, construct, 'its text names a file that can switch fence off; it is always denied.'), { marker });
    }
  }
  if (builtin.uncertain.length > 0) {
    const marker = namesSwitchOff(o.raw, mopts);
    if (marker !== null) {
      const first = builtin.uncertain[0];
      return floorDeny(first.rule, `${first.reason} The command text names a file that can switch fence off, so this is always denied.`, { marker });
    }
  }
  const escape = modeEscape(parts, o);
  if (escape) return escape;

  const audited = [];
  const withAudit = (result) => (audited.length > 0 ? { ...result, wouldDeny: audited.slice(0, WOULD_DENY_CAP) } : result);

  // 2. Uncertain self-protection.
  for (const u of builtin.uncertain) {
    if (act.selfProtection === 'deny') return deny(u.rule, u.reason, { category: 'selfProtection' });
    audited.push({ rule: u.rule, category: 'selfProtection', reason: u.reason });
  }

  // 3. Opaque.
  if (opaque) {
    const r = opaqueReason(reason, construct, 'the active mode denies commands fence can not read.');
    if (act.construct(construct) === 'deny') return withAudit(deny(OPAQUE, r, { category: 'opaque' }));
    audited.push({ rule: OPAQUE, category: 'opaque', construct, reason: r });
  }

  // 4. Deny rules in policy order, then the protected-branch rule.
  const judge = (id, effective, certain, why) => {
    const category = certain ? act.certain : act.rules;
    if (effective === 'deny' && category === 'deny') return withAudit(deny(id, why, certain ? {} : { category: 'rules' }));
    audited.push({ rule: id, category: 'rules', ...(certain ? { certain: true } : {}), reason: why });
    return null;
  };
  for (const rule of policy.rules) {
    if (rule.decision !== 'deny' && rule.decision !== 'audit') continue;
    const effective = act.ruleOverride(rule.id) ?? rule.decision;
    if (effective === 'off') continue;
    if (!parts.some((part) => ruleDeniesPart(rule, part, o))) continue;
    const certain = parts.some((part) => ruleDeniesPart(rule, part, o, true));
    const r = judge(rule.id, effective, certain, `${rule.why} (fence rule "${rule.id}")`);
    if (r) return r;
  }
  const branch = branchCheck(parts, policy, o);
  if (branch) {
    const r = judge(branch.rule, 'deny', branch.certain, branch.reason);
    if (r) return r;
  }

  // 5. An audited deny: no allow rule applies.
  if (audited.length > 0) {
    if (prof.undecided === 'deny') {
      return withAudit(
        deny(
          'builtin:profile',
          `No fence rule allowed this call and the active profile ${JSON.stringify(o.profile)} denies undecided calls; fence would deny it: ${audited[0].reason}`,
        ),
      );
    }
    return withAudit({
      decision: 'undecided',
      rule: null,
      reason: `fence would deny this call (${audited[0].rule}) but the active mode only audits it; the host's normal permission flow applies.`,
    });
  }

  // 6. Allow.
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
    const result = { ...decide(policy, parts, opaque, o), scope };
    // A non-deny decision that relied on allow-once grants lists them: [{path, grant}], one per
    // lifted path. The caller must reserve (consume) exactly these before acting on the decision.
    if (result.decision !== 'deny' && Array.isArray(o.lifted) && o.lifted.length > 0) result.lifted = o.lifted;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: 'deny',
      rule: 'builtin:internal-error',
      reason: `fence could not evaluate this call (${message}); it is denied.`,
      scope,
      floor: true,
    };
  }
}
