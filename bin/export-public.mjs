#!/usr/bin/env node
// Public export: builds the manifest's files of this repository's HEAD (resolved to one sha at the start and used for every
// read) in a temporary staging directory, checks them, runs their tests on a copy, and commits the checked bytes into a
// separate, verified target repository (spec 4.1 to 4.7). It never pushes and never adds a remote; on a failure after the
// target was touched it prints how to restore it and does not restore it itself.
// Usage: node bin/export-public.mjs --to <dir> --public-repo <owner/name> [--dry-run] [--no-local-terms]
// Exit codes: 0 exported, `no changes` or a clean dry run; 1 content check, staged tests or target write failed; 2 usage
// error or unsafe target (also a target that changed during the run, found before the first write). Order: target safety,
// build, content check, staged tests (on a copy), re-check of target and staged bytes, update, commit.
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertStagedUnchanged, buildStaging, checkContent, checkTarget, commitTarget, ExportError, headShortSha, listExportFiles, loadLocalTerms,
  privateSlug, readManifest, resolveHead, runStagedTests, stagedDigests, updateTarget,
} from './lib/export.mjs';
import { BRAND } from '../plugins/methodology/cli/lib/brand.mjs';
import { localDay } from '../plugins/memory-report/lib/policy.mjs';

// The repository this script belongs to, found from the script's own location, never from the working directory.
export const SCRIPT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const USAGE = 'usage: node bin/export-public.mjs --to <dir> --public-repo <owner/name> [--dry-run] [--no-local-terms]';

export const DEPRECATION = 'export-public: deprecated: development moves to the public repository; this export is retired by a follow-up';

const VALUE_FLAGS = { '--to': 'to', '--public-repo': 'publicRepo' };
const BOOLEAN_FLAGS = { '--dry-run': 'dryRun', '--no-local-terms': 'noLocalTerms' };

// { to, publicRepo, dryRun, noLocalTerms } or { error } for an unknown flag, a stray argument, a repeated flag or a missing value.
function parseArgs(argv) {
  const opts = { to: null, publicRepo: null, dryRun: false, noLocalTerms: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const equals = argv[i].startsWith('--') ? argv[i].indexOf('=') : -1;
    const flag = equals === -1 ? argv[i] : argv[i].slice(0, equals);
    if (!Object.hasOwn(VALUE_FLAGS, flag) && !Object.hasOwn(BOOLEAN_FLAGS, flag)) return { error: `unknown argument ${flag}` };
    if (seen.has(flag)) return { error: `${flag} given twice` };
    seen.add(flag);
    if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      if (equals !== -1) return { error: `${flag} takes no value` };
      opts[BOOLEAN_FLAGS[flag]] = true;
      continue;
    }
    const value = equals === -1 ? argv[++i] : argv[i].slice(equals + 1);
    if (value === undefined || value === '' || value.startsWith('--')) return { error: `${flag} needs a value` };
    opts[VALUE_FLAGS[flag]] = value;
  }
  for (const [flag, key] of Object.entries(VALUE_FLAGS)) if (opts[key] === null) return { error: `${flag} is required` };
  return opts;
}

const shellQuote = (text) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

// The lines that tell the user how to restore a target the export touched. The export never runs them.
// An unborn target has nothing to reset to: the first command empties the index (a failed commit leaves the files added),
// then the copied files are deleted.
function restoreLines(dir, unborn, copied) {
  const quoted = shellQuote(dir);
  if (!unborn) return [`the target was modified: ${dir}`, `restore it with: git -C ${quoted} reset --hard && git -C ${quoted} clean -fd`];
  return [
    `the target was modified and has no commit yet: ${dir}`,
    `restore it by emptying its index: git -C ${quoted} rm -r --cached --quiet --ignore-unmatch .`,
    'and then deleting these copied files:',
    ...copied.map((path) => `  ${path}`),
  ];
}

// Whether two identities (as checkTarget returns them) are the same.
const sameSafety = (a, b) => a.unborn === b.unborn && a.identity.author === b.identity.author && a.identity.committer === b.identity.committer;

