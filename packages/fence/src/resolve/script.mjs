// Files a command runs (spec, "Normalizer": Files a command runs). Pure helpers the normalizer
// uses to find the file behind a command and read it, bounded:
//
//   readScript(path, cap = SCRIPT_CAP, fs) -> {text, shebang} | null
//   shebangShell(shebang)                  -> {shell, kind} | null   (sh, bash, dash, zsh only)
//   readPackageScripts(path, fs)           -> {name: script string} | null
//   scriptRoute(argv, shellKind)           -> route | null
//
// Routes (argv is the command after wrapper unwrapping; words are strings or UNKNOWN):
//   {type:'shell', by:'path'|'shell'|'source', file, kind}
//       `./x` (any command word with a slash), `sh|bash|zsh|dash|ksh x`, `source x` / `. x`. kind is
//       the shell that reads the file (for `./x` the shebang decides, in the normalizer). `bare`:
//       a source/shell operand without a slash (a PATH search may pick another file).
//   {type:'package', program, sub, base, unresolved, names, main, args, lifecycle, start}
//       `npm run <x>`, `npm test|start|stop|restart`, `yarn <x>`, `pnpm <x>`: names are the scripts
//       run (pre<x>, <x>, post<x>); args the words appended to <x>. lifecycle: an install that runs
//       the package's own preinstall/install/postinstall/prepare. base: a --prefix/-C/--dir/--cwd
//       word. unresolved: a workspace/recursive/filter flag, another script shell, or a flag fence
//       does not know before the sub-command: which package.json is read is not known.
//   {type:'make', files, dirs, unresolved}
//       make/gmake: -f files and -C directories (words), unresolved on an UNKNOWN word.
//   {type:'code', files, modules, isolated}
//       make-free runners of repository code: python <file> / -m <module>, pytest <file>, node
//       <file> (and -r/--import files), deno run <file>, go run <file.go>, cargo run, npx, and a
//       foreign shell (fish, csh, ...) given a script file. files are the named files (node: with
//       the extensions node tries), modules python -m names (looked for in the cwd unless
//       `isolated`: -I or -P keep the cwd off sys.path).
//
// A route may carry `opaque: {reason, construct}` when fence cannot follow it: a file operand or
// command word naming stdin (`stdin-interpreter`, a shell's own stdin operand is unwrap.mjs's), make
// with an inline makefile, --eval/-E or a SHELL/.SHELLFLAGS/MAKEFLAGS override (`makefile-inline`),
// an unknown option before a `run` script name (`package-option`), node with a URL preload or an
// option fence does not know before the file (`node-flag`).
//
// Only files a route names are checked against the written-files index: a directory a runner
// walks (pytest with no file, go run ., cargo run) is runs-repo-code alone.
// Nothing here throws (an internal error is null).

import nodeFs from 'node:fs';

import { UNKNOWN } from '../norm/unknown.mjs';
import { shellScriptFile, shellKind, appletArgv, stdinPath } from '../norm/unwrap.mjs';

/** Largest script file read (the normalizer's per-level command cap). */
export const SCRIPT_CAP = 32 * 1024;
/** Largest package.json read. */
export const PACKAGE_CAP = 1024 * 1024;
/** The package.json scripts an install runs from the package itself. */
export const LIFECYCLE_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepare']);

const isStr = (w) => typeof w === 'string';
const words = (s) => s.split(/\s+/).filter(Boolean);
const baseName = (w) => w.slice(w.lastIndexOf('/') + 1);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The text of a regular file of at most `cap` bytes, valid UTF-8 with no NUL, and its shebang line
 * (without `#!`, trimmed; null when there is none), or null.
 */
export function readScript(path, cap = SCRIPT_CAP, fsImpl = nodeFs) {
  try {
    if (!isStr(path) || !path.startsWith('/') || path.includes('\0')) return null;
    const st = fsImpl.statSync(path);
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) return null;
    if (typeof st.size !== 'number' || st.size > cap) return null;
    const data = fsImpl.readFileSync(path);
    const bytes = isStr(data) ? Buffer.from(data, 'utf8') : Buffer.from(data);
    if (bytes.length > cap || bytes.includes(0)) return null;
    const text = UTF8.decode(bytes);
    let shebang = null;
    if (text.startsWith('#!')) {
      const nl = text.indexOf('\n');
      shebang = (nl < 0 ? text.slice(2) : text.slice(2, nl)).replace(/\r$/, '').trim();
    }
    return { text, shebang };
  } catch {
    return null;
  }
}

