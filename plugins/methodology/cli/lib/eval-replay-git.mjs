// Git facts for one replay case: which commit is the original, which tests it hid, and which
// names those tests use that the brief never mentioned. A git failure is an empty answer
// (null, false, 0, or an empty list), never a throw: a missing sha is a case with nothing to grade.
// Every call is spawnSync('git', ['-C', repo, ...]) — an args array, no shell — with a 60s timeout.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import posix from 'node:path/posix';

const GIT_TIMEOUT_MS = 60_000;
// spawnSync's default maxBuffer is 1 MiB; a larger file would fail with ENOBUFS and read as absent.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// Paths a diff treats as tests. A helper that sits under test/ is a hidden test, not support.
export const TEST_FILE = /(^|\/)(test|tests|spec|__tests__)\/|\.(test|spec)\.|_test\./;

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

// spawnSync does not throw on a non-zero status. A timeout or a missing git sets error.
function gitResult(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
}

function gitText(repo, args) {
  const r = gitResult(repo, args);
  if (!r || r.error || r.status !== 0) return null;
  return r.stdout;
}

function gitOk(repo, args) {
  return gitText(repo, args) !== null;
}

// 0 found, 1 not found, null when git itself failed. Exit 1 is the answer, not a failure.
function gitFound(repo, args) {
  const r = gitResult(repo, args);
  if (!r || r.error || r.status == null) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

function verify(repo, rev) {
  const text = gitText(repo, ['rev-parse', '--verify', rev]);
  const sha = text?.trim();
  return sha || null;
}

// dirname of the absolute common git dir: a linked worktree resolves to the main checkout.
export function mainCheckout(cwd) {
  const text = gitText(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!text) return null;
  const parent = dirname(text.trim());
  try { return realpathSync(parent); } catch { return parent; }
}

// Last ref first. A sha must be a commit; a subject is the newest fixed-string match on any ref.
export function resolveOriginal(repo, refs) {
  const list = Array.isArray(refs) ? refs : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ref = list[i] || {};
    let sha = null;
    if (ref.sha != null) sha = verify(repo, `${ref.sha}^{commit}`);
    else if (ref.subject != null) sha = subjectSha(repo, ref.subject);
    if (sha) return sha;
  }
  return null;
}

function subjectSha(repo, subject) {
  const text = gitText(repo, ['log', '--all', '-F', `--grep=${subject}`, '--format=%H']);
  if (text == null) return null;
  const line = text.split('\n').map((s) => s.trim()).find(Boolean);
  return line || null;
}

// True when `path` (relative to the repo root) is a file of the commit `sha`.
export function existsAt(repo, sha, path) {
  return gitOk(repo, ['cat-file', '-e', `${sha}:${path}`]);
}

export function firstParent(repo, sha) {
  return verify(repo, `${sha}^`);
}

// origin/HEAD, else main, else master. True when sha is an ancestor of that branch, or when every file the commit changed is on
// that branch exactly as the commit left it: a squash merge or a rebase rewrote the commit, but its content landed.
export function isMerged(repo, sha) {
  let branch = null;
  for (const ref of ['origin/HEAD', 'main', 'master']) {
    if (verify(repo, ref)) { branch = ref; break; }
  }
  if (!branch) return false;
  return gitOk(repo, ['merge-base', '--is-ancestor', sha, branch]) || landedOn(repo, sha, branch);
}

// Every path the commit changed has the commit's blob on `branch` (a deleted path is absent there); false for no paths.
function landedOn(repo, sha, branch) {
  const parent = firstParent(repo, sha);
  const text = parent === null ? null : gitText(repo, ['diff', '--name-status', '--no-renames', parent, sha]);
  const rows = text === null ? [] : parseNameStatus(text);
  return rows.length > 0 && rows.every((row) => {
    const landed = verify(repo, `${branch}:${row.path}`);
    return row.status === 'D' ? landed === null : landed === verify(repo, `${sha}:${row.path}`);
  });
}

export function isJsTest(path) {
  return JS_EXT.has(posix.extname(path));
}

export function caseFiles(repo, base, original, named) {
  const none = { hiddenTests: [], supportFiles: [] };
  const text = gitText(repo, ['diff', '--name-status', base, original]);
  if (text == null) return none;
  const rows = parseNameStatus(text);
  const hiddenTests = rows.filter((row) => row.status !== 'D' && TEST_FILE.test(row.path)).map((row) => row.path);
  const brief = named ?? '';
  const contents = new Map();
  for (const path of hiddenTests) contents.set(path, gitText(repo, ['show', `${original}:${path}`]));
  const supportFiles = [];
  for (const row of rows) {
    if (row.status !== 'A' || TEST_FILE.test(row.path)) continue;
    if (brief.includes(row.path) || brief.includes(posix.basename(row.path))) continue;
    if (hiddenTests.some((testPath) => namesSupport(contents.get(testPath), testPath, row.path))) {
      supportFiles.push(row.path);
    }
  }
  return { hiddenTests, supportFiles };
}

function parseNameStatus(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const path = parts[parts.length - 1];
    if (!path || !parts[0]) continue;
    rows.push({ status: parts[0][0], path });
  }
  return rows;
}

// A hidden test names a support file by its repo path, or by the path from the test's directory,
// with or without a leading ./ and with or without the extension. Path characters stay attached,
// so `../src/b` does not match `../src/b.mjs`.
function namesSupport(content, testPath, supportPath) {
  if (!content) return false;
  const rel = posix.relative(posix.dirname(testPath), supportPath);
  for (const path of [rel, supportPath]) {
    for (const form of pathForms(path)) {
      if (mentions(content, form)) return true;
    }
  }
  return false;
}

