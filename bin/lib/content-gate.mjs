// The content gate: decides whether a set of files may be published to the public repository. It runs the export's text
// checks (scanText: deny terms, home paths, emails, secrets) on each file's bytes, and refuses the paths that never leave the
// private repository (FORBIDDEN_PATHS) and the files whose content cannot be checked (a NUL byte, invalid UTF-8).
//
//   node bin/lib/content-gate.mjs (--all | --range <base>..<head>) [--no-terms]
//
// --all checks every file in the index (`git ls-files`), so a term added to the deny list later is checked against the existing
// files; --range checks the added, copied, modified, renamed or type-changed paths of `git diff <range>` as they are at <head>.
// Exit 0 clean, 1 hits, 2 usage error, a git or read failure, or no local terms without --no-terms (TRIQUAL_GATE_NO_LOCAL_TERMS=1
// acts as --no-terms: CI has no deny file). A hit prints as `path:line · category`, never the matched text. Line 0 is a hit on
// the path or the whole file. The private slug is a deny-list term, so it reports as `local-term`.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExportError, loadLocalTerms, scanText } from './export.mjs';

// Root-anchored gitignore-style patterns: a trailing slash is a directory and everything under it, anything else is that one file.
export const FORBIDDEN_PATHS = [
  '/docs/',
  '/probes/',
  '/CLAUDE.md',
  '/AGENTS.md',
  '/.githooks/',
  '/.methodology/',
  '/progress.md',
  '/status.md',
  '/test/no-personal-data.test.mjs',
  '/test/brand-guard.test.mjs',
  '/test/e2e-probe.test.mjs',
  '/test/provider-probes.test.mjs',
];

// Compared case-insensitively: a checkout on a case-insensitive file system would otherwise let `Docs/x.md` land on `docs/`.
const FORBIDDEN = FORBIDDEN_PATHS.map((pattern) => ({ prefix: pattern.slice(1).toLowerCase(), directory: pattern.endsWith('/') }));

export function isForbidden(path) {
  const folded = String(path).toLowerCase();
  return FORBIDDEN.some(({ prefix, directory }) => (directory ? folded.startsWith(prefix) : folded === prefix));
}

// The export's binary rule: a NUL byte anywhere, or bytes that are not strict UTF-8 (which would decode to U+FFFD and hide a
// term). ignoreBOM keeps a leading BOM in the text, as the export does.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// { configured, hits }: `configured` is false when `terms` is empty (the term check then had nothing to look for).
// `readFile(path)` returns the file's bytes. Each path gets, in order, a `forbidden-path` hit (line 0), then either one
// `not-text` hit (line 0) or scanText's hits (path-level hits on line 0, then line by line).
export function gateFiles(paths, { readFile, terms = [], home, allowSecrets = [] }) {
  const hits = [];
  for (const path of paths) {
    if (isForbidden(path)) hits.push({ path, line: 0, category: 'forbidden-path' });
    const data = readFile(path);
    let text = null;
    if (!data.includes(0)) {
      try {
        text = strictUtf8.decode(data);
      } catch {
        text = null;
      }
    }
    if (text === null) {
      hits.push({ path, line: 0, category: 'not-text' });
      continue;
    }
    for (const { line, category } of scanText(text, path, { terms, home, allowSecrets })) hits.push({ path, line, category });
  }
  return { configured: terms.length > 0, hits };
}

// The allowlist of known test-fixture secrets, next to this module.
export const loadAllowSecrets = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gate-allow.json'), 'utf8'));

export const formatHit = ({ path, line, category }) => `${path}:${line} · ${category}`;

// ---- CLI ----

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const RANGE = /^[^-][^\0]*?\.{2,3}[^\0]*$/;
const USAGE = 'usage: content-gate.mjs (--all | --range <base>..<head>) [--no-terms]';

// git in `cwd` with the inherited environment: inside a hook GIT_INDEX_FILE must reach it, so the index being committed is the
// one read.
function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0];
    throw new ExportError(`git ${args[0]} failed${reason ? `: ${reason}` : ''}`, 2);
  }
}

const splitNul = (buffer) => buffer.toString('utf8').split('\0').filter((entry) => entry !== '');

function parseArgs(argv) {
  const options = { all: false, range: null, noTerms: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--no-terms') options.noTerms = true;
    else if (arg === '--range') {
      i += 1;
      if (i >= argv.length) throw new ExportError(`--range needs a value\n${USAGE}`, 2);
      options.range = argv[i];
    } else throw new ExportError(`unknown argument ${arg}\n${USAGE}`, 2);
  }
  if (options.all === (options.range !== null)) throw new ExportError(`give exactly one of --all and --range\n${USAGE}`, 2);
  if (options.range !== null && !RANGE.test(options.range)) throw new ExportError(`--range must be <base>..<head> or <base>...<head>\n${USAGE}`, 2);
  return options;
}

export function main(argv, { env = process.env, cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  try {
    const options = parseArgs(argv);
    const root = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
    let paths;
    let readFile;
    if (options.all) {
      paths = splitNul(git(root, ['ls-files', '-z']));
      readFile = (path) => git(root, ['show', `:${path}`]);
    } else {
      const head = options.range.split(/\.{2,3}/).pop() || 'HEAD';
      paths = splitNul(git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRT', options.range, '--']));
      readFile = (path) => git(root, ['show', `${head}:${path}`]);
    }
    const noTerms = options.noTerms || env.TRIQUAL_GATE_NO_LOCAL_TERMS === '1';
    const home = env.HOME || homedir();
    const terms = noTerms ? [] : loadLocalTerms({ env, home }).terms;
    if (!noTerms && terms.length === 0) {
      throw new ExportError('no local terms are configured, so the term check cannot run: add terms to the deny file, or pass --no-terms (or set TRIQUAL_GATE_NO_LOCAL_TERMS=1) to run the other checks only', 2);
    }
    const allowSecrets = loadAllowSecrets();
    const { hits } = gateFiles(paths, { readFile, terms, home, allowSecrets });
    for (const hit of hits) out(formatHit(hit));
    return hits.length > 0 ? 1 : 0;
  } catch (error) {
    err(`error: ${error.message}`);
    return error instanceof ExportError ? error.code : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
