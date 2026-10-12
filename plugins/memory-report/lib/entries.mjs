// Allowlist and never-send entries (repo-identity spec 4.1): classification, the sync adding normalization and matching
// against a normalized repository. A leaf module: it imports nothing, so config.mjs, policy.mjs and repo.mjs can use it.

// A remote URL as typed or pasted: anything with `://`, or git's scp shape `[user@]host:path` (final fix I1: with or
// without the user, as repo.mjs reads remotes under Ruling 2). Stored entries of this shape are invalid; adding sends
// them through repo.mjs's async normalizeRemote instead.
const SCP_SHAPE = /^(?:[^/@:\s]+@)?[^/@:\s]+:/;
export const isUrlShaped = (entry) => typeof entry === 'string' && (entry.includes('://') || SCP_SHAPE.test(entry));

// A path segment of a repository: not empty, `.` or `..`, and without whitespace or a control character.
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/;
export const isValidSegment = (seg) => seg !== '' && seg !== '.' && seg !== '..' && !BAD_CHARS.test(seg);

// The Azure DevOps path on dev.azure.com: `<org>/<proj>/_git/<repo>` loses its `_git` (a legacy visualstudio.com
// path also its `_ssh`), and an owner `<org>/<proj>/_git/*` becomes `<org>/<proj>/*`. Any other path is kept as is.
function devAzure(segs, owner, marks) {
  if (!owner && segs.length === 4 && marks.includes(segs[2])) return ['dev.azure.com', [segs[0], segs[1], segs[3]]];
  if (owner && segs.length === 3 && marks.includes(segs[2])) return ['dev.azure.com', [segs[0], segs[1]]];
  return ['dev.azure.com', segs];
}

// A plain host name (final fix I1): letters, digits, `.`, `_` and `-`, so no `:`, port, `@`, `%` or bracket. Remotes
// never normalize to any other host, so an entry on one could never match. `_` stays because ssh host names may carry it
// (repo.mjs hands such hosts to `ssh -G`), and letters of any script so a stored IDN host keeps matching its remote.
const PLAIN_HOST = /^[\p{L}\p{N}._-]+$/u;

// A host as both sides compare it (final fix M1): one trailing `.` dropped.
const trimHost = (host) => (host.endsWith('.') ? host.slice(0, -1) : host);

// The hosts applyAliases maps to or from (final fix I1): an entry on any other host is resolved through `ssh -G` when
// it is added, as an SSH remote's host is.
export const CANONICAL_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com']);
const WWW = new Set(['www.github.com', 'www.gitlab.com', 'www.bitbucket.org']);

// The one legacy SSH host of visualstudio.com; every other single-label `<org>.visualstudio.com` names its org.
const VS_SSH = 'vs-ssh.visualstudio.com';
export const visualStudioOrg = (host) => (host === VS_SSH ? null : /^([^.]+)\.visualstudio\.com$/.exec(host)?.[1] ?? null);

// The host aliases of spec 2, shared by remotes and entries so both always land on the same form. On an already
// lower-cased host and its path segments (an owner's final `*` excluded, `owner` true). Returns [host, segments], or
// null for a visualstudio.com host that names no org (`a.b.visualstudio.com`): such a remote normalizes to null (fail
// closed) and such an entry is invalid, so no remote is ever left that no entry could block.
// - ssh.github.com → github.com; www.github.com, www.gitlab.com and www.bitbucket.org lose the `www.` (final fix M1);
// - ssh.dev.azure.com and vs-ssh.visualstudio.com, with or without a leading `v3`, → dev.azure.com;
// - `<org>.visualstudio.com/[DefaultCollection/]<path>` → dev.azure.com/<org>/<path>;
// - on dev.azure.com, the `_git` segment of `<org>/<proj>/_git/<repo>` is dropped.
export function applyAliases(host, segs, { owner = false } = {}) {
  if (host === 'ssh.github.com') return ['github.com', segs];
  if (WWW.has(host)) return [host.slice(4), segs];
  if (host === 'ssh.dev.azure.com' || host === VS_SSH) return devAzure(segs[0] === 'v3' ? segs.slice(1) : segs, owner, ['_git']);
  if (host === 'dev.azure.com') return devAzure(segs, owner, ['_git']);
  if (host.endsWith('.visualstudio.com')) {
    const org = visualStudioOrg(host);
    if (org === null) return null;
    return devAzure([org, ...(segs[0] === 'defaultcollection' ? segs.slice(1) : segs)], owner, ['_git', '_ssh']);
  }
  return [host, segs];
}

const stripGit = (seg) => (seg.endsWith('.git') ? seg.slice(0, -4) : seg);

