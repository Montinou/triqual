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

function compareDeny(id, o, n) {
  const reasons = [];
  const hasExcept = Boolean(o.except || n.except);
  for (const key of MATCH_LIST_KEYS) {
    const a = o.match[key];
    const b = n.match[key];
    if (!a && b) reasons.push(`deny rule "${id}": match.${key} was added, which narrows the rule`);
    else if (a && !b) {
      if (hasExcept) reasons.push(`deny rule "${id}": match.${key} was removed while the rule has an except, so the change is not proven to widen it`);
    } else if (a && b) {
      const lost = missingFrom(key, a, b);
      if (lost.length) reasons.push(`deny rule "${id}": match.${key} lost or edited ${lost.join(', ')}`);
    }
  }
  const oa = accessOf(o.match);
  const na = accessOf(n.match);
  if (oa && na && oa !== na && na !== 'any') reasons.push(`deny rule "${id}": match.access changed from ${oa} to ${na}, which narrows the rule`);
  for (const key of EXCEPT_KEYS) {
    const a = o.except?.[key];
    const b = n.except?.[key];
    if (!a && b) reasons.push(`deny rule "${id}": except.${key} was added (${b.map((v) => show(key, v)).join(', ')})`);
    else if (a && b) {
      const gained = missingFrom(key, b, a);
      if (gained.length) reasons.push(`deny rule "${id}": except.${key} was widened with ${gained.join(', ')}`);
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
      continue;
    }
    if (o.decision !== n.decision) {
      // allow -> deny removes an allow and adds a deny: both tighten
      if (n.decision === 'allow') reasons.push(`rule "${id}" changed from deny to allow`);
      continue;
    }
    reasons.push(...(o.decision === 'deny' ? compareDeny(id, o, n) : compareAllow(id, o, n)));
  }
  for (const [id, n] of newById) {
    if (!oldById.has(id) && n.decision === 'allow') reasons.push(`allow rule "${id}" was added`);
  }
  return reasons;
}

function compareProfiles(o, n) {
  const reasons = [];
  for (const name of Object.keys(n)) {
    if (!Object.hasOwn(o, name)) reasons.push(`profile "${name}" was added (profile changes are not proven to tighten the policy)`);
    else if (o[name].undecided === 'deny' && n[name].undecided === 'host') reasons.push(`profile "${name}": undecided moved from deny to host`);
  }
  for (const name of Object.keys(o)) {
    if (!Object.hasOwn(n, name)) reasons.push(`profile "${name}" was removed (profile changes are not proven to tighten the policy)`);
  }
  return reasons;
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
  const reasons = [...compareProfiles(o.profiles, n.profiles), ...compareBranches(o.branches, n.branches), ...compareRules(o.rules, n.rules)];
  return { weakening: reasons.length > 0, reasons };
}