const SHEBANG_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh']);
// Shell options in a shebang that read code or files, or change how words become assignments.
const SHEBANG_BAD_FLAG = /[csoOilk]/;

/**
 * The shell a shebang line names: `/bin/sh`, `/bin/bash -e`, `/usr/bin/env zsh`. Only sh, bash,
 * dash and zsh, an absolute interpreter path, at most one plain flag cluster that loads nothing.
 */
export function shebangShell(shebang) {
  if (!isStr(shebang)) return null;
  const parts = shebang.split(/[ \t]+/).filter(Boolean);
  if (parts.length === 0 || !parts[0].startsWith('/')) return null;
  let base = baseName(parts[0]);
  let rest = parts.slice(1);
  if (base === 'env') {
    if (rest.length === 0 || rest[0].startsWith('-') || rest[0].includes('=')) return null;
    base = baseName(rest[0]);
    rest = rest.slice(1);
  }
  if (!SHEBANG_SHELLS.has(base)) return null;
  if (rest.length > 1) return null;
  if (rest.length === 1 && (!/^[-+][A-Za-z]+$/.test(rest[0]) || SHEBANG_BAD_FLAG.test(rest[0].slice(1)))) return null;
  return { shell: base, kind: shellKind(base) };
}

/** The `scripts` of a package.json (strings only), {} when it has none, null when unreadable. */
export function readPackageScripts(path, fsImpl = nodeFs) {
  const r = readScript(path, PACKAGE_CAP, fsImpl);
  if (r === null) return null;
  try {
    const pj = JSON.parse(r.text);
    if (pj === null || typeof pj !== 'object' || Array.isArray(pj)) return null;
    const out = {};
    const s = pj.scripts;
    if (s === undefined) return out;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return null;
    for (const k of Object.keys(s)) if (isStr(s[k])) Object.defineProperty(out, k, { value: s[k], enumerable: true });
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Package managers

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_TEST = new Set(['test', 't', 'tst']);
const NPM_LIFECYCLE = new Set(
  words('i in ins inst insta instal install isnt isnta isntal isntall add ci clean-install ic install-clean cit install-ci-test it install-test rebuild rb update up upgrade udpate'),
);
const NPM_INSTALL_TEST = new Set(['cit', 'install-ci-test', 'it', 'install-test']);
const YARN_LIFECYCLE = new Set(words('install add upgrade up import'));
const YARN_BUILTIN = new Set(
  words(
    'add audit autoclean bin cache check config create dlx exec generate-lock-entry global help import info init install licenses link list login logout node outdated owner pack plugin policies publish rebuild remove search set tag team unlink unplug upgrade upgrade-interactive up version versions why workspace workspaces constraints dedupe explain npm patch patch-commit stage',
  ),
);
const PNPM_LIFECYCLE = new Set(words('install i add update up upgrade rebuild rb import install-test it dedupe'));
const PNPM_BUILTIN = new Set(
  words(
    'add install i update up upgrade remove rm un uninstall link ln unlink import rebuild rb prune fetch install-test it patch patch-commit patch-remove audit list ls outdated why licenses exec dlx create init publish pack recursive server store root bin env setup config get set deploy doctor help cat-file cat-index find-hash self-update sbom dedupe',
  ),
);
// Global options that take a separate value.
const PM_VALUE = new Set(
  words('--prefix -C --dir --cwd -w --workspace --filter -F --loglevel --registry --userconfig --globalconfig --cache --tag --otp --scope --omit --include --script-shell --node-options --reporter --config --modules-folder --mutex --network-timeout'),
);
// Options after which the package.json read is another one (or the scripts run another way).
const PM_UNRESOLVED = new Set(
  words('-w --workspace --workspaces -ws --filter -F -r --recursive --script-shell --node-options --userconfig --globalconfig -g --global --workspace-root --include-workspace-root --config'),
);
// Options that take no value.
const PM_BOOLEAN = new Set(
  words(
    '-s --silent -q --quiet -d -dd -ddd --verbose --if-present -y --yes --foreground-scripts --ignore-scripts --json --parseable --color --frozen-lockfile --prefer-offline --offline --production --dev -D -E -P -O --save-dev --save-exact --save-prod --save-optional --legacy-peer-deps --force -f --immutable --pure-lockfile --stream --parallel --no-bail --strict-peer-dependencies --save --no-save',
  ),
);
const BASE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd']);
const SPECIAL = { start: ['start'], stop: ['stop'], restart: ['restart', 'stop', 'start'] };

function prePost(name) {
  return [`pre${name}`, name, `post${name}`];
}

function packageRoute(program, argv) {
  let base;
  let unresolved = false;
  let sub = null;
  let i = 1;
  // global options before the sub-command
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      unresolved = true;
      break;
    }
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (PM_UNRESOLVED.has(flag)) unresolved = true;
    if (BASE_FLAGS.has(flag)) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
      if (!isStr(v) || base !== undefined) unresolved = true;
      else base = v;
      continue;
    }
    if (PM_VALUE.has(flag)) {
      if (eq < 0 || !a.startsWith('--')) i++;
      continue;
    }
    if (a.startsWith('--no-') || PM_BOOLEAN.has(flag) || (a.startsWith('--') && eq > 0)) continue;
    unresolved = true; // an option fence does not know may take the sub-command as its value
  }
  if (i < argv.length) sub = argv[i];
  const rest = argv.slice(i + 1);
  // any later workspace/recursive flag also moves the package
  for (const a of rest) {
    if (!isStr(a)) continue;
    if (a === '--') break;
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (PM_UNRESOLVED.has(flag)) unresolved = true;
    if (BASE_FLAGS.has(flag)) unresolved = true;
  }
  const route = { type: 'package', program, sub, base, unresolved, names: [], main: null, args: [], lifecycle: false, start: false };
  if (sub === UNKNOWN || (!isStr(sub) && sub !== null)) {
    route.unresolved = true;
    return route;
  }
  const withMain = (name, after) => {
    route.main = name;
    route.names = prePost(name);
    route.args = scriptArgs(program, after);
  };
  if (program === 'npm') {
    if (sub === null) return null; // npm alone prints help
    if (NPM_RUN.has(sub)) runScript(route, rest, withMain);
    else if (NPM_TEST.has(sub)) withMain('test', rest);
    else if (Object.hasOwn(SPECIAL, sub)) {
      withMain(sub, rest);
      route.names = SPECIAL[sub].flatMap(prePost);
      route.start = sub === 'start' || sub === 'restart';
    }
    if (NPM_LIFECYCLE.has(sub)) route.lifecycle = true;
    if (NPM_INSTALL_TEST.has(sub)) withMain('test', []);
    return route.lifecycle || route.names.length > 0 || route.unresolved || route.opaque || NPM_RUN.has(sub) ? route : null;
  }
  if (program === 'yarn') {
    if (sub === null || YARN_LIFECYCLE.has(sub)) {
      route.lifecycle = true;
      return route;
    }
    if (sub === 'run') {
      runScript(route, rest, withMain);
      return route;
    }
    if (sub === 'exec' || sub === 'node') return route; // repository code, no script
    if (YARN_BUILTIN.has(sub)) return null;
    withMain(sub, rest);
    return route;
  }
  // pnpm
  if (sub === null) return null;
  if (PNPM_LIFECYCLE.has(sub)) route.lifecycle = true;
  if (sub === 'install-test' || sub === 'it') withMain('test', []);
  if (route.lifecycle) return route;
  if (sub === 'run' || sub === 'run-script') {
    runScript(route, rest, withMain);
    return route;
  }
  if (NPM_TEST.has(sub)) {
    withMain('test', rest);
    return route;
  }
  if (Object.hasOwn(SPECIAL, sub)) {
    withMain(sub, rest);
    route.names = SPECIAL[sub].flatMap(prePost);
    route.start = sub === 'start' || sub === 'restart';
    return route;
  }
  if (sub === 'exec') return route;
  if (PNPM_BUILTIN.has(sub)) return null;
  withMain(sub, rest);
  return route;
}

