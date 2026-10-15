// `triqual upstream-diff` (spec Addendum E.6): what changed upstream in the forked skills since a superpowers release —
// by default since upstream.json's `reviewed.version` — as a per-skill stat summary, the full diff (`--full`), or a
// patch whose paths are mapped to the fork's names, ready for `git apply --3way` from the clone's root (`--patch`).
// `--mark-reviewed "<summary>"` then moves `reviewed` to the version, with the release's skills files and their
// sha256 (`reviewed.files`, what test/fork.test.mjs checks the fork against), and appends a line to FORK.md's review log.
//
// It works on the fork in the cwd's clone: the git toplevel of the cwd must hold plugins/methodology/upstream.json.
// The installed plugin root is never read or written. The rename map (directory and file renames) and the derived
// templates come from FORK.md. Releases are fetched as tarballs from codeload (no token) and extracted with `tar`.
// Exit codes: 0 ok (and --help), 1 a network or tool failure, 2 an unknown version or skill, a cwd outside a clone
// of the fork, a refused --mark-reviewed, or a usage error (`--full` with `--patch` among them).
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { sha256, writeAtomic } from './lib/fsx.mjs';

const NAME = 'triqual upstream-diff';
const FORK_DIR = 'plugins/methodology';
const NOT_A_CLONE = `run ${NAME} from a clone of triqual (the git toplevel of the cwd must hold `
  + `${FORK_DIR}/upstream.json)`;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ZERO = '0'.repeat(40);

export const USAGE = `usage: triqual upstream-diff <version> [--from <v>] [--skill <name>] [--full | --patch] [--mark-reviewed "<summary>"]
  Shows what superpowers <version> changed in the forked skills since --from (default: upstream.json's
  reviewed.version), run from a clone of triqual.
  --from <v>                    compare from this release instead of the reviewed one
  --skill <name>                one forked skill (fork or upstream name)
  --full                        print the full upstream diff instead of the stat summary
  --patch                       print the upstream patch with paths mapped to the fork's names, for git apply --3way
  --mark-reviewed "<summary>"   after the diff, set upstream.json's reviewed to <version> and log it in FORK.md
  -h, --help                    print this help`;

export const tarballUrl = (version) => `https://codeload.github.com/obra/superpowers/tar.gz/refs/tags/v${version}`;

// The commit id in a tar.gz's pax global header (`comment=<sha>`, as git archive and codeload write it), or null.
export function paxCommit(buffer) {
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch {
    return null;
  }
  if (tar.length < 512 || String.fromCharCode(tar[156]) !== 'g') return null;
  const size = parseInt(tar.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim(), 8);
  if (!Number.isInteger(size) || size <= 0) return null;
  const records = tar.subarray(512, 512 + size).toString('utf8');
  const m = /(?:^|\n)\d+ comment=([0-9a-f]{40})\n/.exec(records);
  return m ? m[1] : null;
}

// Fetches a release tarball: { buffer, commit }, null when the tag does not exist (404); throws on anything else.
export async function fetchRelease(version) {
  const res = await fetch(tarballUrl(version));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${tarballUrl(version)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, commit: paxCommit(buffer) };
}

// git without GIT_* from the environment: a hook run exports GIT_DIR and friends, which would redirect the calls
// away from the cwd's clone.
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(cwd, args, opts = {}) {
  return spawnSync('git', args, { cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024, ...opts });
}

class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const oneLine = (text) => String(text).split('\n')[0].trim();

const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return Math.sign(pa[i] - pb[i]);
  return 0;
};

// FORK.md's Renames (`old` → `new`, a trailing `/` for a directory) and Derived (`fork path` ← `upstream source`),
// with the same entry format test/fork.test.mjs reads; `hasReviewLog` when Review log is the last section.
export function parseFork(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
  }
  const entries = (name, re) => (sections.get(name) ?? []).map((line) => re.exec(line)).filter(Boolean);
  return {
    renames: entries('Renames', /^- `([^`]+)` → `([^`]+)`\s*(?:—|:)\s*\S/).map((m) => ({ from: m[1], to: m[2] })),
    derived: entries('Derived', /^- `([^`]+)` ← `([^`]+)`\s*(?:—|:)\s*\S/).map((m) => ({ path: m[1], source: m[2] })),
    hasReviewLog: [...sections.keys()].at(-1) === 'Review log',
  };
}

