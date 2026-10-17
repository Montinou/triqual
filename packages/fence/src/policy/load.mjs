// Policy loader: read one policy file and refuse anything ambiguous (trusted path).
//
// loadPolicy(path, {mode, fs, home, realpath}) -> {policy, sha}
//   mode      "user" (default) or "locked". Locked mode refuses a policy file, or a parent
//             directory, that the user could write: not owned by root, or group/world-writable.
//   fs        injectable node:fs subset (readFileSync, statSync, realpathSync).
//   home      expands `~` in path globs (default os.homedir()).
//   realpath  resolves each path glob's literal prefix (default fs.realpathSync.native).
// `sha` is the sha256 (hex) of the file's bytes. Every failure throws a PolicyError carrying
// `code`, `pointer` and `path` (the policy file):
//   read      the file can not be read
//   mode      an unknown mode
//   writable  locked mode and the user can write the file or its directory
//   syntax, bom, duplicate-key, forbidden-key, depth   from parseStrictJson (invalid UTF-8 is syntax)
//   type, value, missing-key, unknown-key, duplicate-id, unknown-class, glob   from validatePolicy
//   glob      also: a glob the matcher rejects (a reversed range `[z-a]`), or a path glob that
//             could never match a realpath, so a deny would silently miss: a `.` or `..`
//             segment, an empty segment (`a//b`), a trailing `/`, or a first segment other than
//             empty (absolute), `~`, `${repo}`, `${cwd}` or `**` (a relative glob such as `.env`)
//   value     also: `except.paths` without `match.paths` unless `match.class` lies inside
//             EXCEPT_PATH_CLASSES; `except.domains` without `match.domains` unless `match.class`
//             lies inside EXCEPT_DOMAIN_CLASSES (an except of another kind would excuse effects the
//             rule does not judge)
//
// After validation every path glob (match.paths, except.paths) without `${repo}`/`${cwd}` has
// `~` expanded and its literal prefix realpath-resolved, in place. Globs holding `${repo}` or
// `${cwd}` are kept as written; the evaluator resolves them per call.

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { compileGlob, resolveGlobPrefix } from '../match/glob.mjs';
import { exceptKindAllowed } from './classes.mjs';
import { PolicyError } from './errors.mjs';
import { parseStrictJson } from './parse.mjs';
import { validatePolicy } from './schema.mjs';

const PER_CALL_PLACEHOLDER = /\$\{(?:repo|cwd)\}/;
// Stand-in placeholder values used only to compile-check globs at load.
const CHECK_VALUE = '/fence-placeholder';

const token = (key) => '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');

function realpathOf(fs, realpath) {
  if (typeof realpath === 'function') return realpath;
  const rp = fs.realpathSync;
  if (typeof rp?.native === 'function') return rp.native;
  if (typeof rp === 'function') return rp;
  return nodeFs.realpathSync.native;
}

// The user can write a file or directory it owns (it can chmod it) or one that is group- or
// world-writable.
function userWritable(st) {
  return st.uid !== 0 || (st.mode & 0o022) !== 0;
}

function checkLocked(file, fs) {
  const resolve = realpathOf(fs);
  const real = resolve(file);
  const st = fs.statSync(real);
  if (typeof st.isFile === 'function' && !st.isFile()) {
    throw new PolicyError('read', `policy ${file} is not a regular file`);
  }
  if (userWritable(st)) {
    throw new PolicyError('writable', `locked mode refuses policy ${file}: it is not root-owned or is group/world-writable`);
  }
  const dir = nodePath.dirname(real);
  if (userWritable(fs.statSync(dir))) {
    throw new PolicyError('writable', `locked mode refuses policy ${file}: its directory ${dir} is not root-owned or is group/world-writable`);
  }
  return real;
}

const PATH_GLOB_STARTS = ['', '~', '${repo}', '${cwd}', '**'];

// Why a path glob could never match a realpath, or null.
function unmatchablePathGlob(glob) {
  const segs = glob.split('/');
  if (segs.some((seg) => seg === '.' || seg === '..')) return 'has a "." or ".." segment';
  if (!PATH_GLOB_STARTS.includes(segs[0])) return 'is relative (start it with /, ~, ${repo}, ${cwd} or **)';
  if (glob.endsWith('/')) return 'ends with "/"';
  if (glob.includes('//')) return 'has an empty segment ("//")';
  return null;
}

function checkGlobText(glob, pointer, home, isPath) {
  const why = isPath ? unmatchablePathGlob(glob) : null;
  if (why) {
    throw new PolicyError('glob', `glob ${JSON.stringify(glob)} ${why}, so it never matches a realpath, at ${JSON.stringify(pointer)}`, { pointer });
  }
  try {
    compileGlob(glob, { home, repo: CHECK_VALUE, cwd: CHECK_VALUE });
  } catch (err) {
    throw new PolicyError('glob', `${err.message} at ${JSON.stringify(pointer)}`, { pointer });
  }
}

function prepareGlobs(policy, home, realpath) {
  policy.rules.forEach((rule, i) => {
    for (const kind of ['paths', 'domains']) {
      if (rule.except?.[kind] && !exceptKindAllowed(rule.match, kind)) {
        const pointer = `/rules/${i}/except/${kind}`;
        const classes = kind === 'paths' ? 'delete, overwrite, perm-change' : 'network-fetch';
        throw new PolicyError(
          'value',
          `except.${kind} needs match.${kind}, or a match.class list within ${classes}, at ${JSON.stringify(pointer)}`,
          { pointer },
        );
      }
    }
    for (const section of ['match', 'except']) {
      const block = rule[section];
      if (!block) continue;
      for (const key of ['paths', 'mcp', 'domains']) {
        if (!block[key]) continue;
        const isPath = key === 'paths';
        block[key] = block[key].map((glob, j) => {
          const pointer = `/rules/${i}` + token(section) + token(key) + token(j);
          checkGlobText(glob, pointer, home, isPath);
          if (!isPath || PER_CALL_PLACEHOLDER.test(glob)) return glob;
          return resolveGlobPrefix(glob, { home }, realpath);
        });
      }
    }
  });
  return policy;
}

export function loadPolicy(file, { mode = 'user', fs = nodeFs, home = os.homedir(), realpath } = {}) {
  try {
    if (mode !== 'user' && mode !== 'locked') {
      throw new PolicyError('mode', `unknown policy mode ${JSON.stringify(mode)} (expected user or locked)`);
    }
    let source = file;
    let bytes;
    try {
      if (mode === 'locked') source = checkLocked(file, fs);
      bytes = fs.readFileSync(source);
    } catch (err) {
      if (err instanceof PolicyError) throw err;
      throw new PolicyError('read', `can not read policy ${file}: ${err?.code ?? err?.message ?? err}`);
    }
    if (typeof bytes === 'string') bytes = Buffer.from(bytes, 'utf8');
    const sha = createHash('sha256').update(bytes).digest('hex');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new PolicyError('syntax', 'policy file is not valid UTF-8');
    }
    const policy = validatePolicy(parseStrictJson(text));
    prepareGlobs(policy, home, realpathOf(fs, realpath));
    return { policy, sha };
  } catch (err) {
    if (err instanceof PolicyError) {
      err.path = file;
      throw err;
    }
    throw new PolicyError('read', `can not load policy ${file}: ${err?.message ?? err}`, { path: file });
  }
}
