// Weakening classifier for `fence apply` (spec, "CLI": apply needs the sudo gate when its diff
// weakens the policy or cannot be proven to tighten it).
//
//   classifyChange(oldPolicy, newPolicy) -> {weakening, reasons}
//
// Conservative: `weakening` is false only when every difference is a proven tightening; every
// reason names one difference that is not. Both policies go through validatePolicy first (defaults
// filled: the `default` profile, branches.protected, denyFileWrites false); a missing or invalid
// old policy, or an invalid new one, is weakening (nothing to prove against).
//
// Rules are paired by id; their order does not matter (precedence is fixed: any matching deny
// wins, there is no first match). A rename is a removal plus an addition. `why` and `examples`
// do not change a decision and are ignored.
//
// Proven tightenings: a deny rule added; an allow rule removed; an allow turned into a deny; on a
// deny, a match list grown by pure additions (class, paths, argv, mcp, domains), a match key
// removed (fewer conditions) while the rule has no `except` in either version, `access` widened
// to `any`, an `except` entry, key or block removed; on an allow, a match list shrunk by pure
// removals, `access` narrowed from `any`, an `except` entry, key or block added; a profile's
// `undecided` moved from host to deny; a protected branch added; denyFileWrites turned on.
//
// Everything else is weakening, among it: a deny removed or turned into an allow; a deny match
// entry removed or edited in place (an edit is a removal plus an addition); a match key added to a
// deny (it narrows the rule); a deny match key removed while the rule has an `except` (the except
// may then excuse more); `access` on a deny narrowed or changed; an `except` added or widened on a
// deny; an allow added; any entry added to an allow's match lists, any match key added to or removed
// from an allow (an allow's keys also decide which effects it covers), `access` on an allow changed
// other than from `any`, an allow's `except` narrowed or removed; a profile added or removed; an
// `undecided` moved from deny to host; a protected branch removed; denyFileWrites turned off.
//
// Modes (profiles carry `undecided`, `uncertain.{opaque,selfProtection,rules,constructs}`, `certain`
// and `rules`; the policy carries `projects`): every profile setting is ranked toward deny (actions
// off < audit < deny, undecided host < deny) and moving a setting down the ranking is weakening, up is
// not. A construct's effective action is `constructs[name]` or else `opaque`; a rule's is the profile's
// `rules[id]` or else the rule's own decision, so an added `rules` entry of `deny` is not weakening
// unless it is later removed from an audit rule. Rule `decision`: deny -> audit and audit -> allow are
// weakening, allow -> audit is not, and audit -> deny is compared like a deny (a narrowed match or an added except weakens); a new audit rule is not, but removing or narrowing
// one is (an audit rule keeps allow rules from allowing what it matches). Any change to `projects`
// (which profile applies where) is weakening.

import { validatePolicy } from '../policy/schema.mjs';

const MATCH_LIST_KEYS = ['class', 'paths', 'argv', 'mcp', 'domains'];
const EXCEPT_KEYS = ['paths', 'domains'];

const entryKey = (key, v) => (key === 'argv' ? JSON.stringify(v) : String(v));
const show = (key, v) => (key === 'argv' ? JSON.stringify(v.join(' ')) : JSON.stringify(v));

// Entries of list `a` (under `key`) that are not in list `b`, shown for a reason.
function missingFrom(key, a, b) {
  const have = new Set(b.map((v) => entryKey(key, v)));
  return a.filter((v) => !have.has(entryKey(key, v))).map((v) => show(key, v));
}

const accessOf = (match) => (match.paths ? (match.access ?? 'any') : null);