// `host/path` for a lower-cased host and the path segments of a repository (no trailing `/`), or null: the last
// segment loses one `.git`, the host one trailing `.`, the aliases apply, and the host must contain a `.` and at least
// two valid segments must follow it. Shared with normalizeRemote, so entries and remotes normalize the same way.
export function canonicalRepo(host, segs) {
  if (segs.length === 0) return null;
  const aliased = applyAliases(trimHost(host), [...segs.slice(0, -1), stripGit(segs[segs.length - 1])]);
  if (aliased === null) return null;
  const [h, path] = aliased;
  if (!h.includes('.') || BAD_CHARS.test(h) || h.includes('/')) return null;
  if (path.length < 2 || !path.every(isValidSegment)) return null;
  return `${h}/${path.join('/')}`;
}

// The adding normalization of a repository-shaped entry (spec 4.1 step 2): trailing `/` stripped, lower-cased, a
// trailing `.git` and one trailing `.` of the host stripped and the host aliases applied. Returns the stored form of a
// valid repository (`host/a/b[/…]`) or owner (`host/a[/…]/*`) entry, or null for anything else (names, URLs, refused
// entries, entries on a host that is not a plain host name, and entries on an aliased host that no alias pattern maps).
export function normalizeEntrySync(entry) {
  if (typeof entry !== 'string' || entry === '' || isUrlShaped(entry)) return null;
  const segs = entry.replace(/\/+$/, '').toLowerCase().split('/');
  const host = trimHost(segs.shift());
  if (!host.includes('.') || !PLAIN_HOST.test(host)) return null;
  const owner = segs.length > 0 && segs[segs.length - 1] === '*';
  if (owner) segs.pop();
  if (segs.some((seg) => seg.includes('*'))) return null;
  // Before aliasing: a repository has at least two segments after the host, an owner at least one before `*`, except
  // on an `<org>.visualstudio.com` host, which already names the org (`acme.visualstudio.com/*` is dev.azure.com/acme/*).
  if (segs.length < (owner ? (visualStudioOrg(host) === null ? 1 : 0) : 2)) return null;
  if (!owner) segs.push(stripGit(segs.pop()));
  const aliased = applyAliases(host, segs, { owner });
  if (aliased === null) return null;
  const [h, path] = aliased;
  if (BAD_CHARS.test(h) || path.length < (owner ? 1 : 2) || !path.every(isValidSegment)) return null;
  return `${h}/${path.join('/')}${owner ? '/*' : ''}`;
}

// A pasted browser URL's normalized form without its file-view path (final fix I1): a GitHub `owner/repo/tree/…` or
// `owner/repo/blob/…`, or a `/-/tree/…` or `/-/blob/…` after at least two segments on any host (GitLab: `-` is never a
// group or project). Anything else is returned as is, so a GitLab subgroup named `tree` keeps its path.
export function stripBrowserPath(form) {
  const [host, ...path] = form.split('/');
  let cut = -1;
  if (host === 'github.com' && path.length > 3 && (path[2] === 'tree' || path[2] === 'blob')) cut = 2;
  for (let i = 2; cut < 0 && i < path.length - 1; i += 1) {
    if (path[i] === '-' && (path[i + 1] === 'tree' || path[i + 1] === 'blob')) cut = i;
  }
  return cut < 0 ? form : [host, ...path.slice(0, cut)].join('/');
}

// 'repo' | 'owner' | 'name' | 'invalid' for a stored or typed entry (spec 4.1). An entry the adding rules would refuse
// is invalid, and so is a URL-shaped one: stored entries are never URLs.
export function classifyEntry(entry) {
  if (typeof entry !== 'string' || entry === '' || isUrlShaped(entry)) return 'invalid';
  const normalized = normalizeEntrySync(entry);
  if (normalized !== null) return normalized.endsWith('/*') ? 'owner' : 'repo';
  if (entry.includes('*')) return 'invalid';
  const parts = entry.split('/');
  if (parts.length > 2 || parts.some((p) => p === '')) return 'invalid';
  return 'name';
}

// True when a repository or owner entry matches the normalized repository `repo`, lower-cased on both sides. An owner
// entry matches every repository under its path, at any depth (GitLab subgroups). Names and invalid entries never match.
// A repository entry matches as stored or re-normalized: a stored `host/a/app.git` (normalizeRemote of `app.git.git`)
// names `app.git`, which its re-normalization would miss.
export function entryMatchesRepo(entry, repo) {
  if (typeof repo !== 'string' || repo === '') return false;
  const normalized = normalizeEntrySync(entry);
  if (normalized === null) return false;
  const r = repo.toLowerCase();
  if (normalized.endsWith('/*')) {
    const prefix = normalized.slice(0, -1);
    return r.startsWith(prefix) && r.length > prefix.length;
  }
  return r === normalized || r === entry.toLowerCase();
}