// Runs the export and returns its exit code. `repoRoot` is the private repository (default: this script's own repository);
// `afterCopy` is passed to updateTarget (a test hook for "a tool wrote a file"). Every git invocation receives `env`.
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, repoRoot = SCRIPT_REPO_ROOT, afterCopy } = {}) {
  const out = (line) => stdout.write(`${line}\n`);
  const err = (line) => stderr.write(`${line}\n`);
  err(DEPRECATION);
  const opts = parseArgs(argv);
  if (opts.error) {
    err(`error: ${opts.error}`);
    err(USAGE);
    return 2;
  }
  const target = resolve(opts.to);
  const tempDirs = [];
  let touched = false;
  let unborn = false;
  let copied = [];
  try {
    const rev = resolveHead(repoRoot, { env });
    const home = env.HOME || homedir();
    const { terms, empty } = loadLocalTerms({ env, home });
    if (empty && !opts.noLocalTerms) {
      throw new ExportError('no local terms are configured (memory-report config, PUBLIC_EXPORT_DENY or the deny file); pass --no-local-terms to export without that check', 2);
    }
    if (empty) err('warning: no local terms are configured, so the local-term check has nothing to look for');

    const slug = privateSlug(repoRoot, { env });
    out(`private slug: ${slug} (from origin)`);
    const safetyOptions = { repoRoot, privateSlug: slug, publicSlug: opts.publicRepo, terms, env, rev };
    const safety = checkTarget(target, safetyOptions);
    unborn = safety.unborn;
    out(`author: ${safety.identity.author}`);
    out(`committer: ${safety.identity.committer}`);

    const manifest = readManifest(repoRoot, { rev, env });
    const files = listExportFiles(repoRoot, manifest, { rev, env });
    const stagingDir = mkdtempSync(join(tmpdir(), 'export-public-staging-'));
    tempDirs.push(stagingDir);
    const tmpHome = mkdtempSync(join(tmpdir(), 'export-public-home-'));
    tempDirs.push(tmpHome);
    const { rewrites } = buildStaging(repoRoot, files, { privateSlug: slug, publicSlug: opts.publicRepo, stagingDir, rev, env });

    // The manifest key allowLegacy (even an empty list) switches the old-name check on: the old brand name, the bare name of the
    // origin's repository and the repository name of BRAND.source (the origin may still carry the legacy slug, so the slug
    // rewrite would not clear it) are then forbidden outside the paths and substrings it allows.
    const legacyTerms = [...new Set([BRAND.legacy.marketplace, slug.split('/')[1], BRAND.source.split('/')[1]])];
    const legacy = Object.hasOwn(manifest, 'allowLegacy') ? { legacyTerms, allowLegacy: manifest.allowLegacy } : {};
    const checkOptions = { terms, home, privateSlug: slug, publicSlug: opts.publicRepo, allowSecrets: manifest.allowSecrets, ...legacy };
    const hits = checkContent(stagingDir, files, checkOptions);
    if (hits.length > 0) {
      err(`content check failed: ${hits.length} hit(s)`);
      for (const hit of hits) err(`${hit.path}:${hit.line} ${hit.category}`);
      return 1;
    }
    const digests = stagedDigests(stagingDir, files);

    // The tests run on a copy: whatever they write stays there, and the target gets the pristine, checked staging directory.
    const testDir = mkdtempSync(join(tmpdir(), 'export-public-tests-'));
    tempDirs.push(testDir);
    cpSync(stagingDir, testDir, { recursive: true });
    const tests = runStagedTests(testDir, { tmpHome, pathEnv: env.PATH });
    if (!tests.ok) {
      err(`staged tests failed: ${tests.summary}`);
      return 1;
    }
    if (opts.dryRun) {
      out(`files: ${files.length}`);
      for (const file of files) out(file.path);
      out(`rewrites: ${rewrites}`);
      out(`tests: ${tests.summary}`);
      return 0;
    }

    // Called by updateTarget after its pre-flight refusals and before its first change: the target and the staged bytes must
    // still be what was checked, else nothing is written (exit 2 for the target, 1 for the bytes).
    const beforeWrite = () => {
      if (!sameSafety(checkTarget(target, safetyOptions), safety)) throw new ExportError('the target changed while the export ran, so nothing was written', 2);
      assertStagedUnchanged(stagingDir, files, checkOptions, digests);
      touched = true;
      copied = files.map((file) => file.path);
    };
    const { unexpected } = updateTarget(target, stagingDir, files, manifest, { env, afterCopy, beforeWrite });
    if (unexpected.length > 0) {
      copied.push(...unexpected);
      throw new ExportError(`the target holds paths the export did not write, so nothing was committed:\n${unexpected.map((path) => `  ${path}`).join('\n')}`, 1);
    }
    const message = `Export ${localDay(Date.now())} from ${headShortSha(repoRoot, { rev, env })}`;
    if (commitTarget(target, message, { env }) === 'no changes') out('no changes');
    else out(`committed: ${message}`);
    return 0;
  } catch (error) {
    err(`error: ${error.message}`);
    if (!touched) return error instanceof ExportError ? error.code : 1;
    for (const line of restoreLines(target, unborn, copied)) err(line);
    return 1;
  } finally {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
