// Data policy for memory-report: allowlist coverage, content filter and the insights selection budget (spec 9, 7.1).
// Pure: no filesystem, no database.
import { classifyEntry, entryMatchesRepo } from './entries.mjs';
import { keyEvidence } from './repo.mjs';

// Spec 9 secret pattern, one RegExp per item, in spec order. None is global or sticky, so `test` carries no state. The
// case-insensitive item carries its own `i` flag: inline modifier groups are a SyntaxError on Node 22.
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_\w{20,}/,
  /xox[abpr]-[\w-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN/,
  /Bearer\s+[A-Za-z0-9._~+/-]{25,}/,
  /:\/\/[^/\s:@]+:[^/\s:@]+@/,
  // The key may be quoted, and `facts` is stored JSON text, so its quotes arrive backslash-escaped: `\"` counts as a quote.
  /(password|passwd|secret|api[_-]?key|token)(?:\\?["'])?\s*(?:=>|[:=])\s*["']?\S{12,}/i,
  /vck_[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  // A bare Stripe-style key (secret, restricted or publishable; live or test), as it appears outside a `key = value` line.
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
];

const isText = (v) => typeof v === 'string' && v !== '';

// ---- coverage (repo-identity spec 4.2): blocking per project, allowing per note ---------------------------------------

const isRepoKind = (entry) => {
  const kind = classifyEntry(entry);
  return kind === 'repo' || kind === 'owner';
};
const listOf = (value) => (Array.isArray(value) ? value : []);
// Repository and owner entries of a list.
const repoEntries = (list) => listOf(list).filter(isRepoKind);
// Never-send names, lower-cased: every string entry that is not a repository or owner entry. loadConfig keeps only the
// valid entries of an invalid never-send (Ruling 9: the invalid ones close the insights gate instead), so with a loaded
// config these are names; a raw entry that is neither (a caller passing an unvalidated list) also counts as a name,
// which can only block more.
const neverNames = (list) => listOf(list).filter((e) => isText(e) && !isRepoKind(e)).map((e) => e.toLowerCase());
// Allowlist names, compared exactly: only the entries classified as names.
const allowNames = (list) => listOf(list).filter((e) => classifyEntry(e) === 'name');

// `value` equals a name or is a worktree key under it (`name/…`).
const nameHit = (names, value) => names.some((n) => value === n || value.startsWith(`${n}/`));
const matchesAny = (entries, repo) => entries.some((entry) => entryMatchesRepo(entry, repo));

// True when never-send holds any repository or owner entry (spec 4.3 decides on this).
export const neverHasRepoEntries = (config) => repoEntries(config.neverSend).length > 0;

// The resolution is required (it may be empty): a missing one is a caller bug, never "no evidence".
export function requireRepos(repos) {
  if (repos === null || typeof repos !== 'object' || !(repos.folders instanceof Map) || !(repos.keys instanceof Map)) {
    throw new TypeError('repos is required');
  }
}

// The resolution cannot be trusted: it threw (`error`) or the map was rebuilt (Ruling 12). Flags must be exactly false.
export function reposUntrusted(repos) {
  requireRepos(repos);
  return (repos.error !== null && repos.error !== undefined) || repos.rebuilt !== false;
}

// Ruling 12: an untrusted resolution while never-send has repository or owner entries. Local titles and suggestions
// are then hidden, as insights are off (spec 4.3).
export const identityUnavailable = (config, repos) => reposUntrusted(repos) && neverHasRepoEntries(config);

// claude-mem treats keys that differ only in case as one project (spec 4.1): the evidence of a key is the union of
// keyEvidence over every recorded key equal to it, or to its worktree base, case-insensitively. For blocking it only
// blocks more; isCoveredKey takes the variants' folders only as extra folders that must all allow, never as the key's
// own (a key with no folders of its own needs a name rule).
// The lower-cased index is cached per `repos.keys`. resolveRepos builds that Map once and nobody mutates it; the cache
// also stores the Map's size and rebuilds when it changed, so a key added later is still indexed (a stale index would
// fail open for blocking).
const caseIndex = new WeakMap();
function evidenceOf(repos, name) {
  let cached = caseIndex.get(repos.keys);
  if (cached === undefined || cached.size !== repos.keys.size) {
    const index = new Map();
    for (const key of repos.keys.keys()) {
      const lower = String(key).toLowerCase();
      if (!index.has(lower)) index.set(lower, []);
      index.get(lower).push(key);
    }
    cached = { size: repos.keys.size, index };
    caseIndex.set(repos.keys, cached);
  }
  const { index } = cached;
  const out = keyEvidence(repos, name);
  const lower = name.toLowerCase();
  const slash = lower.indexOf('/');
  for (const variant of [lower, ...(slash > 0 ? [lower.slice(0, slash)] : [])]) {
    for (const key of index.get(variant) ?? []) {
      const e = keyEvidence(repos, key);
      for (const repo of e.repos) out.repos.add(repo);
      for (const cwd of e.folders) out.folders.add(cwd);
      if (e.unknown) out.unknown = true;
    }
  }
  return out;
}

const FOLDER_STATUSES = new Set(['root', 'nested', 'nogit', 'missing', 'unknown']);
// A recorded cwd absent from the resolution (a session recorded after resolution started) is an `unknown` folder.
const UNKNOWN_FOLDER = Object.freeze({ status: 'unknown', origin: null, remotes: [], unresolvedRemote: false, stored: new Set() });
const folderOf = (repos, cwd) => repos.folders.get(cwd) ?? UNKNOWN_FOLDER;
// Any status other than the five is read as `unknown`.
const isUnknownFolder = (folder) => folder.status === 'unknown' || !FOLDER_STATUSES.has(folder.status);

// Every repository of a folder: this run's origin and remotes plus every one the map stored.
function folderRepos(folder) {
  const out = new Set();
  if (isText(folder.origin)) out.add(folder.origin);
  for (const repo of folder.remotes ?? []) if (isText(repo)) out.add(repo);
  for (const repo of folder.stored ?? []) if (isText(repo)) out.add(repo);
  return [...out];
}

// The folder links the note to never-send: one of its repositories matches a never-send repository or owner entry, or
// it is `unknown` while never-send has any such entry.
function folderBlocks(folder, neverRepos) {
  if (folderRepos(folder).some((repo) => matchesAny(neverRepos, repo))) return true;
  return neverRepos.length > 0 && isUnknownFolder(folder);
}

// Why a folder cannot allow by repository, as fixed phrases; empty when it can. It can when it is `root` now with an
// `origin` and no unresolved non-origin remote, now or ever (Ruling 11: an unresolved remote is never stored), or
// `missing` with a stored repository and none of the sticky flags. Flags must be exactly false: anything else counts as
// set. Shown locally by `triqual memory repos`.
function allowBlockers(folder) {
  const out = [];
  if (folder.status === 'root') {
    if (!isText(folder.origin)) out.push('no origin');
    if (folder.unresolvedRemote !== false || folder.everUnresolvedRemote !== false) out.push('a remote that does not resolve');
  } else if (folder.status === 'missing') {
    if (!((folder.stored?.size ?? 0) > 0)) out.push('missing, nothing stored');
    if (folder.everNested !== false) out.push('missing, once nested');
    if (folder.everUnresolvedRemote !== false) out.push('missing, once with a remote that does not resolve');
    if (folder.everNoOrigin !== false) out.push('missing, once without an origin');
  } else if (folder.status === 'nested') out.push('nested in another repository');
  else if (folder.status === 'nogit') out.push('not a git repository');
  else out.push('could not be inspected');
  return out;
}

// The folder allows by repository: it is eligible (allowBlockers is empty) and every repository of the folder matches
// an allowlist repository or owner entry.
function folderAllows(folder, allowRepos) {
  if (allowRepos.length === 0 || allowBlockers(folder).length > 0) return false;
  const all = folderRepos(folder);
  return all.length > 0 && all.every((repo) => matchesAny(allowRepos, repo));
}

// ---- the per-folder rule, for suggestions and `triqual memory repos` (spec 5.1, 5.4) -----------------------------------------

// A folder's status in the resolution; a cwd absent from it, or an unexpected status, is `unknown`.
export function folderStatus(repos, cwd) {
  requireRepos(repos);
  const folder = folderOf(repos, cwd);
  return isUnknownFolder(folder) ? 'unknown' : folder.status;
}

// Why the folder cannot allow by repository (fixed phrases), or [] when it can.
export function folderAllowBlockers(repos, cwd) {
  requireRepos(repos);
  return allowBlockers(folderOf(repos, cwd));
}

// The origins of a folder that could allow by repository: `root` gives its origin, `missing` its stored repositories;
// [] for any other folder.
export function allowingOrigins(repos, cwd) {
  requireRepos(repos);
  const folder = folderOf(repos, cwd);
  if (allowBlockers(folder).length > 0) return [];
  return folder.status === 'root' ? [folder.origin] : [...folder.stored].filter(isText).sort();
}

// The single repository every one of `cwds` (at least one) would allow by under the per-note rule: each folder could
// allow by repository and its only repository (origin, remotes and stored) is that one. Else null.
export function allowRepoOf(repos, cwds) {
  requireRepos(repos);
  let repo = null;
  for (const cwd of cwds) {
    const folder = folderOf(repos, cwd);
    if (allowBlockers(folder).length > 0) return null;
    const all = folderRepos(folder);
    if (all.length !== 1 || (repo !== null && all[0] !== repo)) return null;
    repo = all[0];
  }
  return repo;
}

// The key or merge target matches an allowlist name: the key equal or a worktree key under it, the target equal.
function allowedByName(key, merged, config) {
  const names = allowNames(config.allowlist);
  return (key !== null && nameHit(names, key)) || (merged !== null && names.includes(merged));
}

const textOrNull = (v) => (isText(v) ? v : null);

// The allowlist name rule for a key alone (no merge target): the key equal to an allowlist name or a worktree key under
// it. Read-only; `triqual memory repos` uses it to tell "allowed by name" from "allowed by repository" (0.3.1).
export function allowedByNameKey(key, config) {
  return allowedByName(textOrNull(key), null, config);
}

// The repositories of a folder that could allow by repository (allowBlockers is empty) that no allowlist repository or
// owner entry matches, sorted; [] when the folder is not eligible. Read-only: `triqual memory repos` shows each as
// "<repo> is not in the allowlist" (0.3.1); it is not an allowBlockers reason and changes no predicate.
export function folderUnlistedRepos(repos, cwd, config) {
  requireRepos(repos);
  const folder = folderOf(repos, cwd);
  if (allowBlockers(folder).length > 0) return [];
  const allowRepos = repoEntries(config.allowlist);
  return folderRepos(folder).filter((repo) => !matchesAny(allowRepos, repo)).sort();
}

// The allowlist repository and owner entries that match any repository of `cwds` (origin, remotes and stored), sorted
// and distinct. Read-only: `triqual memory repos` names the entry a key is allowed by when there is exactly one (0.3.1).
export function allowEntriesMatching(repos, cwds, config) {
  requireRepos(repos);
  const all = new Set();
  for (const cwd of cwds) for (const repo of folderRepos(folderOf(repos, cwd))) all.add(repo);
  return [...new Set(repoEntries(config.allowlist))].filter((entry) => [...all].some((repo) => entryMatchesRepo(entry, repo))).sort();
}

// Spec 4.2 `isBlocked`: true when, for the key or its merge target, its name matches a never-send name (equal or a
// worktree prefix, case-insensitive); or any repository of its key evidence (its worktree base's and its case variants'
// included) matches a
// never-send repository or owner entry; or never-send has any such entry and one of its folders is `unknown`.
export function isBlocked(key, mergedInto, config, repos) {
  requireRepos(repos);
  const names = neverNames(config.neverSend);
  const neverRepos = repoEntries(config.neverSend);
  for (const name of [textOrNull(key), textOrNull(mergedInto)]) {
    if (name === null) continue;
    if (nameHit(names, name.toLowerCase())) return true;
    const evidence = evidenceOf(repos, name);
    if ([...evidence.repos].some((repo) => matchesAny(neverRepos, repo))) return true;
    if (neverRepos.length > 0 && evidence.unknown) return true;
  }
  return false;
}

// Spec 4.2 `isCovered`, per note. `row` carries `project`, `merged_into_project` and `cwd`, the folder of the row's own
// session (null when it has none). False when blocked, or when the row's own folder blocks; otherwise true when a name
// rule matches or the row's own folder allows by repository.
export function isCovered(row, config, repos) {
  requireRepos(repos);
  const key = textOrNull(row?.project);
  const merged = textOrNull(row?.merged_into_project);
  if (key === null && merged === null) return false;
  if (isBlocked(key, merged, config, repos)) return false;
  const cwd = textOrNull(row.cwd);
  const folder = cwd === null ? null : folderOf(repos, cwd);
  if (folder !== null && folderBlocks(folder, repoEntries(config.neverSend))) return false;
  if (allowedByName(key, merged, config)) return true;
  return folder !== null && folderAllows(folder, repoEntries(config.allowlist));
}

// Spec 4.2 `isCoveredKey`: not blocked and either a name rule matches or every folder the key (and its worktree base,
// and the merge target) used allows by repository under the per-note rule. A key with no folders needs a name rule.
export function isCoveredKey(key, mergedInto, config, repos) {
  requireRepos(repos);
  const k = textOrNull(key);
  const merged = textOrNull(mergedInto);
  if (k === null && merged === null) return false;
  if (isBlocked(k, merged, config, repos)) return false;
  if (allowedByName(k, merged, config)) return true;
  // The key's own folders (worktree base and merge target included) decide whether it can allow by repository at all;
  // its case variants' folders are only added to those that must all allow.
  const own = new Set();
  for (const name of [k, merged]) if (name !== null) for (const cwd of keyEvidence(repos, name).folders) own.add(cwd);
  if (own.size === 0) return false;
  const cwds = new Set(own);
  for (const name of [k, merged]) if (name !== null) for (const cwd of evidenceOf(repos, name).folders) cwds.add(cwd);
  const neverRepos = repoEntries(config.neverSend);
  const allowRepos = repoEntries(config.allowlist);
  return [...cwds].every((cwd) => {
    const folder = folderOf(repos, cwd);
    return !folderBlocks(folder, neverRepos) && folderAllows(folder, allowRepos);
  });
}

// A field as text for the filter. Strings pass through; a non-null non-string value (a parsed array or object) is turned
// into its JSON text so it is checked rather than skipped; null, undefined and '' are absent.
function asText(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// Default-ignorable code points (soft hyphen, zero-width characters, word joiner, variation selectors, fillers...) are
// invisible, so they can hide a term without changing how it reads.
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// `facts` can be stored as ASCII-only JSON, so a character may arrive as a literal \uXXXX escape; a surrogate pair is two
// consecutive escapes and joins back into one character.
const decodeEscapes = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

// The checking copy of a text: escapes decoded, NFKC (fullwidth and other compatibility forms fold to plain letters),
// then every default-ignorable code point removed.
const canon = (s) => decodeEscapes(s).normalize('NFKC').replace(IGNORABLE, '');
// The same without the escape decoding: a literal term stays a literal term even when an incomplete or look-alike `\u`
// before it would make the decoder swallow its first letters (`\u12acme` decodes `\u12ac`, leaving `me`).
const canonRaw = (s) => s.normalize('NFKC').replace(IGNORABLE, '');

// The client-term comparison also ignores diacritics: NFKD splits an accented letter into letter plus combining marks,
// and the marks are dropped (after lowercasing, which can itself add one), on the text and on the term alike. It also
// ignores how words are spaced: every run of whitespace is one space, so `acme  corp` matches the term `acme corp`.
// The secret check stays on the NFKC text.
const foldText = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
const fold = (s) => foldText(canon(s));

// The folded string a client term is compared on (the escape-decoding folding, which `contentVerdict` applies first), or ''
// when the term folds to nothing: whitespace, invisible code points, a lone combining mark, or a literal \uXXXX escape of
// one. Such a term would match every row, so `contentVerdict` drops it and the insights gate must not count it.
export const foldTerm = (term) => (typeof term === 'string' ? fold(term) : '');

// The second folding reads a literal \n, \r or \t escape (a newline inside a stored JSON `facts` string) as a space, so
// `acme\ncorp` matches `acme corp`. That mapping would also eat the first letter of a term after a backslash (`C:\nvidia`),
// so a term matches when it occurs in ANY folding of the text (terms are folded the same way): the union fails closed.
// The third folding decodes nothing, so a literal occurrence of a term is always caught.
const foldEscapes = (s) => foldText(canon(s).replace(/\\[nrt]/g, ' '));
const foldRaw = (s) => foldText(canonRaw(s));
const FOLDINGS = [fold, foldEscapes, foldRaw];

// True when `text` holds any of `terms` in any folding. A term that folds to nothing would match every text, so it is dropped.
// `contentVerdict` and the public export's content check share this, so neither can be evaded by a form the other catches.
export function termHits(text, terms) {
  return FOLDINGS.some((fn) => {
    const folded = fn(text);
    return terms.map(fn).filter((t) => t !== '').some((t) => folded.includes(t));
  });
}

// 'client' when the project key, title, narrative or facts hold a client term (case-insensitive); else 'secret' when
// title, narrative or facts match a secret pattern; else 'ok'. Every text is canonicalised first (`canon`, `fold`), and a
// non-string field is checked as its JSON text, so neither a Unicode form nor a parsed `facts` array skips the filter.
export function contentVerdict(obs, config) {
  const texts = [obs.title, obs.narrative, obs.facts].map(asText).filter((s) => s !== null);
  // The secret check runs on the canonical text and on the raw text: decoding can shrink an escaped value below a pattern's
  // minimum length, and an escaped key or value is still a long run of characters as written.
  const fields = [...texts.map(canon), ...texts];
  const project = asText(obs.project);
  const subjects = [...(project === null ? [] : [project]), ...texts];
  const rawTerms = (config.clientTerms ?? []).filter(isText);
  if (subjects.some((subject) => termHits(subject, rawTerms))) return 'client';
  if (fields.some((s) => SECRET_PATTERNS.some((re) => re.test(s)))) return 'secret';
  return 'ok';
}

const pad = (n) => String(n).padStart(2, '0');

// Local calendar date of an epoch-millisecond instant, YYYY-MM-DD.
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Number of local calendar dates the half-open window [startMs, endMs) touches (at least 1).
function countDays(startMs, endMs) {
  const toUtcDay = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const last = endMs > startMs ? endMs - 1 : startMs;
  return toUtcDay(localDay(last)) - toUtcDay(localDay(startMs)) + 1;
}

// Spec 7.1 steps 1-3. Candidates are covered rows created in [startMs, endMs). Subagent rows (agent_id set) are counted
// and never selected; client and secret drops are counted; the rest share `config.maxObservations` across the window's
// local days (floor(max / days) each, the remainder to the newest day, newest rows first within a day; slots a day cannot
// fill go to the other days, newest day first). `selected` is sorted oldest first, and
// candidates = subagent + client + secret + sent + overBudget. `repos` is the resolution (spec 4.2), required.
export function selectForInsights(rows, config, window, repos) {
  requireRepos(repos);
  const { startMs, endMs } = window;
  const counts = { candidates: 0, subagent: 0, client: 0, secret: 0, sent: 0, overBudget: 0 };
  const passing = [];
  for (const r of rows) {
    const t = r.created_at_epoch;
    if (!(t >= startMs && t < endMs)) continue;
    if (!isCovered(r, config, repos)) continue;
    counts.candidates += 1;
    if (r.agent_id != null) {
      counts.subagent += 1;
      continue;
    }
    const verdict = contentVerdict(r, config);
    if (verdict === 'client') counts.client += 1;
    else if (verdict === 'secret') counts.secret += 1;
    else passing.push(r);
  }

  const budget = config.maxObservations;
  const days = countDays(startMs, endMs);
  const base = Math.floor(budget / days);
  const remainder = budget - base * days;

  const groups = new Map();
  for (const r of passing) {
    const key = localDay(r.created_at_epoch);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // Newest day first; newest row first within a day (id breaks a timestamp tie, newest id first).
  const newestFirst = (a, b) => b.created_at_epoch - a.created_at_epoch || b.id - a.id;
  const ordered = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([, g]) => g.sort(newestFirst));
  const newestDay = localDay(endMs > startMs ? endMs - 1 : startMs);

  const selected = [];
  const leftovers = [];
  for (const g of ordered) {
    const quota = base + (localDay(g[0].created_at_epoch) === newestDay ? remainder : 0);
    selected.push(...g.slice(0, quota));
    if (g.length > quota) leftovers.push(g.slice(quota));
  }
  // Every slot a day could not fill (including all of an empty day's) goes to the days that still have rows.
  let spare = budget - selected.length;
  for (const rest of leftovers) {
    if (spare <= 0) break;
    const take = rest.slice(0, spare);
    selected.push(...take);
    spare -= take.length;
  }

  selected.sort((a, b) => a.created_at_epoch - b.created_at_epoch || a.id - b.id);
  counts.sent = selected.length;
  counts.overBudget = passing.length - selected.length;
  return { selected, counts };
}