// The option word's name: `--opt` of `--opt=v`, else the word.
function flagName(a) {
  const eq = a.indexOf('=');
  return a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
}

// Does the option take the next word as its value (a PM_VALUE option without `=v`)?
const takesNext = (a) => PM_VALUE.has(flagName(a)) && !(a.startsWith('--') && a.includes('='));

// `run <name>`: the script name is the first word that is not an option, value-taking options
// (PM_VALUE) skipped with their value. An option fence does not know before the name may take the
// name as its value: opaque `package-option`.
function runScript(route, rest, withMain) {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!isStr(a)) {
      route.unresolved = true;
      return;
    }
    if (a === '--') {
      if (isStr(rest[i + 1])) withMain(rest[i + 1], rest.slice(i + 2));
      else if (i + 1 < rest.length) route.unresolved = true;
      return;
    }
    if (!a.startsWith('-') || a === '-') {
      withMain(a, rest.slice(i + 1));
      return;
    }
    if (takesNext(a)) {
      i++;
      continue;
    }
    const flag = flagName(a);
    if (PM_VALUE.has(flag) || a.startsWith('--no-') || PM_BOOLEAN.has(flag) || (a.startsWith('--') && a.includes('='))) continue;
    route.opaque = { reason: 'unsupported', construct: 'package-option' };
    return;
  }
}

