// Library half of the public export (spec 4.3 to 4.6): manifest, file selection from HEAD, staging with the slug
// rewrite, the six-category content check and the staged test run. The CLI and the target safety checks live elsewhere.
// Everything here reads the private repository through `git ls-tree` and `git show` on one revision (HEAD by default; the
// CLI pins the full sha of HEAD once and passes it as `rev` to every read); nothing touches its index, its working tree or
// any target.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { BRAND, brandDir } from '../../plugins/methodology/cli/lib/brand.mjs';
import { loadConfig, resolvePaths } from '../../plugins/memory-report/lib/config.mjs';
import { classifyEntry, normalizeEntrySync } from '../../plugins/memory-report/lib/entries.mjs';
import { SECRET_PATTERNS, foldTerm, termHits } from '../../plugins/memory-report/lib/policy.mjs';

const MANIFEST_FILE = 'public-export.json';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// `code` follows the export's exit codes: 1 content check, staged tests or a write failed; 2 usage error or unsafe input.
export class ExportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

// Variables that point git at another repository, index or object store. The target functions drop them from the caller's
// environment and keep everything else (identity and config variables reach git on purpose).
const REDIRECTING_GIT_VARS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);

// git run in `repoRoot`. Without `env` it runs in the process environment minus every GIT_* variable (a leaked GIT_DIR or
// GIT_INDEX_FILE would redirect it). With `env` it runs in that environment minus the REDIRECTING_GIT_VARS only.
function git(repoRoot, args, { buffer = false, env: callerEnv, input } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(callerEnv ?? process.env)) {
    const dropped = callerEnv ? REDIRECTING_GIT_VARS.has(key) : key.startsWith('GIT_');
    if (!dropped && value !== undefined) env[key] = value;
  }
  return execFileSync('git', ['-C', repoRoot, ...args], {
    env,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

// The full sha of HEAD in `repoRoot`. The CLI calls this once and passes the sha as `rev` to every private read, so a commit
// or checkout during the run cannot mix two snapshots. Code 2 when there is no commit.
export function resolveHead(repoRoot, { env } = {}) {
  try {
    return git(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { env }).trim();
  } catch {
    throw new ExportError('the private repository has no commit to export', 2);
  }
}

// The short sha of `rev` (default HEAD) in `repoRoot`, as the export names it in its commit message.
export function headShortSha(repoRoot, { rev = 'HEAD', env } = {}) {
  return git(repoRoot, ['rev-parse', '--short', rev], { env }).trim();
}

// ---- manifest ----

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
// A manifest path is spelled the way git lists tree paths, or it could never match: repository-relative, no surrounding
// whitespace, no backslash, and no empty, `.` or `..` segment. The one empty segment allowed is the last, i.e. a trailing `/`.
const isRepoPath = (v) => {
  if (!isNonEmptyString(v) || v !== v.trim() || v.includes('\\')) return false;
  const segments = v.split('/');
  if (segments[segments.length - 1] === '') segments.pop();
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

// An allowSecrets or allowLegacy `contains` shorter than this is too common a substring to name one line (spec 4.5).
const MIN_ALLOW_CONTAINS = 6;

function pathList(manifest, key) {
  const list = manifest[key];
  if (!Array.isArray(list)) throw new ExportError(`${MANIFEST_FILE}: "${key}" must be an array of repository-relative paths`, 2);
  const bad = list.findIndex((entry) => !isRepoPath(entry));
  if (bad !== -1) throw new ExportError(`${MANIFEST_FILE}: "${key}"[${bad}] must be a repository-relative path`, 2);
  return list;
}

// The entries ({ path, contains }) of the allowance list `key` (allowSecrets, allowLegacy). Code 2 for a non-array, an entry
// without a repository path or a non-empty `contains`, a `contains` shorter than MIN_ALLOW_CONTAINS once trimmed, or one that
// itself matches a secret pattern. Messages name the key and index, never the `contains`.
function allowList(list, key) {
  if (!Array.isArray(list)) throw new ExportError(`${MANIFEST_FILE}: "${key}" must be an array`, 2);
  return list.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || !isRepoPath(entry.path) || !isNonEmptyString(entry.contains)) {
      throw new ExportError(`${MANIFEST_FILE}: ${key}[${index}] needs a repository path and a non-empty "contains"`, 2);
    }
    if (entry.contains.trim().length < MIN_ALLOW_CONTAINS) {
      throw new ExportError(`${MANIFEST_FILE}: ${key}[${index}].contains must be at least ${MIN_ALLOW_CONTAINS} characters`, 2);
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(entry.contains))) {
      throw new ExportError(`${MANIFEST_FILE}: ${key}[${index}].contains matches a secret pattern; use a distinctive substring of at least ${MIN_ALLOW_CONTAINS} characters`, 2);
    }
    return { path: entry.path, contains: entry.contains };
  });
}

// { include, exclude, keepInTarget, allowSecrets, allowLegacy } from public-export.json as committed at HEAD of <repoRoot>,
// never the working tree: only what HEAD holds is exported, so an uncommitted manifest edit must not widen the selection or
// the allowances. `allowLegacy` is optional: it is in the result only when the manifest has the key (its presence switches the
// CLI's old-name check on), and checkContent treats an absent one as []. Code 2 for a manifest absent from HEAD, bad JSON, a
// bad shape, or an allowance `contains` that itself matches a secret pattern (the manifest is exported and scanned too, so such
// an entry would fail its own export). Error messages never repeat a `contains`. `rev` (default HEAD) is the commit read; `env`
// is the git environment (see git()).
export function readManifest(repoRoot, { rev = 'HEAD', env } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(git(repoRoot, ['show', `${rev}:${MANIFEST_FILE}`], { env }));
  } catch (err) {
    throw new ExportError(`${MANIFEST_FILE}: cannot read a JSON manifest at HEAD (${err instanceof SyntaxError ? 'parse error' : 'not committed'})`, 2);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ExportError(`${MANIFEST_FILE}: must be a JSON object`, 2);
  }
  const include = pathList(manifest, 'include');
  const exclude = pathList(manifest, 'exclude');
  const keepInTarget = pathList(manifest, 'keepInTarget');
  const allowSecrets = allowList(manifest.allowSecrets, 'allowSecrets');
  const result = { include, exclude, keepInTarget, allowSecrets };
  if (Object.hasOwn(manifest, 'allowLegacy')) result.allowLegacy = allowList(manifest.allowLegacy, 'allowLegacy');
  return result;
}