// An upstream path (relative to skills/) under its fork name; a file entry beats a directory entry.
export function mapPath(renames, path) {
  const file = renames.find((r) => !r.from.endsWith('/') && r.from === path);
  if (file) return file.to;
  const dir = renames
    .filter((r) => r.from.endsWith('/') && path.startsWith(r.from))
    .sort((a, b) => b.from.length - a.from.length)[0];
  return dir ? dir.to + path.slice(dir.from.length) : path;
}

const skillOf = (path) => path.split('/')[0];

// The clone's toplevel, or a Failure(2) when the cwd is not in a clone of the fork.
function resolveClone(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Failure(2, NOT_A_CLONE);
  const top = r.stdout.trim();
  if (!top || !existsSync(join(top, FORK_DIR, 'upstream.json'))) throw new Failure(2, NOT_A_CLONE);
  return top;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Failure(1, `cannot read ${path}: ${err.message}`);
  }
}

// Every file under dir, relative, sorted.
function walk(dir) {
  const out = [];
  const rec = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(d, e.name), rel);
      else if (e.isFile() || e.isSymbolicLink()) out.push(rel);
    }
  };
  if (existsSync(dir)) rec(dir, '');
  return out.sort();
}

async function fetchVersion(fetchTarball, version) {
  if (!VERSION_RE.test(version)) throw new Failure(2, `unknown superpowers version ${version}`);
  let release;
  try {
    release = await fetchTarball(version);
  } catch (err) {
    throw new Failure(1, `cannot fetch superpowers ${version}: ${oneLine(err?.message ?? err)}`);
  }
  if (!release) throw new Failure(2, `unknown superpowers version ${version}`);
  return release;
}

// Extracts a release tarball's skills/ into <dir>/skills (the tarball's top directory is stripped).
function extract(buffer, dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', '-', '-C', dir, '--strip-components=1'], { input: buffer, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Failure(1, `cannot extract the tarball: ${oneLine(r.error?.message ?? r.stderr?.toString() ?? 'tar failed')}`);
  }
  mkdirSync(join(dir, 'skills'), { recursive: true });
}

const sameFile = (a, b) => {
  const sa = statSync(a);
  const sb = statSync(b);
  return (sa.mode & 0o111) === (sb.mode & 0o111) && readFileSync(a).equals(readFileSync(b));
};

// `git diff --no-index` of one upstream file between the two extracted trees (either side may be missing). git
// exits 1 for "differences": that is not a failure.
function fileDiff(work, path, { fromExists, toExists, patch }) {
  const a = fromExists ? `from/skills/${path}` : '/dev/null';
  const b = toExists ? `to/skills/${path}` : '/dev/null';
  const flags = ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-renames', '--src-prefix=a/',
    '--dst-prefix=b/', ...(patch ? ['--full-index', '--binary'] : [])];
  const r = git(work, [...flags, '--', a, b], { encoding: 'utf8' });
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw new Failure(1, `git diff failed for ${path}: ${oneLine(r.error?.message ?? r.stderr)}`);
  }
  return r.stdout;
}

// A path git would quote in a diff header (control, non-ASCII, space, `"` or `\\`): headers are rewritten unquoted,
// so such a path is refused instead of emitted wrong.
const needsQuoting = (path) => /[^\x21-\x7e]|["\\]/.test(path);

// The diff with its header paths set to `target` (its body unchanged).
function retarget(text, target, { fromExists, toExists }) {
  const lines = text.split('\n');
  let inHeader = true;
  return lines.map((line) => {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      return `diff --git a/${target} b/${target}`;
    }
    if (!inHeader) return line;
    if (line.startsWith('@@') || line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      inHeader = false;
      return line.startsWith('Binary files ') ? `Binary files a/${target} and b/${target} differ` : line;
    }
    if (line.startsWith('--- ')) return fromExists ? `--- a/${target}` : '--- /dev/null';
    if (line.startsWith('+++ ')) return toExists ? `+++ b/${target}` : '+++ /dev/null';
    return line;
  }).join('\n');
}

function countLines(text) {
  let added = 0;
  let removed = 0;
  let body = false;
  let binary = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) body = true;
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true;
    else if (body && line.startsWith('+')) added++;
    else if (body && line.startsWith('-')) removed++;
  }
  return binary ? 'binary' : `+${added} -${removed}`;
}