function compareDeny(id, o, n, label = 'deny') {
  const reasons = [];
  const hasExcept = Boolean(o.except || n.except);
  for (const key of MATCH_LIST_KEYS) {
    const a = o.match[key];
    const b = n.match[key];
    if (!a && b) reasons.push(`${label} rule "${id}": match.${key} was added, which narrows the rule`);
    else if (a && !b) {
      if (hasExcept) reasons.push(`${label} rule "${id}": match.${key} was removed while the rule has an except, so the change is not proven to widen it`);
    } else if (a && b) {
      const lost = missingFrom(key, a, b);
      if (lost.length) reasons.push(`${label} rule "${id}": match.${key} lost or edited ${lost.join(', ')}`);
    }
  }
  const oa = accessOf(o.match);
  const na = accessOf(n.match);
  if (oa && na && oa !== na && na !== 'any') reasons.push(`${label} rule "${id}": match.access changed from ${oa} to ${na}, which narrows the rule`);
  for (const key of EXCEPT_KEYS) {
    const a = o.except?.[key];
    const b = n.except?.[key];
    if (!a && b) reasons.push(`${label} rule "${id}": except.${key} was added (${b.map((v) => show(key, v)).join(', ')})`);
    else if (a && b) {
      const gained = missingFrom(key, b, a);
      if (gained.length) reasons.push(`${label} rule "${id}": except.${key} was widened with ${gained.join(', ')}`);
    }
  }
  return reasons;
}

function compareAllow(id, o, n) {
  const reasons = [];
  for (const key of MATCH_LIST_KEYS) {
    const a = o.match[key];
    const b = n.match[key];
    if (Boolean(a) !== Boolean(b)) {
      reasons.push(`allow rule "${id}": match.${key} was ${a ? 'removed' : 'added'}, which is not proven to narrow the rule`);
    } else if (a && b) {
      const gained = missingFrom(key, b, a);
      if (gained.length) reasons.push(`allow rule "${id}": match.${key} was widened or edited with ${gained.join(', ')}`);
    }
  }
  const oa = accessOf(o.match);
  const na = accessOf(n.match);
  if (oa && na && oa !== na && oa !== 'any') reasons.push(`allow rule "${id}": match.access changed from ${oa} to ${na}`);
  for (const key of EXCEPT_KEYS) {
    const a = o.except?.[key];
    const b = n.except?.[key];
    if (a && !b) reasons.push(`allow rule "${id}": except.${key} was removed`);
    else if (a && b) {
      const lost = missingFrom(key, a, b);
      if (lost.length) reasons.push(`allow rule "${id}": except.${key} lost or edited ${lost.join(', ')}`);
    }
  }
  return reasons;
}

function compareRules(oldRules, newRules) {
  const reasons = [];
  const oldById = new Map(oldRules.map((r) => [r.id, r]));
  const newById = new Map(newRules.map((r) => [r.id, r]));
  for (const [id, o] of oldById) {
    const n = newById.get(id);
    if (!n) {
      if (o.decision === 'deny') reasons.push(`deny rule "${id}" was removed`);
      else if (o.decision === 'audit') reasons.push(`audit rule "${id}" was removed (it kept allow rules from allowing what it matched)`);
      continue;
    }
    if (o.decision !== n.decision) {
      // allow -> deny and allow -> audit remove an allow and add an observer or a deny: both tighten
      if (n.decision === 'allow') reasons.push(`rule "${id}" changed from ${o.decision} to allow`);
      else if (n.decision === 'audit' && o.decision === 'deny') reasons.push(`rule "${id}" changed from deny to audit`);
      // an audit rule already kept allow rules from allowing what it matches, so audit -> deny
      // tightens only when its match is not narrowed: compare it like any deny
      else if (n.decision === 'deny' && o.decision === 'audit') reasons.push(...compareDeny(id, o, n, 'audit -> deny'));
      continue;
    }
    if (o.decision === 'allow') reasons.push(...compareAllow(id, o, n));
    else reasons.push(...compareDeny(id, o, n, o.decision));
  }
  for (const [id, n] of newById) {
    if (!oldById.has(id) && n.decision === 'allow') reasons.push(`allow rule "${id}" was added`);
  }
  return reasons;
}

const ACTION_RANK = { off: 0, audit: 1, deny: 2 };
const UNDECIDED_RANK = { host: 0, deny: 1 };

// The action a profile gives a rule: its `rules` override, else the rule's own decision (a rule
// missing from the policy counts as deny, the strictest reading).
function ruleAction(policy, profile, id) {
  if (Object.hasOwn(profile.rules, id)) return profile.rules[id];
  const rule = policy.rules.find((r) => r.id === id);
  return rule && rule.decision === 'audit' ? 'audit' : 'deny';
}