// The words appended to the script: npm passes the words after `--` and the plain words before it
// (its own options, and their values, stay its own); yarn and pnpm pass every word. UNKNOWN stays
// UNKNOWN.
function scriptArgs(program, after) {
  const out = [];
  let dashed = false;
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    if (!dashed && a === '--') {
      dashed = true;
      continue;
    }
    if (program === 'npm' && !dashed && isStr(a) && a.startsWith('-')) {
      if (takesNext(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// make

// A command-line variable that changes how make runs recipes, adds options, or adds makefiles (all
// spellings of the assignment operators). Other `VAR=value` overrides stay runs-repo-code (a named
// limit: a recipe may use any variable).
const MAKE_OVERRIDE = /^[ \t]*(?:SHELL|\.SHELLFLAGS|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|MAKEFILES)[ \t]*(?:[:+?!]|::|:::)?=/;

// GNU make's long options (getopt_long: any unique prefix names one; an exact name wins).
// 'req': the value is after `=` or in the next word; 'opt': only after `=`; 'none': no value.
const MAKE_LONG = {
  'always-make': 'none', 'assume-new': 'req', 'assume-old': 'req', 'check-symlink-times': 'none', debug: 'opt',
  directory: 'req', 'dry-run': 'none', 'environment-overrides': 'none', eval: 'req', file: 'req', help: 'none',
  'ignore-errors': 'none', 'include-dir': 'req', jobs: 'opt', 'jobserver-auth': 'req', 'jobserver-style': 'req',
  'just-print': 'none', 'keep-going': 'none', 'load-average': 'opt', makefile: 'req', 'max-load': 'opt',
  'new-file': 'req', 'no-builtin-rules': 'none', 'no-builtin-variables': 'none', 'no-keep-going': 'none',
  'no-print-directory': 'none', 'no-silent': 'none', 'old-file': 'req', 'output-sync': 'opt',
  'print-data-base': 'none', 'print-directory': 'none', question: 'none', quiet: 'none', recon: 'none',
  shuffle: 'opt', silent: 'none', stop: 'none', touch: 'none', trace: 'none', version: 'none',
  'warn-undefined-variables': 'none', 'what-if': 'req',
};
const MAKE_SENSITIVE = new Set(['file', 'makefile', 'directory', 'eval']);

// The long option a `--name` word names: {name} (unique prefix or exact), or {ambiguous: names} /
// {unknown: true}.
function makeLong(raw) {
  if (Object.hasOwn(MAKE_LONG, raw)) return { name: raw };
  const hits = Object.keys(MAKE_LONG).filter((l) => l.startsWith(raw));
  if (hits.length === 1) return { name: hits[0] };
  return hits.length === 0 ? { unknown: true } : { ambiguous: hits };
}

function makeRoute(argv) {
  const files = [];
  const dirs = [];
  let unresolved = false;
  let inline = false;
  let options = true;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      // an UNKNOWN word may be --eval=… or SHELL=…
      inline = true;
      continue;
    }
    if (MAKE_OVERRIDE.test(a)) {
      inline = true;
      continue;
    }
    if (!options) continue;
    if (a === '--') {
      options = false;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const raw = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const m = makeLong(raw);
      if (m.name === undefined) {
        // make refuses an unknown or ambiguous option; one that may be --file/--eval is not followed
        if (m.unknown || m.ambiguous.some((n) => MAKE_SENSITIVE.has(n))) inline = true;
        continue;
      }
      const kind = MAKE_LONG[m.name];
      let v;
      if (eq >= 0) v = a.slice(eq + 1);
      else if (kind === 'req') v = argv[++i];
      if (m.name === 'eval') inline = true;
      else if (m.name === 'file' || m.name === 'makefile') files.push(v);
      else if (m.name === 'directory') dirs.push(v);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (c === 'E') {
          inline = true;
          if (k + 1 === a.length) i++;
          break;
        }
        if (c === 'f' || c === 'C') {
          const v = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
          (c === 'f' ? files : dirs).push(v);
          break;
        }
        if ('IoW'.includes(c)) {
          if (k + 1 === a.length) i++;
          break;
        }
      }
    }
  }
  if (files.some((f) => !isStr(f)) || dirs.some((d) => !isStr(d))) unresolved = true;
  // a makefile read from stdin or another descriptor is never a file fence can read (the normalizer
  // also checks where each file resolves)
  if (files.some((f) => isStr(f) && stdinPath(f.toLowerCase()) !== null)) inline = true;
  const route = { type: 'make', files: files.filter(isStr), dirs: dirs.filter(isStr), unresolved };
  if (inline) route.opaque = { reason: 'unsupported', construct: 'makefile-inline' };
  return route;
}

// ---------------------------------------------------------------------------------------------
// Other runners of repository code

const PYTHON = /^python[0-9.]*$/;
const PY_VALUE = 'WX';
const PYTEST_VALUE = new Set(
  words('-k -m -p -c -o -W -n -r --rootdir --basetemp --confcutdir --deselect --ignore --ignore-glob --junitxml --junit-xml --log-file --tb --maxfail --durations --cov --cov-report --import-mode --override-ini --capture --log-level --log-cli-level --pyargs -x'),
);
PYTEST_VALUE.delete('-x');
PYTEST_VALUE.delete('--pyargs');

function pytestFiles(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!isStr(a)) {
      out.push(UNKNOWN);
      continue;
    }
    if (a.startsWith('-')) {
      if (PYTEST_VALUE.has(a)) i++;
      continue;
    }
    const f = a.split('::')[0];
    if (f.endsWith('.py')) out.push(f);
  }
  return out;
}