// ---- private slug ----

// 'owner/name' from the origin URL: its last two path components, without `.git` or a trailing slash. Code 2 without an
// origin or when the URL names no owner/name.
export function privateSlug(repoRoot, { env } = {}) {
  let url;
  try {
    url = git(repoRoot, ['remote', 'get-url', 'origin'], { env }).trim();
  } catch {
    throw new ExportError('the private repository has no origin remote, so its slug is unknown', 2);
  }
  const match = /(?:^|[/:])([^/:@\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new ExportError('the origin URL does not name an owner/name', 2);
  return `${match[1]}/${match[2]}`;
}

// ---- file selection ----

const matches = (entry, path) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry);

// An entry without a trailing `/` is an exact path. When no file has that path but some file lies under `<entry>/`, the entry
// names a directory and would silently match nothing, so it is code 2. Checked over the three path lists against one listing.
function refuseDirectoryEntries(manifest, treePaths) {
  const exact = new Set(treePaths);
  for (const key of ['include', 'exclude', 'keepInTarget']) {
    manifest[key].forEach((entry, index) => {
      if (entry.endsWith('/') || exact.has(entry)) return;
      if (treePaths.some((path) => path.startsWith(`${entry}/`))) {
        throw new ExportError(`${MANIFEST_FILE}: "${key}"[${index}] names a directory; end it with "/"`, 2);
      }
    });
  }
}

// An include or exclude entry that matches no tree path is a typo, a wrong case, a glob, a stale name or a normalization
// mismatch: it would silently select (or exclude) nothing. `keepInTarget` is exempt, since it names paths of the target.
function refuseUnmatchedEntries(manifest, treePaths) {
  for (const key of ['include', 'exclude']) {
    manifest[key].forEach((entry, index) => {
      if (!treePaths.some((path) => matches(entry, path))) {
        throw new ExportError(`${MANIFEST_FILE}: "${key}"[${index}] matches no file at HEAD`, 2);
      }
    });
  }
}

// Blob files of `rev` (default HEAD) that the manifest includes and does not exclude, as [{ path, mode }] sorted by path; `mode`
// is the git mode, '100644' or '100755'. A symlink or submodule inside the included set is code 1: copying it as a file would
// be wrong.
export function listExportFiles(repoRoot, manifest, { rev = 'HEAD', env } = {}) {
  const out = git(repoRoot, ['ls-tree', '-r', '-z', rev], { env });
  const records = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    records.push({ mode: record.slice(0, tab).split(' ')[0], path: record.slice(tab + 1) });
  }
  const treePaths = records.map((r) => r.path);
  refuseDirectoryEntries(manifest, treePaths);
  refuseUnmatchedEntries(manifest, treePaths);
  const files = [];
  for (const { mode, path } of records) {
    if (!manifest.include.some((entry) => matches(entry, path))) continue;
    if (manifest.exclude.some((entry) => matches(entry, path))) continue;
    if (mode !== '100644' && mode !== '100755') {
      throw new ExportError(`${path}: unsupported file mode ${mode} (only regular files are exported)`, 1);
    }
    files.push({ path, mode });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---- staging ----

const MODE_EXECUTABLE = 0o755;
const MODE_REGULAR = 0o644;

// A NUL byte anywhere makes a file binary (stricter than git, which looks at the first 8000 bytes): text the check cannot
// read reliably is never exported, and UTF-16 text always holds NULs.
const isBinary = (buf) => buf.includes(0);
const BINARY_MESSAGE = (path) => `${path}: binary file (a NUL byte) cannot be checked, so it is not exported`;

// checkContent decodes strictly: a byte sequence that is not valid UTF-8 (Latin-1, an overlong form) would otherwise become
// U+FFFD and hide a term, so such a file is refused. ignoreBOM keeps a leading BOM in the text instead of dropping it.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Escaped spellings of '/': any number of backslashes before it (\/, \\/, ...), \u002f, \u{2f}, \x2f, \057, %2f and its
// percent-encoded layers (%252f, %25252f, ...), &#47;, &#x2f; and &sol; (any case, leading zeros allowed). One pass undoes
// one layer; the fold below repeats it until the text stops changing (MAX_FOLD_PASSES).
// The run of backslashes starts after a non-backslash (the lookbehind), so a long run with no slash after it is scanned
// once, not once per start.
const SLASH_FORMS = /(?<!\\)\\+\/|\\u002f|\\u\{0*2f\}|\\x2f|\\057|%(?:25)*2f|&#0*47;|&#x0*2f;|&sol;/gi;
const MAX_FOLD_PASSES = 4;

// Default-ignorable code points (zero-width and joiner characters, soft hyphen, variation selectors, ...): invisible in a
// rendered file and dropped by a reader, so they can split a slug without changing what it reads as.
const IGNORABLE_CHARS = /\p{Default_Ignorable_Code_Point}/gu;
const fromCodePoint = (value, whole) => (Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole);
// One layer of every escape a reader or parser would decode (\uXXXX, \u{X}, \xXX, \/, ASCII %XX, numeric entities with or
// without the semicolon, &sol;), then NFKC (fullwidth letters and solidus, compatibility forms) and the ignorables removed.
const decodeOnce = (text) =>
  text
    .replace(/\\u([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{0*([0-9a-f]{1,6})\}/gi, (m, h) => fromCodePoint(parseInt(h, 16), m))
    .replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/%([0-7][0-9a-f])/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#0*(\d{1,7})(?![0-9]);?/g, (m, d) => fromCodePoint(Number(d), m))
    .replace(/&#x0*([0-9a-f]{1,6})(?![0-9a-f]);?/gi, (m, h) => fromCodePoint(parseInt(h, 16), m))
    .replace(/&sol;/gi, '/')
    .normalize('NFKC')
    .replace(IGNORABLE_CHARS, '');
const untilStable = (step, text) => {
  let current = text;
  for (let pass = 0; pass < MAX_FOLD_PASSES; pass += 1) {
    const next = step(current);
    if (next === current) break;
    current = next;
  }
  return current;
};
const slashNormalized = (text) => untilStable((t) => t.replace(SLASH_FORMS, '/'), text);
const canonicalText = (text) => untilStable(decodeOnce, text);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A slug as a pattern: its '/' also matches a backslash (a Windows-style `owner\name`).
const slugSource = (slug) => escapeRegExp(slug).replace(/\//g, '[\\\\/]');

// Writes every file of `files` into `stagingDir` from `git show <rev>:<path>` (rev default HEAD) with its mode (`100755` -> 0o755, else 0o644).
// Each file gets the slug rewrite (spec 4.6): each case-insensitive occurrence of `privateSlug` becomes `publicSlug`.
// A binary file (see isBinary: a NUL anywhere, so UTF-16 text counts) is refused with code 1 naming only its path: it cannot be scanned, so
// nothing binary is staged. Text is handled as latin1 for the slug rewrite (the slug is ASCII): a valid UTF-8 file is never
// altered by that round trip (only ASCII slug bytes change), and an invalid one is refused later by checkContent.
// Returns { rewrites }: the number of occurrences replaced over all files.
export function buildStaging(repoRoot, files, { privateSlug: privSlug, publicSlug, stagingDir, rev = 'HEAD', env }) {
  const root = resolve(stagingDir);
  mkdirSync(root, { recursive: true });
  const slugPattern = new RegExp(escapeRegExp(privSlug), 'gi');
  let rewrites = 0;
  for (const { path, mode } of files) {
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new ExportError(`${path}: path leaves the staging directory`, 1);
    let data = git(repoRoot, ['show', `${rev}:${path}`], { buffer: true, env });
    if (isBinary(data)) throw new ExportError(BINARY_MESSAGE(path), 1);
    let count = 0;
    const text = data.toString('latin1').replace(slugPattern, () => {
      count += 1;
      return publicSlug;
    });
    rewrites += count;
    if (count > 0) data = Buffer.from(text, 'latin1');
    const fileMode = mode === '100755' ? MODE_EXECUTABLE : MODE_REGULAR;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: fileMode });
    chmodSync(target, fileMode);
  }
  return { rewrites };
}

// ---- local terms (content check category 1) ----

const DENY_NOT_TEXT = 'the public export deny file is not valid UTF-8 text';
// A NUL or C0 control other than tab, LF and CR: what BOM-less UTF-16 text (ASCII letters laced with NULs, valid as UTF-8) decodes to.
const DENY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
// U+FFFD (what a decoder makes of an invalid byte), DEL and the C1 controls: text the check can never see in a file, so a term
// holding one would silently block nothing.
const TERM_NEVER_MATCHES = /[\uFFFD\u007F-\u009F]/;
// Every line terminator: CRLF, LF, CR, NEL, LS and PS.
const DENY_LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;

// True when `path` exists as a directory entry itself (a symlink counts even when its target is missing).
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const isRealDir = (path) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};
const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// The local terms of one never-send entry (repo-identity Ruling B): the entry itself, plus, from its stored form, the path
// after the host and its last segment for a repository (`github.com/acme/widgets` → `acme/widgets`, `widgets`), or the path
// between the host and `*` for an owner (`github.com/globex/*` → `globex`). Names and invalid entries stay as they are. A
// broader term can only block more of the public tree.
function neverSendTerms(entry) {
  const kind = classifyEntry(entry);
  if (kind !== 'repo' && kind !== 'owner') return [entry];
  const stored = normalizeEntrySync(entry);
  const path = stored.slice(stored.indexOf('/') + 1);
  if (kind === 'owner') return [entry, path.slice(0, -'/*'.length)];
  return [entry, path, path.slice(path.lastIndexOf('/') + 1)];
}

// { terms, empty }: `clientTerms` and `neverSend` (each entry through neverSendTerms) of the memory-report config (path from
// resolvePaths for `env` and `home`) plus each line of the deny file (`env.PUBLIC_EXPORT_DENY`, else
// <home>/.config/triqual/public-export-deny.txt, or under the legacy dir until migration).
// The deny file is decoded as strict UTF-8 and split on every line terminator. Lines are trimmed; blank lines and `#` lines
// are skipped; a term that folds to nothing (invisible characters or a lone combining mark) is dropped, so `empty` counts
// only effective terms; duplicates are dropped case-insensitively. Read-only. A missing default deny file is fine, but an
// unparsable config, an invalid term list, a deny file that cannot be read or is not UTF-8 text (invalid bytes, a NUL or another
// control character), a PUBLIC_EXPORT_DENY that names a file that does not exist, a default deny file that is a broken symlink,
// or a term holding U+FFFD, DEL or a C1 control (it can never match) is code 2: the check must not run on a source it could not
// read, and a term must be able to match. So is a real legacy config dir beside the new one while either source is read from
// the config dir: the terms may be in the one brandDir does not read.
export function loadLocalTerms({ env = process.env, home = homedir() } = {}) {
  // brandDir reads the new config dir whenever it exists, so a real legacy dir beside it (migrate refuses to merge the
  // two) could hold a deny file or memory-report config the export would never see: refuse until they are merged.
  if (!env.PUBLIC_EXPORT_DENY || !env.MEMORY_REPORT_CONFIG) {
    const current = join(home, '.config', BRAND.dir);
    const legacy = join(home, '.config', BRAND.legacy.dir);
    if (isRealDir(legacy) && exists(current)) {
      throw new ExportError(`both ${legacy} and ${current} exist, so the local terms may be in either: merge ${legacy} `
        + `by hand into ${current} and remove it, then export again`, 2);
    }
  }
  const paths = resolvePaths(env, home);
  const { config, unparsable, invalidKeys } = loadConfig(paths);
  if (unparsable) throw new ExportError('the memory-report config is not valid JSON, so the local terms are unknown', 2);
  if (invalidKeys.some((key) => key === 'clientTerms' || key === 'neverSend')) {
    throw new ExportError('the memory-report config has an invalid clientTerms or neverSend list', 2);
  }
  const raw = [...config.clientTerms, ...config.neverSend.flatMap(neverSendTerms)];
  const named = Boolean(env.PUBLIC_EXPORT_DENY);
  const denyPath = named ? env.PUBLIC_EXPORT_DENY : join(brandDir(join(home, '.config')), 'public-export-deny.txt');
  let denyBytes = null;
  try {
    denyBytes = readFileSync(denyPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new ExportError(`the public export deny file cannot be read (${err.code ?? 'error'})`, 2);
    if (named) throw new ExportError('the public export deny file named by PUBLIC_EXPORT_DENY does not exist', 2);
    if (isLink(denyPath)) throw new ExportError('the public export deny file is a broken link', 2);
  }
  if (denyBytes !== null) {
    let text;
    try {
      text = strictUtf8.decode(denyBytes);
    } catch {
      throw new ExportError(DENY_NOT_TEXT, 2);
    }
    if (DENY_CONTROL.test(text)) throw new ExportError(DENY_NOT_TEXT, 2);
    for (const line of text.split(DENY_LINE_BREAK)) {
      if (!line.trim().startsWith('#')) raw.push(line);
    }
  }
  const seen = new Set();
  const terms = [];
  for (const entry of raw) {
    const term = String(entry).trim();
    if (term === '' || foldTerm(term) === '') continue;
    const key = term.toLowerCase();
    if (TERM_NEVER_MATCHES.test(term)) {
      throw new ExportError('a local term holds a character that can never match (U+FFFD, DEL or a C1 control)', 2);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return { terms, empty: terms.length === 0 };
}

// ---- content check (spec 4.4) ----

const GLOBAL_SECRET_PATTERNS = SECRET_PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));

// Every [start, end) span where one of `patterns` (global regexps) matches `line`, all occurrences of every pattern.
function patternSpans(line, patterns) {
  const spans = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
      spans.push([match.index, match.index + match[0].length]);
      if (match[0] === '') pattern.lastIndex += 1;
    }
  }
  return spans;
}

// Every [start, end) span where a secret pattern matches `line`.
const secretSpans = (line) => patternSpans(line, GLOBAL_SECRET_PATTERNS);

// Every [start, end) span of every occurrence of each of `needles` in `line`. An empty needle occurs nowhere: it has no span
// (indexOf('') matches at every offset and would never advance past the end of the line).
function occurrenceSpans(line, needles) {
  const spans = [];
  for (const needle of needles) {
    if (needle === '') continue;
    for (let at = line.indexOf(needle); at !== -1; at = line.indexOf(needle, at + 1)) spans.push([at, at + needle.length]);
  }
  return spans;
}

// True when one of `matches` ([start, end) spans in `text`) overlaps no occurrence of any of `allowed` in `text`: the overlap rule
// of allowSecrets, shared by allowLegacy.
const anyUncovered = (text, matches, allowed) => {
  if (matches.length === 0) return false;
  const covers = occurrenceSpans(text, allowed);
  return matches.some(([start, end]) => !covers.some(([from, to]) => start < to && from < end));
};

const EMAIL = /[\p{L}\p{N}._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+)/gu;
const TLD = /^[A-Za-z][A-Za-z0-9-]+$/;
const EMAIL_EXEMPT_SUFFIXES = ['noreply.github.com', '.invalid', '.test', '.example'];

// An address is exempt when its domain ends with noreply.github.com, is anthropic.com, starts with `example.` or ends with
// .invalid, .test or .example. A last label that is not a name (a version such as pkg@1.2.3) is not an address at all, and
// neither is the scp form of a git remote: local part `git` with the domain followed at once by `:` (git@host:owner/repo).
function hasEmail(line) {
  for (const match of line.matchAll(EMAIL)) {
    const domain = match[1].toLowerCase();
    if (!TLD.test(domain.slice(domain.lastIndexOf('.') + 1))) continue;
    if (match[0].startsWith('git@') && line[match.index + match[0].length] === ':') continue;
    if (EMAIL_EXEMPT_SUFFIXES.some((suffix) => domain.endsWith(suffix)) || domain === 'anthropic.com' || domain.startsWith('example.')) continue;
    return true;
  }
  return false;
}

// A run of comment or quote markers at the start of a line (`//`, `/**`, `*`, `#`, `>`, `--`, `;`, `<!--`), each followed by
// whitespace or the end of the line, with the whitespace before it. Stripped before lines are joined for a wrapped term.
const LEADING_MARKERS = /^\s*(?:(?:<!--|\/\/|\/\*|#|>|\*|--|;)+(?:\s+|$))+/;
const stripLead = (line) => line.replace(LEADING_MARKERS, '');

// Scans the staged files and returns [{ path, line, category }] in file, line and category order. Categories: local-term,
// home-path, email, secret, private-slug, old-name. Each file's path is checked first for local-term, home-path, private-slug
// and old-name (a hit there has line 0): a file name is published too. Then its text, line by line; a binary file (see
// isBinary) is code 1 with its path only, because it cannot be scanned. A local term matches under the folding contentVerdict applies (termHits), so a
// zero-width split, fullwidth letters, a \uXXXX escape or a diacritic does not hide it. A staged file that is not valid UTF-8 is
// refused with code 1 (the strict decode below), never read leniently, since a legacy encoding could hide a term. Hits never carry the matched text, so
// a report can be printed without leaking what it found. `allowSecrets` entries ({ path, contains }) cover a secret match, never
// the rest of its line: a match is covered when its span overlaps an occurrence of a `contains` of an entry for that path, and
// the line is a `secret` hit when any of its matches (every occurrence of every pattern) is uncovered.
// `legacyTerms` (default none) are old names: each matches case-insensitively where no slug character ([A-Za-z0-9_-]) touches
// it on either side, and a line (or the path) is an `old-name` hit when one of its matches is not covered by an `allowLegacy`
// entry for that path, under the allowSecrets overlap rule.
export function checkContent(stagingDir, files, { terms = [], home, privateSlug, publicSlug, allowSecrets = [], legacyTerms = [], allowLegacy = [] }) {
  const options = { terms, home, privateSlug, publicSlug, allowSecrets, legacyTerms, allowLegacy };
  const hits = [];
  for (const { path } of files) {
    let data;
    try {
      data = readFileSync(join(stagingDir, path));
    } catch (err) {
      throw new ExportError(`${path}: cannot read the staged file (${err.code ?? 'error'})`, 1);
    }
    if (isBinary(data)) throw new ExportError(BINARY_MESSAGE(path), 1);
    let text;
    try {
      text = strictUtf8.decode(data);
    } catch {
      throw new ExportError(`${path}: not valid UTF-8, so its content cannot be checked`, 1);
    }
    for (const { line, category } of scanText(text, path, options)) hits.push({ path, line, category });
  }
  return hits;
}

// The checks of checkContent on one text that is published as the file `path`: returns [{ line, category }], the path's hits
// first (line 0), then the text's line by line, then the whole-text term hit (line 0). Same options as checkContent, and the same
// categories; `privateSlug` is optional here: without it there is no private-slug check. `text` is the decoded content: refusing
// binary or non-UTF-8 bytes stays with the caller that reads them.
export function scanText(text, path, { terms = [], home, privateSlug, publicSlug, allowSecrets = [], legacyTerms = [], allowLegacy = [] } = {}) {
  const termList = terms.map(String);
  const homePath = typeof home === 'string' ? home.replace(/\/+$/, '').toLowerCase() : '';
  // The mask is anchored like the private slug's lookahead (a `.` too), so a public slug that is a prefix of the private one
  // (acme/tools masking acme/tools-private) never hides it.
  const publicMask = publicSlug ? new RegExp(`${slugSource(publicSlug)}(?![A-Za-z0-9_.-])`, 'gi') : null;
  const slugLeft = privateSlug ? new RegExp(`${slugSource(privateSlug)}(?![A-Za-z0-9_-])`, 'i') : null;
  const legacyPatterns = legacyTerms.map(String).filter((term) => term !== '').map((term) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(term)}(?![A-Za-z0-9_-])`, 'gi'));
  const oldNameHit = (value, allowed) => legacyPatterns.length > 0 && anyUncovered(value, patternSpans(value, legacyPatterns), allowed);
  const isHomePath = (value) => homePath !== '' && value.toLowerCase().includes(homePath);
  const found = (value) => {
    const categories = [];
    if (termHits(value, termList)) categories.push('local-term');
    if (isHomePath(value)) categories.push('home-path');
    return categories;
  };
  // The slug is tested as written, with its escaped slash forms normalized, and on the canonical form a reader or parser would
  // see (decoded escapes, percent-encoding and numeric entities, NFKC, default-ignorable characters removed), each to a fixed
  // point; the public slug is masked after that in each copy. The extra copies can only add hits.
  const slugHit = (value) => {
    if (slugLeft === null) return false;
    const copies = [value, slashNormalized(value), canonicalText(value)];
    return copies.some((copy) => slugLeft.test(publicMask ? copy.replace(publicMask, '\0') : copy));
  };
  const hits = [];
  const allowed = allowSecrets.filter((entry) => entry.path === path).map((entry) => entry.contains);
  const allowedLegacy = allowLegacy.filter((entry) => entry.path === path).map((entry) => entry.contains);
  const pathCategories = [...found(path), ...(slugHit(path) ? ['private-slug'] : []), ...(oldNameHit(path, allowedLegacy) ? ['old-name'] : [])];
  for (const category of pathCategories) hits.push({ line: 0, category });
  const lines = text.split('\n').map((raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw));
  // A term can wrap across lines, also inside a comment or quote block where every line starts with a marker. Besides each
  // line (checked as written), check each pair of consecutive lines joined with one space (a hit that neither line has alone
  // is reported at the pair's first line) and finally the whole text (line 0), which also catches a term wrapped over three
  // or more lines. The pair and the whole text are checked with the leading markers stripped (`stripLead`), and as written
  // when stripping changed a line, so the marker never splits or hides a term.
  const own = lines.map((line) => termHits(line, termList));
  const bare = lines.map(stripLead);
  const joined = (a, b) => termHits(`${a} ${b}`, termList);
  const paired = lines.map((line, index) => {
    if (own[index] || index + 1 >= lines.length || own[index + 1]) return false;
    const next = lines[index + 1];
    return joined(bare[index], bare[index + 1]) || ((bare[index] !== line || bare[index + 1] !== next) && joined(line, next));
  });
  lines.forEach((line, index) => {
    const categories = [];
    if (own[index] || paired[index]) categories.push('local-term');
    if (isHomePath(line)) categories.push('home-path');
    if (hasEmail(line)) categories.push('email');
    if (anyUncovered(line, secretSpans(line), allowed)) categories.push('secret');
    if (slugHit(line)) categories.push('private-slug');
    if (oldNameHit(line, allowedLegacy)) categories.push('old-name');
    for (const category of categories) hits.push({ line: index + 1, category });
  });
  const prefixed = bare.some((line, index) => line !== lines[index]);
  if (!own.includes(true) && !paired.includes(true) && (termHits(text, termList) || (prefixed && termHits(bare.join('\n'), termList)))) hits.push({ line: 0, category: 'local-term' });
  return hits;
}

// sha256 of the bytes of every staged file, { path: hex }. The CLI records it right after the content check and compares it
// again just before the target is written. A file that cannot be read is code 1.
export function stagedDigests(stagingDir, files) {
  const digests = {};
  for (const { path } of files) {
    try {
      digests[path] = createHash('sha256').update(readFileSync(join(stagingDir, path))).digest('hex');
    } catch (err) {
      throw new ExportError(`${path}: cannot read the staged file (${err.code ?? 'error'})`, 1);
    }
  }
  return digests;
}

// Fail closed on the bytes that are about to be copied: re-runs checkContent on `stagingDir` and compares every file's digest
// with `digests` (from stagedDigests). Any difference or hit is code 1; the message names paths and categories, never text.
export function assertStagedUnchanged(stagingDir, files, checkOptions, digests) {
  const now = stagedDigests(stagingDir, files);
  const changed = files.map((file) => file.path).filter((path) => now[path] !== digests[path]);
  if (changed.length > 0) throw new ExportError(`staged files changed after the content check, so nothing was written:\n${changed.map((path) => `  ${path}`).join('\n')}`, 1);
  const hits = checkContent(stagingDir, files, checkOptions);
  if (hits.length > 0) {
    throw new ExportError(`the content check failed again just before the write, so nothing was written:\n${hits.map((hit) => `  ${hit.path}:${hit.line} ${hit.category}`).join('\n')}`, 1);
  }
}

// ---- staged test run (spec 4.3 step 5) ----

// The staged suite takes 9 to 12 minutes, depending on machine load (it saturates the machine itself); the limit is
// twice that, a guard against a hung run and not a speed test.
export const STAGED_TEST_TIMEOUT_MS = 20 * 60 * 1000;
const SUMMARY_FALLBACK_LINES = 10;
const COUNT_LINE = /^\s*(?:#|\u2139)\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// The "failing tests:" section of the spec reporter lists `test at <file>:<line>` and then `\u2716 <name> (<time>)` for each
// failure: returns `failed: <file>:<line> <name>` for the first MAX_FAILED_LISTED of them.
const MAX_FAILED_LISTED = 20;
function failingTests(lines) {
  const failed = [];
  let inSection = false;
  let at = '';
  for (const line of lines) {
    if (/^\u2716 failing tests:/.test(line)) inSection = true;
    else if (inSection) {
      const where = /^test at (.+)$/.exec(line);
      const named = /^\u2716 (.+?)(?: \([\d.]+ms\))?$/.exec(line);
      if (where) at = where[1];
      else if (named) failed.push(`failed: ${at} ${named[1]}`);
    }
  }
  if (failed.length === 0) {
    // TAP (node --test's output when stdout is not a terminal on Node 22): `not ok <n> - <name>`, then its YAML block's
    // `location: '<file>:<line>:<col>'`.
    let name = null;
    for (const line of lines) {
      const notOk = /^\s*not ok \d+ - (.+)$/.exec(line);
      const location = /^\s*location: '(.+)'$/.exec(line);
      if (notOk) name = notOk[1];
      else if (location && name !== null) {
        failed.push(`failed: ${location[1]} ${name}`);
        name = null;
      }
    }
  }
  return failed.slice(0, MAX_FAILED_LISTED);
}

// The `tests/pass/fail/skipped` counts of the node test runner's closing lines (TAP `# tests 3` or spec `\u2139 tests 3`), or
// the last lines of the output when it carries none.
function summarize(output) {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const counts = {};
  for (const line of lines) {
    const match = COUNT_LINE.exec(line);
    if (match) counts[match[1]] = Number(match[2]);
  }
  if ('tests' in counts && 'pass' in counts && 'fail' in counts) {
    const total = `tests ${counts.tests}, pass ${counts.pass}, fail ${counts.fail}, skipped ${counts.skipped ?? 0}`;
    const failed = failingTests(lines);
    return failed.length > 0 ? `${total}\n${failed.join('\n')}` : total;
  }
  return lines.filter((line) => line.trim() !== '').slice(-SUMMARY_FALLBACK_LINES).join('\n');
}

// Runs `npm test` in `stagingDir` with only PATH (`pathEnv`, default the caller's), TMPDIR and LANG (the caller's, when set)
// and HOME=`tmpHome`: no GIT_*, MEMORY_REPORT_* or CM_* variable and nothing else reaches the child. Returns { ok, summary };
// a timeout (`timeoutMs`, default STAGED_TEST_TIMEOUT_MS) or a failure to start npm is { ok: false } with the reason.
export function runStagedTests(stagingDir, { tmpHome, pathEnv = process.env.PATH, timeoutMs = STAGED_TEST_TIMEOUT_MS }) {
  const env = { PATH: pathEnv, HOME: tmpHome };
  for (const key of ['TMPDIR', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
  const run = spawnSync('npm', ['test'], {
    cwd: stagingDir,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (run.error) {
    const reason = run.error.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `could not run npm (${run.error.code ?? 'error'})`;
    return { ok: false, summary: reason };
  }
  return { ok: run.status === 0, summary: summarize(`${run.stdout ?? ''}\n${run.stderr ?? ''}`) };
}

// ---- target safety (spec 4.2) ----

const SLUG_FORMAT = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const IDENTITY_VARS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const IDENT_WITHOUT_DATE = /^(.*>)\s+\d+\s+[+-]\d{4}\s*$/;

const refuse = (message) => {
  throw new ExportError(message, 2);
};

// The exit status of a git command that is expected to fail with `status` when its answer is "no"; any other failure rethrows.
function gitAnswer(dir, args, env, noStatus = 1, input) {
  try {
    return git(dir, args, { env, input });
  } catch (err) {
    if (err.status === noStatus) return null;
    throw err;
  }
}

const realpathOrRefuse = (path, what) => {
  try {
    return realpathSync(path);
  } catch {
    return refuse(`${what} does not exist`);
  }
};

// A remote URL names the private repository when its path, case-insensitively, is the slug optionally followed by `.git`
// and/or `/` (scp form, ssh:// and https:// alike); `<slug>-public` therefore does not match.
const namesPrivate = (url, privSlug) => new RegExp(`(?:^|[/:])${escapeRegExp(privSlug)}(?:\\.git|/)*$`, 'i').test(url.trim());

// Every URL the target's remotes use: the configured url and pushurl values, and what `git remote get-url` makes of each
// remote after url.<base>.insteadOf and pushInsteadOf rewriting.
function remoteUrls(dir, env) {
  const urls = [];
  const configured = gitAnswer(dir, ['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], env) ?? '';
  for (const line of configured.split('\n')) if (line.includes(' ')) urls.push(line.slice(line.indexOf(' ') + 1));
  for (const name of git(dir, ['remote'], { env }).split('\n').filter(Boolean)) {
    for (const flags of [[], ['--push']]) urls.push(...git(dir, ['remote', 'get-url', ...flags, '--all', name], { env }).split('\n').filter(Boolean));
  }
  return urls;
}

// The target's author and committer identity as git would write them, without the timestamp.
function identityOf(dir, env, kind) {
  let ident;
  try {
    ident = git(dir, ['var', `GIT_${kind}_IDENT`], { env }).trim();
  } catch {
    return refuse(`git cannot determine the ${kind.toLowerCase()} identity of the target`);
  }
  const match = IDENT_WITHOUT_DATE.exec(ident);
  return match ? match[1] : ident;
}

// Spec 4.2: every refusal is an ExportError with code 2, raised before anything is built or written. Only reads happen here
// (`status` runs without optional locks so it does not refresh the target's index). Returns { unborn, identity: { author,
// committer } }; the identity is what git will write, for the caller to print before any write.
// Every refusal is code 2, also a git failure while inspecting (a corrupt index, an unreadable repository): the target cannot be
// shown safe, so nothing is built. `rev` (default HEAD) is the private commit whose root commits and sha the target must not hold.
export function checkTarget(dir, options) {
  try {
    return inspectTarget(dir, options);
  } catch (err) {
    if (err instanceof ExportError) throw err;
    const reason = String(err.stderr ?? '').split('\n').find((line) => line.trim() !== '') ?? err.code ?? 'git failed';
    throw new ExportError(`the target or the private repository cannot be inspected: ${String(reason).trim()}`, 2);
  }
}

function inspectTarget(dir, { repoRoot, privateSlug: privSlug, publicSlug, terms = [], env = process.env, rev = 'HEAD' }) {
  if (typeof publicSlug !== 'string' || !SLUG_FORMAT.test(publicSlug) || /(?:\.git|\.)$/i.test(publicSlug)) {
    refuse('--public-repo must look like owner/name (letters, digits, ".", "_" and "-"; the name cannot end in ".git" or ".")');
  }
  if (publicSlug.toLowerCase() === privSlug.toLowerCase()) refuse('--public-repo names the private repository');

  const realDir = realpathOrRefuse(dir, 'the target directory');
  let top;
  try {
    top = realpathSync(git(dir, ['rev-parse', '--show-toplevel'], { env }).trim());
  } catch {
    return refuse('the target is not inside a git repository');
  }
  if (top !== realDir) refuse('the target must be the root of its repository, not a subdirectory');

  const privateTop = realpathSync(git(repoRoot, ['rev-parse', '--show-toplevel'], { env }).trim());
  const privatePaths = [privateTop];
  for (const line of git(repoRoot, ['worktree', 'list', '--porcelain'], { env }).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    try {
      privatePaths.push(realpathSync(path));
    } catch {
      privatePaths.push(path);
    }
  }
  if (privatePaths.includes(realDir)) refuse('the target is the private repository or one of its worktrees');

  const shared = [...git(repoRoot, ['rev-list', '--max-parents=0', rev], { env }).split('\n'), git(repoRoot, ['rev-parse', rev], { env }).trim()].filter(Boolean);
  for (const sha of shared) {
    if (gitAnswer(dir, ['cat-file', '-e', sha], env) !== null) refuse('the target shares history with the private repository');
  }

  // No commit reachable from any ref of the target, whatever its HEAD (an unborn orphan branch can sit beside refs holding private
  // history), may exist in the private repository: the target's list is checked against the private object store in one pass.
  // Replace refs are ignored on both sides so they cannot hide a commit.
  const held = git(dir, ['--no-replace-objects', 'rev-list', '--all'], { env });
  if (held.trim() !== '') {
    const answers = git(repoRoot, ['--no-replace-objects', 'cat-file', '--batch-check'], { env, input: held });
    if (answers.split('\n').some((line) => line !== '' && !line.endsWith(' missing'))) refuse('the target shares history with the private repository');
  }

  if (remoteUrls(dir, env).some((url) => namesPrivate(url, privSlug))) refuse('a remote of the target names the private repository');

  if (git(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], { env }).trim() !== '') refuse('the target has uncommitted changes');
  const unborn = gitAnswer(dir, ['rev-parse', '--verify', '-q', 'HEAD'], env) === null;

  const configured = ['user.name', 'user.email'].every((key) => (gitAnswer(dir, ['config', '--get', key], env) ?? '').trim() !== '');
  const fromEnv = IDENTITY_VARS.every((key) => typeof env[key] === 'string' && env[key] !== '');
  if (!configured && !fromEnv) {
    refuse('the target has no explicit commit identity: set user.name and user.email in its git config, or GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL');
  }
  const identity = { author: identityOf(dir, env, 'AUTHOR'), committer: identityOf(dir, env, 'COMMITTER') };
  const termList = terms.map(String);
  for (const kind of ['author', 'committer']) {
    if (termHits(identity[kind], termList)) refuse(`the ${kind} identity contains a local term`);
  }
  return { unborn, identity };
}

// ---- updating the target and committing (spec 4.7) ----

const NO_SUCH_ENTRY = 'ENOENT';

// Refuses, before anything changes, a staged path that would write into the target's git directory (case-insensitively: the
// file system may fold case) or through a symlinked directory of the target.
function assertSafeDestinations(root, files) {
  for (const { path } of files) {
    const segments = path.split('/');
    if (segments[0].toLowerCase() === '.git') throw new ExportError(`${path}: a staged path inside .git is never written to the target`, 1);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (err) {
        if (err.code === NO_SUCH_ENTRY) break;
        throw err;
      }
      if (stat.isSymbolicLink()) throw new ExportError(`${path}: a parent directory in the target is a symlink`, 1);
    }
  }
}

// Removes `file` and then each parent directory that became empty, never above `root`.
function removeWithEmptyParents(root, file) {
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code !== NO_SUCH_ENTRY) throw err;
  }
  for (let dir = dirname(file); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
    if (readdirSync(dir).length > 0) break;
    rmdirSync(dir);
  }
}

// The staged paths that the target's ignore rules, as they will be once the staged files are in place, would ignore: those files
// would be copied but never committed, and `git status` hides them. Asked of git without touching the target: the work tree is
// a scratch directory that holds only the `.gitignore` files that will exist afterwards (the staged ones, and the target's
// tracked ones that are neither staged nor deleted), while `.git/info/exclude` and the global excludes come from the target's
// own git directory. `--no-index` so a tracked path is judged by the rules alone.
function ignoredStagedPaths(root, stagingDir, files, manifest, tracked, env) {
  const scratch = mkdtempSync(join(tmpdir(), 'export-public-ignore-'));
  try {
    const staged = new Set(files.map((file) => file.path));
    const sources = files.filter(({ path }) => basename(path) === '.gitignore').map(({ path }) => [path, join(stagingDir, path)]);
    for (const path of tracked) {
      if (basename(path) === '.gitignore' && !staged.has(path) && manifest.keepInTarget.some((entry) => matches(entry, path))) sources.push([path, join(root, path)]);
    }
    for (const [path, from] of sources) {
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      writeFileSync(join(scratch, path), readFileSync(from));
    }
    const input = files.map((file) => `${file.path}\0`).join('');
    const answer = gitAnswer(root, ['--work-tree', scratch, 'check-ignore', '--no-index', '-z', '--stdin'], env, 1, input) ?? '';
    return answer.split('\0').filter(Boolean).sort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Spec 4.7 steps 1 and 2. Deletes every tracked file of the target that is neither staged nor under `keepInTarget`, copies
// each staged file ({ path, mode } from `files`, bytes from `stagingDir`) with its mode (a symlink at the destination is
// replaced, never written through), calls `afterCopy()` when given, then compares the paths of `git status --porcelain -z
// --untracked-files=all` with staged paths and deleted paths. Returns { deleted, unexpected } (both sorted path lists);
// the caller decides what `unexpected` means. Pre-flight, before anything changes: code 1 for a staged path that cannot be
// written safely, code 2 for one that the target would ignore (it would be copied and never committed). Then `beforeWrite()` is
// called, after the last refusal and before the first deletion: the caller re-checks the target and the staged bytes there, and
// whatever it throws leaves the target as it was.
export function updateTarget(dir, stagingDir, files, manifest, { env = process.env, afterCopy, beforeWrite } = {}) {
  const root = realpathSync(dir);
  assertSafeDestinations(root, files);
  const staged = new Set(files.map((file) => file.path));
  const tracked = git(root, ['ls-files', '-z'], { env }).split('\0').filter(Boolean);
  const ignored = ignoredStagedPaths(root, stagingDir, files, manifest, tracked, env);
  if (ignored.length > 0) {
    throw new ExportError(`the target's ignore rules would ignore staged paths, so they would be copied but never committed:\n${ignored.map((path) => `  ${path}`).join('\n')}`, 2);
  }
  if (beforeWrite) beforeWrite();
  const deleted = [];
  for (const path of tracked) {
    if (staged.has(path) || manifest.keepInTarget.some((entry) => matches(entry, path))) continue;
    removeWithEmptyParents(root, join(root, path));
    deleted.push(path);
  }
  for (const { path, mode } of files) {
    const dest = resolve(root, path);
    if (!dest.startsWith(root + sep)) throw new ExportError(`${path}: path leaves the target`, 1);
    const fileMode = mode === '100755' ? MODE_EXECUTABLE : MODE_REGULAR;
    mkdirSync(dirname(dest), { recursive: true });
    try {
      if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest);
    } catch (err) {
      if (err.code !== NO_SUCH_ENTRY) throw err;
    }
    writeFileSync(dest, readFileSync(join(stagingDir, path)), { mode: fileMode });
    chmodSync(dest, fileMode);
  }
  if (afterCopy) afterCopy();
  const expected = new Set([...staged, ...deleted]);
  const records = git(root, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], { env }).split('\0');
  const reported = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === '') continue;
    reported.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2)) && i + 1 < records.length) reported.push(records[++i]);
  }
  return { deleted: deleted.sort(), unexpected: [...new Set(reported.filter((path) => !expected.has(path)))].sort() };
}

// Spec 4.7 step 3: `git add -A`, then a commit with `message` unless nothing is staged. Returns 'committed' or 'no changes'.
// The identity is whatever `env` and the target's config give git; nothing is pushed and no remote is touched.
export function commitTarget(dir, message, { env = process.env } = {}) {
  git(dir, ['add', '-A'], { env });
  if (git(dir, ['status', '--porcelain'], { env }).trim() === '') return 'no changes';
  git(dir, ['commit', '-q', '-m', message], { env });
  return 'committed';
}