function pathForms(path) {
  const forms = [];
  const add = (p) => {
    if (!p || p === '.' || p === '..') return;
    forms.push(p);
    if (!p.startsWith('.')) forms.push(`./${p}`);
  };
  add(path);
  const noExt = path.replace(/\.[^./]+$/, '');
  if (noExt !== path) add(noExt);
  return forms;
}

function mentions(content, form) {
  const boundary = /[^A-Za-z0-9_./$~-]/;
  let from = 0;
  for (;;) {
    const i = content.indexOf(form, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : content[i - 1];
    const after = i + form.length >= content.length ? '' : content[i + form.length];
    const edge = (ch) => ch === '' || boundary.test(ch);
    if (edge(before) && edge(after)) return true;
    from = i + 1;
  }
}

// checked is false when any hidden test is not JS/TS: symbol rules do not apply to other languages.
// The imported name is kept, not the local alias (`b as c`, `a: local` in require).
export function unnamedSymbols(repo, base, original, hiddenTests, named) {
  const tests = hiddenTests ?? [];
  if (tests.some((path) => !isJsTest(path))) return { checked: false, names: [] };
  const brief = named ?? '';
  const names = [];
  const seen = new Set();
  for (const path of tests) {
    const text = gitText(repo, ['show', `${original}:${path}`]);
    if (text == null) continue;
    for (const name of importedNames(text)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (wordIn(brief, name)) continue;
      const found = gitFound(repo, ['grep', '-w', '-q', '-e', name, base]);
      if (found === false) names.push(name);
    }
  }
  return { checked: true, names };
}

function importedNames(source) {
  const names = [];
  const re = /import\s*\{([^}]+)\}\s*from\b|import\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\b|const\s*\{([^}]+)\}\s*=\s*require\s*\(/g;
  for (const match of source.matchAll(re)) {
    if (match[1] != null) names.push(...bindingNames(match[1], 'as'));
    else if (match[2] != null) names.push(match[2]);
    else names.push(...bindingNames(match[3], ':'));
  }
  return names.filter(Boolean);
}

function bindingNames(inner, sep) {
  const names = [];
  for (const part of inner.split(',')) {
    let binding = part.trim().replace(/^type\s+/, '');
    if (!binding) continue;
    if (sep === 'as') binding = binding.split(/\s+as\s+/)[0].trim();
    else binding = binding.split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(binding)) names.push(binding);
  }
  return names;
}

function wordIn(text, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${esc}(?:$|[^A-Za-z0-9_$])`).test(text);
}

// Three-or-more-word string literals inside assert.*() or expect() that base and the brief lack.
export function countUnnamedLiterals(repo, base, original, hiddenTests, named) {
  const brief = named ?? '';
  let count = 0;
  for (const path of hiddenTests ?? []) {
    if (!isJsTest(path)) continue;
    const text = gitText(repo, ['show', `${original}:${path}`]);
    if (text == null) continue;
    for (const literal of assertedLiterals(text)) {
      if (brief.includes(literal)) continue;
      const found = gitFound(repo, ['grep', '-F', '-q', '-e', literal, base]);
      if (found === false) count += 1;
    }
  }
  return count;
}

// A chained matcher call after expect(x): `.toBe(`, `.not.toBe(`, `.resolves.toBe(`, `.rejects.toBe(`.
const MATCHER_CALL = /\s*\.\s*(?:(?:not|resolves|rejects)\s*\.\s*)*[A-Za-z_$][\w$]*\s*\(/y;

// Index of the '(' of the matcher call that starts at `from`, or -1.
function matcherOpen(source, from) {
  MATCHER_CALL.lastIndex = from;
  const m = MATCHER_CALL.exec(source);
  return m ? m.index + m[0].length - 1 : -1;
}

function assertedLiterals(source) {
  const found = [];
  const re = /\b(?:assert(?:\s*\.\s*[A-Za-z_$][\w$]*)?|expect)\s*\(/g;
  let match;
  while ((match = re.exec(source))) {
    const open = match.index + match[0].length - 1;
    let close = balancedEnd(source, open);
    if (close < 0) break;
    found.push(...threeWordLiterals(source.slice(open + 1, close)));
    // The expected values sit in the matcher's arguments, not in expect(x) itself.
    for (let argsOpen = matcherOpen(source, close + 1); argsOpen >= 0; argsOpen = matcherOpen(source, close + 1)) {
      close = balancedEnd(source, argsOpen);
      if (close < 0) return found;
      found.push(...threeWordLiterals(source.slice(argsOpen + 1, close)));
    }
    re.lastIndex = close + 1;
  }
  return found;
}

function threeWordLiterals(source) {
  return stringLiterals(source).filter((literal) => literal.trim().split(/\s+/).filter(Boolean).length >= 3);
}

function balancedEnd(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    if (source[j] === '\\') { j += 1; continue; }
    if (source[j] === quote) return j;
  }
  return -1;
}

function stringLiterals(source) {
  const out = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') continue;
    const end = skipString(source, i);
    if (end < 0) break;
    out.push(decodeLiteral(source.slice(i + 1, end)));
    i = end;
  }
  return out;
}

function decodeLiteral(raw) {
  return raw.replace(/\\(n|r|t|\\|'|"|`)/g, (_, ch) => ({
    n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '`': '`',
  }[ch]));
}

// Writes each `sha:path` under dir, creating parents. False when any path cannot be written.
// The blob is read as a Buffer: a utf8 decode would rewrite invalid byte sequences.
export function restoreFiles(repo, sha, paths, dir) {
  try {
    for (const path of paths ?? []) {
      const r = spawnSync('git', ['-C', repo, 'show', `${sha}:${path}`], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
      if (!r || r.error || r.status !== 0) return false;
      const dest = join(dir, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, r.stdout);
    }
    return true;
  } catch {
    return false;
  }
}