function pythonRoute(argv) {
  let isolated = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return { type: 'code', files: [UNKNOWN], modules: [], isolated };
    if (a === '-') return null; // the program is stdin (the stdin-interpreter rule)
    if (a === '--') {
      const f = argv[i + 1];
      return f === undefined ? null : { type: 'code', files: [f], modules: [], isolated };
    }
    if (a === '--check-hash-based-pycs') {
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (c === 'I' || c === 'P') isolated = true;
        if (c === 'c') return null; // inline code: the interpreter allowlist
        if (c === 'm') {
          const mod = k + 1 < a.length ? a.slice(k + 1) : argv[i + 1];
          const after = argv.slice(k + 1 < a.length ? i + 1 : i + 2);
          const files = mod === 'pytest' ? pytestFiles(after) : [];
          return { type: 'code', files, modules: isStr(mod) ? [mod] : [UNKNOWN], isolated };
        }
        if (PY_VALUE.includes(c)) {
          if (k + 1 === a.length) i++;
          break;
        }
      }
      continue;
    }
    return { type: 'code', files: [a], modules: [], isolated };
  }
  return null; // no program: interactive, or stdin
}

// node options before the main file. Every option that takes a value (in the next word, or after `=`):
const NODE_VALUE = new Set(
  words(
    '-r --require --import --loader --experimental-loader -C --conditions --input-type --title --test-name-pattern --test-skip-pattern --test-reporter --test-reporter-destination --test-concurrency --test-shard --test-timeout --watch-path --disable-warning --unhandled-rejections --experimental-default-type --max-old-space-size --max-semi-space-size --stack-size --stack-trace-limit',
  ),
);
// Options that take no value (written without `=`).
const NODE_BOOL = new Set(
  words(
    '-c --check --test --test-only --test-update-snapshots --experimental-test-coverage --watch --watch-preserve-output --no-warnings --enable-source-maps --trace-warnings --trace-deprecation --trace-uncaught --experimental-vm-modules --experimental-strip-types --experimental-transform-types --no-experimental-strip-types --experimental-detect-module --no-experimental-detect-module --expose-gc --pending-deprecation --no-deprecation --throw-deprecation --preserve-symlinks --preserve-symlinks-main --abort-on-uncaught-exception --frozen-intrinsics --zero-fill-buffers',
  ),
);
const NODE_LOADS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const NODE_INLINE = new Set(['-e', '--eval', '-p', '--print']);
const NODE_EXTS = ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'];
const NODE_FLAG = Object.freeze({ reason: 'unsupported', construct: 'node-flag' });

