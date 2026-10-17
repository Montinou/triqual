// Command class names a policy rule may name in `match.class` (spec "Command classes").
// Names only; the members of each class live in the class tables.
export const CLASS_NAMES = Object.freeze([
  'delete',
  'overwrite',
  'perm-change',
  'privilege',
  'network-fetch',
  'vcs-write',
  'env-dump',
  'package-install',
  'runs-repo-code',
  'search',
]);

// `except.paths` is valid only with `match.paths` or a `match.class` list inside this set
// (classes whose effect is the paths they touch); `except.domains` only with `match.domains`
// or a `match.class` list inside EXCEPT_DOMAIN_CLASSES.
export const EXCEPT_PATH_CLASSES = Object.freeze(['delete', 'overwrite', 'perm-change']);
export const EXCEPT_DOMAIN_CLASSES = Object.freeze(['network-fetch']);

// Classes an allow rule's `argv` match covers without listing them in `class`. Every other
// class needs an explicit `class` entry in the allow rule.
export const ARGV_COVERED_CLASSES = Object.freeze(['runs-repo-code', 'package-install', 'search']);

// True when an `except` of `kind` ("paths" | "domains") is meaningful for `match`.
export function exceptKindAllowed(match, kind) {
  if (kind === 'paths' && match.paths) return true;
  if (kind === 'domains' && match.domains) return true;
  const allowed = kind === 'paths' ? EXCEPT_PATH_CLASSES : EXCEPT_DOMAIN_CLASSES;
  return Array.isArray(match.class) && match.class.length > 0 && match.class.every((c) => allowed.includes(c));
}
