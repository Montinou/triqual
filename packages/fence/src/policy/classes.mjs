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