// node <file>: the main file (with the extensions node tries), every file of `--test`, and local
// preload files (-r/--import/--loader). A preload given as a URL (file:, data:, http(s):, any scheme
// but node:), or an option fence does not know (it may take a value, load a file or open a debugger
// port), is opaque `node-flag`.
function nodeRoute(argv) {
  const files = [];
  let test = false;
  let main = false;
  const local = (v) => isStr(v) && (v.startsWith('.') || v.startsWith('/'));
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      files.push(UNKNOWN);
      if (!test) break;
      continue;
    }
    if (a === '--') {
      if (isStr(argv[i + 1]) || argv[i + 1] === UNKNOWN) files.push(argv[i + 1]);
      main = true;
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      const eq = a.indexOf('=');
      const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
      if (NODE_INLINE.has(flag)) return null; // inline code: the interpreter allowlist
      if (flag === '--test') test = true;
      if (NODE_VALUE.has(flag)) {
        const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
        if (NODE_LOADS.has(flag)) {
          if (!isStr(v)) files.push(UNKNOWN);
          else if (URLISH.test(v) && !v.startsWith('node:')) return { type: 'code', files: [], modules: [], isolated: true, opaque: NODE_FLAG };
          else if (local(v)) files.push(v);
        }
        continue;
      }
      if (NODE_BOOL.has(a)) continue; // a flag given `=v` is not one fence knows
      return { type: 'code', files: [], modules: [], isolated: true, opaque: NODE_FLAG };
    }
    files.push(a);
    main = true;
    if (!test) break; // the rest are the program's own arguments
  }
  if (!main && !test && files.length === 0) return null; // the REPL, or stdin
  const out = [];
  for (const f of files) {
    if (!isStr(f)) out.push(f);
    else for (const ext of NODE_EXTS) out.push(f + ext);
  }
  return { type: 'code', files: out, modules: [], isolated: true };
}

const DENO_VALUE = new Set(words('-c --config --import-map --lock --cert --location --seed -L --log-level --ext --preload --import --watch-exclude --env-file'));
const GO_VALUE = new Set(words('-C -tags -ldflags -gcflags -asmflags -mod -modfile -p -exec -overlay -pgo -toolexec -buildmode -compiler -installsuffix -pkgdir -coverpkg -covermode -o'));
const URLISH = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// The first operand after the sub-command (options with a separate value skipped).
function firstOperand(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!isStr(a)) return { word: UNKNOWN, index: i };
    if (a === '--') return { word: args[i + 1], index: i + 1 };
    if (a.startsWith('-') && a.length > 1) {
      if (!a.includes('=') && valueFlags.has(a)) i++;
      continue;
    }
    return { word: a, index: i };
  }
  return null;
}

// The sub-command of go/cargo/deno: the first word that is not an option (cargo +toolchain skipped).
function subOf(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return { sub: UNKNOWN, index: i };
    if (a.startsWith('-') || a.startsWith('+')) continue;
    return { sub: a, index: i };
  }
  return { sub: null, index: argv.length };
}