// Writes the from-version blobs into the clone's object store (objects only) and checks each id against the
// patch's `index` line, so a three-way apply always finds its base.
function writeBlobs(top, work, entries) {
  const withBase = entries.filter((e) => e.fromExists);
  if (withBase.length === 0) return;
  const r = git(top, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
    input: withBase.map((e) => join(work, 'from', 'skills', e.path)).join('\n') + '\n', encoding: 'utf8',
  });
  if (r.error || r.status !== 0) throw new Failure(1, `git hash-object failed: ${oneLine(r.error?.message ?? r.stderr)}`);
  const ids = r.stdout.trim().split('\n');
  withBase.forEach((e, i) => {
    const m = /^index ([0-9a-f]{40})\.\./m.exec(e.diff);
    if (m && m[1] !== ZERO && m[1] !== ids[i]) {
      throw new Failure(1, `blob id mismatch for skills/${e.path}: patch ${m[1]}, written ${ids[i]}`);
    }
  });
}

function refuseQuoting(path) {
  if (needsQuoting(path)) throw new Failure(1, `cannot write a diff header for ${path}: the path needs quoting`);
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// writeFile is the atomic writer for --mark-reviewed; injectable so the double-failure path can be tested.
export async function upstreamDiff({
  version, from = null, skill = null, mode = 'stat', markReviewed = null, cwd, fetchTarball = fetchRelease,
  now = new Date(), tmp = tmpdir(), writeFile = writeAtomic,
}) {
  const out = [];
  const err = [];
  let work = null;
  try {
    if (!['stat', 'full', 'patch'].includes(mode)) throw new Failure(2, `unknown mode ${mode}`);
    const top = resolveClone(cwd);
    const pluginDir = join(top, FORK_DIR);
    const upstreamPath = join(pluginDir, 'upstream.json');
    const forkPath = join(pluginDir, 'FORK.md');
    const upstreamText = readText(upstreamPath);
    let upstream;
    try {
      upstream = JSON.parse(upstreamText);
    } catch (e) {
      throw new Failure(1, `cannot parse ${upstreamPath}: ${e.message}`);
    }
    const reviewed = upstream?.reviewed?.version;
    if (typeof reviewed !== 'string' || !VERSION_RE.test(reviewed)) {
      throw new Failure(1, `${upstreamPath} has no valid reviewed.version`);
    }
    const forkText = readText(forkPath);
    const fork = parseFork(forkText);
    const fromVersion = from ?? reviewed;
    if (!VERSION_RE.test(version)) throw new Failure(2, `unknown superpowers version ${version}`);
    if (!VERSION_RE.test(fromVersion)) throw new Failure(2, `unknown superpowers version ${fromVersion}`);

    // --mark-reviewed refusals that need no fetch; nothing is written on any refusal.
    if (markReviewed !== null) {
      const summary = String(markReviewed).trim();
      if (summary === '' || /[\r\n]/.test(summary)) throw new Failure(2, '--mark-reviewed needs a one-line summary');
      if (skill !== null) throw new Failure(2, '--mark-reviewed refused with --skill: a review covers every skill');
      if (compareVersions(version, reviewed) < 0) {
        throw new Failure(2, `--mark-reviewed refused: ${version} is older than the reviewed ${reviewed}`);
      }
      if (compareVersions(fromVersion, reviewed) > 0) {
        throw new Failure(2, `--mark-reviewed refused: --from ${fromVersion} is newer than the reviewed ${reviewed}, `
          + 'which would skip unreviewed releases');
      }
      if (!fork.hasReviewLog) throw new Failure(1, `${forkPath} does not end with its Review log section`);
    }

    const skillsDir = join(pluginDir, 'skills');
    const forkSkills = new Set(readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
    let onlySkill = null;
    if (skill !== null) {
      onlySkill = forkSkills.has(skill) ? skill : skillOf(mapPath(fork.renames, `${skill}/`));
      if (!forkSkills.has(onlySkill)) throw new Failure(2, `unknown skill ${skill}`);
    }

    const toRelease = await fetchVersion(fetchTarball, version);
    const fromRelease = await fetchVersion(fetchTarball, fromVersion);
    if (markReviewed !== null && !/^[0-9a-f]{40}$/.test(toRelease.commit ?? '')) {
      throw new Failure(1, `no commit id in the superpowers ${version} tarball`);
    }
    work = mkdtempSync(join(tmp, 'triqual-upstream-diff-'));
    extract(fromRelease.buffer, join(work, 'from'));
    extract(toRelease.buffer, join(work, 'to'));

    const vendoredFiles = new Set(Object.keys(upstream?.vendored?.files ?? {}));
    const vendoredSkills = new Set([...vendoredFiles].map(skillOf));
    const fromFiles = new Set(walk(join(work, 'from', 'skills')));
    const toFiles = new Set(walk(join(work, 'to', 'skills')));
    const newSkills = new Set();
    const entries = [];
    for (const path of [...new Set([...fromFiles, ...toFiles])].sort()) {
      const fromExists = fromFiles.has(path);
      const toExists = toFiles.has(path);
      if (fromExists && toExists
        && sameFile(join(work, 'from', 'skills', path), join(work, 'to', 'skills', path))) continue;
      const target = mapPath(fork.renames, path);
      const forkSkill = skillOf(target);
      if (!forkSkills.has(forkSkill) && !vendoredSkills.has(skillOf(path))) {
        newSkills.add(skillOf(path));
        continue;
      }
      const derived = fromExists && toExists
        ? fork.derived.filter((d) => d.source === path && existsSync(join(skillsDir, d.path))).map((d) => d.path)
        : [];
      if (onlySkill !== null && forkSkill !== onlySkill && !derived.some((d) => skillOf(d) === onlySkill)) continue;
      // A from-version file with no fork counterpart: removed in the fork when it was vendored, otherwise one the
      // fork never took (added upstream after the vendored release). Either way the patch cannot apply to it.
      // A new upstream file under a vendored skill the fork removed as a whole has nowhere to land either.
      const absent = fromExists && !existsSync(join(skillsDir, target));
      let missing = absent ? (vendoredFiles.has(path) ? 'removed in the fork' : 'not in the fork') : null;
      if (!fromExists && !forkSkills.has(forkSkill)) missing = 'skill removed in the fork';
      // An upstream deletion of a file the fork adapted: git apply --3way cannot merge a deletion and would abort the
      // whole patch, so it is left out for a review by hand.
      const adapted = fromExists && !toExists && !absent
        && !readFileSync(join(skillsDir, target)).equals(readFileSync(join(work, 'from', 'skills', path)));
      entries.push({ path, target, forkSkill, fromExists, toExists, derived, missing, adapted });
    }
    if (onlySkill === null) {
      for (const name of [...newSkills].sort()) err.push(`new upstream skill ${name} (no fork counterpart): left out`);
    }

    out.push(`superpowers ${fromVersion} → ${version}`);
    for (const e of entries) e.diff = fileDiff(work, e.path, { ...e, patch: mode === 'patch' });

    if (mode === 'stat') {
      if (entries.length === 0) out.push('no upstream changes in the forked skills');
      let current = null;
      for (const e of [...entries].sort((a, b) => a.forkSkill.localeCompare(b.forkSkill) || a.path.localeCompare(b.path))) {
        if (e.forkSkill !== current) {
          current = e.forkSkill;
          const upstreamSkill = skillOf(e.path);
          out.push(upstreamSkill === e.forkSkill ? e.forkSkill : `${e.forkSkill}  (upstream ${upstreamSkill})`);
        }
        const notes = [];
        if (!e.fromExists) notes.push('new upstream');
        else if (!e.toExists) notes.push('deleted upstream');
        if (e.missing) notes.push(e.missing);
        for (const d of e.derived) notes.push(`also reaches ${d}`);
        const rel = e.target.slice(e.forkSkill.length + 1);
        out.push(`  ${rel}  ${countLines(e.diff)}${notes.length ? `  (${notes.join('; ')})` : ''}`);
      }
      const skills = new Set(entries.map((e) => e.forkSkill)).size;
      if (entries.length > 0) out.push(`${entries.length} file(s) changed in ${skills} forked skill(s)`);
    } else if (mode === 'full') {
      for (const e of entries) refuseQuoting(`skills/${e.path}`);
      for (const e of entries) out.push(retarget(e.diff, `skills/${e.path}`, e).replace(/\n$/, ''));
    } else {
      const kept = [];
      for (const e of entries) {
        if (e.missing) err.push(`left out of the patch: skills/${e.path} (${e.missing})`);
        else if (e.adapted) {
          err.push(`deleted upstream but adapted in the fork: ${FORK_DIR}/skills/${e.target} — review by hand`);
        } else kept.push(e);
      }
      for (const e of kept) for (const target of [e.target, ...e.derived]) refuseQuoting(`${FORK_DIR}/skills/${target}`);
      writeBlobs(top, work, kept);
      out.length = 0; // the patch alone on stdout, so it pipes straight into git apply
      for (const e of kept) {
        for (const target of [e.target, ...e.derived]) {
          out.push(retarget(e.diff, `${FORK_DIR}/skills/${target}`, e).replace(/\n$/, ''));
        }
      }
    }

    if (markReviewed !== null) {
      const summary = String(markReviewed).trim();
      const date = localDate(now);
      // reviewed.files: the reviewed release's skills tree (path → sha256), the baseline of the fork checks (E.2).
      const toDir = join(work, 'to', 'skills');
      const files = Object.fromEntries([...toFiles].sort().map((path) => [path, sha256(readFileSync(join(toDir, path)))]));
      const next = { ...upstream, reviewed: { version, commit: toRelease.commit, reviewedAt: date, files } };
      const nextFork = `${forkText.replace(/\n*$/, '\n')}${date} ${version} ${summary}\n`;
      writeFile(upstreamPath, JSON.stringify(next, null, 2) + '\n');
      try {
        writeFile(forkPath, nextFork);
      } catch (e) {
        try {
          writeFile(upstreamPath, upstreamText);
        } catch (restoreErr) {
          throw new Failure(1, `cannot write ${forkPath}: ${oneLine(e.message)}; restoring upstream.json also failed: `
            + `${oneLine(restoreErr.message)} — upstream.json now holds reviewed ${version} (${toRelease.commit}) but `
            + "FORK.md's review log has no line for it: fix both by hand");
        }
        throw new Failure(1, `cannot write ${forkPath}: ${oneLine(e.message)} (upstream.json restored)`);
      }
      const line = `reviewed: ${version} (${toRelease.commit}), logged in FORK.md`;
      if (mode === 'patch') err.push(line);
      else out.push(line);
    }
    return { code: 0, out: out.length ? `${out.join('\n')}\n` : '', err: err.length ? `${err.join('\n')}\n` : '' };
  } catch (e) {
    if (!(e instanceof Failure)) e = new Failure(1, oneLine(e?.message ?? e));
    return { code: e.code, out: '', err: `${[...err, `${NAME}: ${e.message}`].join('\n')}\n` };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

// Parses the CLI arguments and runs; returns { code, out, err }. deps: { cwd, fetchTarball, now, tmp }.
export async function run(argv, deps = {}) {
  const usageError = (message) => ({ code: 2, out: '', err: `${NAME}: ${message}\n${USAGE}\n` });
  if (argv.includes('-h') || argv.includes('--help')) return { code: 0, out: `${USAGE}\n`, err: '' };
  const opts = { from: null, skill: null, markReviewed: null };
  const positional = [];
  let full = false;
  let patch = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(arg);
    const flag = eq ? eq[1] : arg;
    const valued = { '--from': 'from', '--skill': 'skill', '--mark-reviewed': 'markReviewed' }[flag];
    if (valued) {
      const value = eq ? eq[2] : argv[++i];
      if (value === undefined) return usageError(`${flag} needs a value`);
      opts[valued] = value;
    } else if (flag === '--full' && !eq) full = true;
    else if (flag === '--patch' && !eq) patch = true;
    else if (arg.startsWith('-')) return usageError(`unknown argument ${arg}`);
    else positional.push(arg);
  }
  if (full && patch) return usageError('--full and --patch are exclusive');
  if (positional.length !== 1) return usageError(positional.length ? `unexpected argument ${positional[1]}` : 'missing <version>');
  return upstreamDiff({
    version: positional[0], ...opts, mode: full ? 'full' : patch ? 'patch' : 'stat', cwd: deps.cwd ?? process.cwd(),
    ...(deps.fetchTarball ? { fetchTarball: deps.fetchTarball } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.tmp ? { tmp: deps.tmp } : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const r = await run(process.argv.slice(2));
  process.stdout.write(r.out);
  process.stderr.write(r.err);
  process.exitCode = r.code;
}