// Reasons for the settings of profile `name` that moved away from deny.
function compareModeSettings(name, o, n, oldPolicy, newPolicy) {
  const reasons = [];
  const lowered = (what, from, to) => reasons.push(`profile "${name}": ${what} moved from ${from} to ${to}`);
  if (UNDECIDED_RANK[n.undecided] < UNDECIDED_RANK[o.undecided]) lowered('undecided', o.undecided, n.undecided);
  for (const key of ['opaque', 'selfProtection', 'rules']) {
    if (ACTION_RANK[n.uncertain[key]] < ACTION_RANK[o.uncertain[key]]) lowered(`uncertain.${key}`, o.uncertain[key], n.uncertain[key]);
  }
  const constructAction = (profile, c) => (Object.hasOwn(profile.uncertain.constructs, c) ? profile.uncertain.constructs[c] : profile.uncertain.opaque);
  for (const c of new Set([...Object.keys(o.uncertain.constructs), ...Object.keys(n.uncertain.constructs)])) {
    const from = constructAction(o, c);
    const to = constructAction(n, c);
    if (ACTION_RANK[to] < ACTION_RANK[from]) lowered(`uncertain.constructs[${JSON.stringify(c)}]`, from, to);
  }
  if (ACTION_RANK[n.certain] < ACTION_RANK[o.certain]) lowered('certain', o.certain, n.certain);
  for (const id of new Set([...Object.keys(o.rules), ...Object.keys(n.rules)])) {
    const from = ruleAction(oldPolicy, o, id);
    const to = ruleAction(newPolicy, n, id);
    if (ACTION_RANK[to] < ACTION_RANK[from]) lowered(`rules[${JSON.stringify(id)}]`, from, to);
  }
  return reasons;
}

function compareProfiles(oldPolicy, newPolicy) {
  const o = oldPolicy.profiles;
  const n = newPolicy.profiles;
  const reasons = [];
  for (const name of Object.keys(n)) {
    if (!Object.hasOwn(o, name)) reasons.push(`profile "${name}" was added (profile changes are not proven to tighten the policy)`);
    else reasons.push(...compareModeSettings(name, o[name], n[name], oldPolicy, newPolicy));
  }
  for (const name of Object.keys(o)) {
    if (!Object.hasOwn(n, name)) reasons.push(`profile "${name}" was removed (profile changes are not proven to tighten the policy)`);
  }
  return reasons;
}

// Which profile applies where is a mode choice, so any change to the list (entries, their order) weakens.
function compareProjects(o, n) {
  if (JSON.stringify(o) === JSON.stringify(n)) return [];
  return ['projects changed (which profile applies to which project is not proven to tighten the policy)'];
}

function compareBranches(o, n) {
  const reasons = [];
  const kept = new Set(n.protected);
  for (const b of new Set(o.protected)) if (!kept.has(b)) reasons.push(`protected branch ${JSON.stringify(b)} was removed`);
  if (o.denyFileWrites === true && n.denyFileWrites !== true) reasons.push('branches.denyFileWrites was turned off');
  return reasons;
}

function validated(policy) {
  try {
    return { policy: validatePolicy(policy) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function classifyChange(oldPolicy, newPolicy) {
  const next = validated(newPolicy);
  if (next.error) return { weakening: true, reasons: [`the new policy is not valid (${next.error}), so it can not be proven to tighten the current one`] };
  if (oldPolicy === null || oldPolicy === undefined) {
    return { weakening: true, reasons: ['there is no current policy to compare with, so the change can not be proven to tighten it'] };
  }
  const prev = validated(oldPolicy);
  if (prev.error) return { weakening: true, reasons: [`the current policy is not valid (${prev.error}), so the change can not be proven to tighten it`] };
  const o = prev.policy;
  const n = next.policy;
  const reasons = [
    ...compareProfiles(o, n),
    ...compareProjects(o.projects, n.projects),
    ...compareBranches(o.branches, n.branches),
    ...compareRules(o.rules, n.rules),
  ];
  return { weakening: reasons.length > 0, reasons };
}