const FOREIGN = new Set(['csh', 'tcsh', 'fish', 'mksh', 'ksh93', 'ash', 'yash', 'rc', 'nu', 'pwsh', 'powershell', 'xonsh', 'elvish', 'osh', 'oil', 'ysh']);

function codeRoute(prog, argv) {
  const code = (files = []) => ({ type: 'code', files, modules: [], isolated: true });
  if (PYTHON.test(prog)) return pythonRoute(argv);
  if (prog === 'pytest' || prog === 'py.test') return code(pytestFiles(argv.slice(1)));
  if (prog === 'node' || prog === 'nodejs') return nodeRoute(argv);
  if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') return code();
  if (prog === 'deno' || prog === 'go' || prog === 'cargo') {
    const { sub, index } = subOf(argv);
    if (sub === UNKNOWN) return code([UNKNOWN]);
    if (prog === 'cargo') return sub === 'run' ? code() : null;
    if (prog === 'deno') {
      if (sub === 'run') {
        const f = firstOperand(argv.slice(index + 1), DENO_VALUE);
        return code(f === null || (isStr(f.word) && URLISH.test(f.word)) ? [] : [f.word]);
      }
      // `deno main.ts` runs the file
      return isStr(sub) && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(sub) ? code([sub]) : null;
    }
    // go run [build flags] files.go… | package [args]
    if (sub !== 'run') return null;
    const args = argv.slice(index + 1);
    const f = firstOperand(args, GO_VALUE);
    if (f === null) return code();
    const files = [];
    for (let i = f.index; i < args.length; i++) {
      const a = args[i];
      if (!isStr(a)) {
        files.push(UNKNOWN);
        break;
      }
      if (!a.endsWith('.go')) break;
      files.push(a);
    }
    return code(files);
  }
  if (FOREIGN.has(prog)) {
    // a script file operand (inline code and fed stdin are unwrap.mjs's)
    const f = argv.slice(1).find((a) => !isStr(a) || !a.startsWith('-'));
    return f === undefined ? null : code([f]);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

/**
 * The route by which a command runs a file of the repository, or null (see the header).
 * @param {any[]} argv0 the command after wrapper unwrapping
 * @param {'zsh'|'bash'} kind the shell the command runs in
 */
export function scriptRoute(argv0, kind) {
  try {
    const argv = appletArgv(argv0);
    if (!Array.isArray(argv) || argv.length === 0 || !isStr(argv[0])) return null;
    const cmd = argv[0];
    const STDIN_RUN = { type: 'opaque', opaque: { reason: 'unsupported', construct: 'stdin-interpreter' } };
    if (cmd === 'source' || cmd === '.') {
      const f = argv[1];
      if (f === undefined) return null;
      if (stdinPath(f) !== null) return STDIN_RUN; // `source /dev/stdin` (a fed one is opaque upstream)
      if (isStr(f) && f.startsWith('-')) return { type: 'shell', by: 'source', file: UNKNOWN, kind, bare: false };
      return { type: 'shell', by: 'source', file: f, kind, bare: isStr(f) && !f.includes('/'), command: cmd };
    }
    if (stdinPath(cmd) !== null) return STDIN_RUN;
    const byPath = cmd.includes('/') && !cmd.endsWith('/') ? { type: 'shell', by: 'path', file: cmd, kind: null, bare: false } : null;
    // a relative command word is a file of the project, whatever its name
    if (byPath !== null && !cmd.startsWith('/')) return byPath;
    const sf = shellScriptFile(argv);
    // a shell whose file operand is stdin is unwrap.mjs's (the stdin rule)
    if (sf !== null && stdinPath(sf.file) !== null) return null;
    if (sf !== null) return { type: 'shell', by: 'shell', file: sf.file, kind: sf.kind, bare: isStr(sf.file) && !sf.file.includes('/') };
    const prog = baseName(cmd).toLowerCase();
    if (prog === 'npm' || prog === 'yarn' || prog === 'pnpm') return packageRoute(prog, argv);
    if (prog === 'make' || prog === 'gmake') return makeRoute(argv);
    return codeRoute(prog, argv) ?? byPath;
  } catch {
    return null;
  }
}
