// Built-in self-protection: compiled into the engine and not removable by policy.
//
// Pure functions over the data tables below:
//   protectedGlobs({home, platform, realpath})        the protected path globs
//   checkPathWrite(absPath, opts)                       a write, delete, move, chmod or link of a path
//   checkAncestorOp(absPath, op, opts)                  delete|move|chmod|link|bulk (a bulk writer: T18) of a path that may hold protected ones
//   checkCommandArgv(argv)                              denied fence, claude and codex command lines
// Each returns null (not denied) or {rule, reason}. A value the normalizer could not
// determine (UNKNOWN) always denies: these checks fail closed.
//
// Callers must pass realpath-resolved absolute targets and project roots (existing components
// resolved with fs.realpathSync.native); these checks only normalise `.`/`..` lexically.
//
// Variable assignments that redirect a host's config (HOME=, XDG_*=, CLAUDE_CONFIG_DIR=, CODEX_HOME=,
// env -i/-u) are detected by the normalizer before argv reaches checkCommandArgv; argv here is
// already wrapper-stripped.

import fs from 'node:fs';
import path from 'node:path';

import { compileGlob, resolveGlobPrefix } from '../match/glob.mjs';
import { UNKNOWN, isUnknown } from '../norm/unknown.mjs';
import { foldCase } from '../resolve/paths.mjs';

// ---- Data tables -------------------------------------------------------------------------------

// Protected on every platform. `~` is the home directory.
export const HOME_GLOBS = [
  // policy directory, installed engine, state, CLI and watchdog
  '~/.config/fence/**',
  '~/.local/share/fence/**',
  '~/.local/state/fence/**',
  '~/.local/bin/fence*',
  // plugin caches and marketplace clones
  '~/.claude/plugins/**',
  '~/.codex/plugins/**',
  // host settings (they can disable hooks)
  '~/.claude/settings*.json',
  '~/.codex/config.toml',
  '~/.codex/hooks.json',
  '~/.codex/requirements.toml',
  // shell startup files and Claude's shell snapshots
  '~/.zshrc',
  '~/.zprofile',
  '~/.zshenv',
  '~/.bashrc',
  '~/.bash_profile',
  '~/.profile',
  '~/.claude/shell-snapshots/**',
  // directories the hosts load plugins, skills or mods from
  '~/.claude/skills/**',
  '~/.claude/dev-mods/**',
  '~/.agents/**',
];

// Root-owned directories per platform: the admin directory, the locked-mode directory, Claude
// managed settings and Codex managed requirements.
export const SYSTEM_GLOBS = {
  darwin: [
    '/Library/Application Support/fence/**',
    '/usr/local/libexec/fence/**',
    '/Library/Application Support/ClaudeCode/**',
    '/etc/codex/**',
  ],
  linux: ['/var/lib/fence/**', '/usr/local/libexec/fence/**', '/etc/claude-code/**', '/etc/codex/**'],
};

// Protected under every project root the caller names.
export const PROJECT_SUBGLOBS = ['.claude/settings*.json', '.claude/skills/**', '.codex/**'];

export const ANCESTOR_OPS = ['delete', 'move', 'chmod', 'link', 'bulk'];

// The only fence subcommands an agent may run.
export const FENCE_ALLOWED_SUBCOMMANDS = ['check', 'test', 'log', 'doctor', 'replay', 'audit', 'version', 'help'];
// Flags fence accepts without a subcommand.
export const FENCE_BARE_FLAGS = ['--help', '-h', '--version', '-V'];

// Denied subcommand trees: a key is a subcommand word, `true` denies once reached.
export const DENIED_SUBCOMMANDS = {
  claude: {
    plugin: {
      disable: true,
      uninstall: true,
      enable: true,
      install: true,
      update: true,
      configure: true,
      prune: true,
      // scaffolds into the protected ~/.claude/skills
      init: true,
      marketplace: { add: true, remove: true, update: true },
    },
    config: { set: true, add: true, remove: true },
    mcp: { add: true, remove: true, 'add-json': true, 'add-from-claude-desktop': true },
  },
  codex: {
    features: { enable: true, disable: true },
    // Any plugin or config subcommand: none is known to be read-only.
    plugin: true,
    config: true,
    mcp: { add: true, remove: true },
  },
};

// Subcommand aliases, per position in the tree (the canonical words joined by spaces; '' is
// the top level). From `claude <cmd> --help` (Claude Code 2.1.302); `mcp` has none.
export const SUBCOMMAND_ALIASES = {
  claude: {
    '': { plugins: 'plugin' },
    plugin: { i: 'install', remove: 'uninstall', autoremove: 'prune', new: 'init' },
    'plugin marketplace': { rm: 'remove' },
  },
  codex: {},
};

// Long launch flags that load other settings, plugins, or switch off sandboxing, approvals,
// hooks or features (also in `--flag=value` form).
export const LAUNCH_OVERRIDE_FLAGS = {
  claude: ['--settings', '--setting-sources', '--plugin-dir', '--bare', '--plugin-url'],
  codex: [
    '--settings',
    '--setting-sources',
    '--plugin-dir',
    '--disable',
    '--enable',
    '--sandbox',
    '--ask-for-approval',
    '--dangerously-bypass-approvals-and-sandbox',
    // hidden alias of the flag above (codex-cli 0.163.0 accepts it)
    '--yolo',
    '--dangerously-bypass-hook-trust',
    // older releases: -a on-request -s workspace-write
    '--full-auto',
    // approval-weakening, same class as -a
    '--approve-for-me',
    // skips $CODEX_HOME/config.toml, where the hooks may be registered
    '--ignore-user-config',
  ],
};
// Codex short flags denied with any value, also attached (`-sMODE`, `-s=MODE`).
export const CODEX_SHORT_OVERRIDE_FLAGS = ['-s', '-a'];
// Codex `-c`/`--config` keys: a key equal to or under these sections...
export const CODEX_CONFIG_SECTIONS = ['features', 'hooks', 'plugins', 'projects'];
// ...or starting with these names (sandbox_mode, sandbox_workspace_write.*, approval_policy).
export const CODEX_CONFIG_KEY_PREFIXES = ['sandbox', 'approval'];

// ---- Paths -------------------------------------------------------------------------------------

const SELF = 'builtin:self-protection';
const FENCE_CMD = 'builtin:fence-command';
const HOST_CFG = 'builtin:host-config';
const PROTECTED = "is protected by fence's built-in self-protection";

const noRealpath = () => {
  throw new Error('no realpath');
};

// Literal text inside a glob: metacharacters become one-character classes.
function escapeGlobLiteral(s) {
  return s.replace(/[*?[$~]/g, (c) => `[${c}]`);
}

function systemGlobs(platform) {
  return SYSTEM_GLOBS[platform] ?? [...new Set([...SYSTEM_GLOBS.darwin, ...SYSTEM_GLOBS.linux])];
}

// Each glob both as written (expanded) and with its literal prefix resolved through
// `realpath`, so a symlinked directory protects its target as well as the link path.
function expandBoth(patterns, vars, realpath) {
  const out = [];
  for (const p of patterns) {
    out.push(resolveGlobPrefix(p, vars, noRealpath));
    out.push(resolveGlobPrefix(p, vars, realpath));
  }
  return [...new Set(out)];
}

export function protectedGlobs({ home, platform, realpath = fs.realpathSync.native }) {
  return expandBoth([...HOME_GLOBS, ...systemGlobs(platform)], { home }, realpath);
}

// A project root list the checks cannot use (not an array, an UNKNOWN or relative root).
function badProjectRoots(projectRoots) {
  if (projectRoots === undefined) return false;
  if (!Array.isArray(projectRoots)) return true;
  return projectRoots.some((r) => typeof r !== 'string' || !r.startsWith('/') || r.includes('\u0000'));
}

// The roots among `projectRoots` the checks can use: absolute strings without a NUL.
function validProjectRoots(projectRoots) {
  if (!Array.isArray(projectRoots)) return [];
  return projectRoots.filter((r) => typeof r === 'string' && r.startsWith('/') && !r.includes('\u0000'));
}

// The project-root globs alone: they depend on the roots the caller names. Only the valid
// roots count, so a bad root beside a good one cannot hide a match under the good one.
function projectGlobs({ home, projectRoots = [], realpath = fs.realpathSync.native }) {
  const project = [];
  for (const root of validProjectRoots(projectRoots)) {
    const base = escapeGlobLiteral(path.posix.resolve(root).replace(/\/+$/, ''));
    for (const sub of PROJECT_SUBGLOBS) project.push(`${base}/${sub}`);
  }
  return expandBoth(project, { home }, realpath);
}


// The resolver's fold (NFC + full Unicode case fold), so builtin and the resolver always agree.
const fold = foldCase;

// The leading segments of an expanded glob that hold no wildcard, unescaping one-character
// classes. `literal` is true when the whole glob is literal.
function literalPrefix(glob) {
  const segs = glob.split('/');
  const out = [];
  for (const seg of segs) {
    const plain = seg.replace(/\[([*?[$~])\]/g, '');
    if (/[*?[]/.test(plain)) return { prefix: out.join('/') || '/', literal: false };
    out.push(seg.replace(/\[([*?[$~])\]/g, '$1'));
  }
  return { prefix: out.join('/') || '/', literal: true };
}

function normalizeTarget(absPath) {
  if (typeof absPath !== 'string' || !absPath.startsWith('/') || absPath.includes('\u0000')) return null;
  return path.posix.resolve(absPath);
}

function unresolvedDeny(what) {
  return {
    rule: SELF,
    reason: `The target of this ${what} could not be determined, so it may be a path that ${PROTECTED}; it is denied.`,
    floor: false,
    certain: false,
  };
}

function matchProtected(target, globs, caseInsensitive) {
  const candidate = fold(target, caseInsensitive);
  for (const g of globs) {
    // Placeholders are already expanded; `home` is never read again.
    if (compileGlob(fold(g, caseInsensitive), { home: '/' }).test(candidate)) return g;
  }
  return null;
}

function badRootsDeny() {
  return {
    rule: SELF,
    reason: `A project root could not be resolved to an absolute path, so fence's built-in self-protection cannot tell which paths under it are protected; the call is denied.`,
    floor: false,
    certain: false,
  };
}

// A write to a resolved target that matches `globs`.
function writeHit(target, hit) {
  return {
    rule: SELF,
    reason: `${target} ${PROTECTED} (${hit}); an agent may not write, move, delete or link it. A human can run "fence allow-once ${target}".`,
    floor: true,
    certain: true,
  };
}

export function checkPathWrite(absPath, opts) {
  const target = isUnknown(absPath) ? null : normalizeTarget(absPath);
  // A resolved hit on the home or system globs is decided first: those globs need no project
  // root, so an unresolved root elsewhere in the call cannot hide it.
  if (target !== null) {
    const base = matchProtected(target, protectedGlobs(opts), opts.caseInsensitive);
    if (base !== null) return writeHit(target, base);
  }
  const bad = badProjectRoots(opts.projectRoots);
  if (bad && target === null) return badRootsDeny();
  if (target === null) return unresolvedDeny('write');
  // A hit under a valid root is definite even when another root is bad.
  const hit = matchProtected(target, projectGlobs(opts), opts.caseInsensitive);
  if (hit !== null) return writeHit(target, hit);
  return bad ? badRootsDeny() : null;
}

// An ancestor operation on a resolved target against `globs`, or null.
function ancestorHit(target, op, globs, ci) {
  const own = matchProtected(target, globs, ci);
  if (own !== null) {
    return { rule: SELF, reason: `${target} ${PROTECTED} (${own}); an agent may not ${op} it.`, floor: true, certain: true };
  }
  const t = fold(target, ci);
  const under = t === '/' ? '/' : `${t}/`;
  for (const g of globs) {
    const { prefix, literal } = literalPrefix(g);
    const p = fold(prefix, ci);
    if (p.startsWith(under) || (!literal && p === t)) {
      return {
        rule: SELF,
        reason: `${target} holds paths that ${PROTECTED} (${g}); an agent may not ${op} it as a whole.`,
        floor: true,
        certain: true,
      };
    }
  }
  return null;
}

export function checkAncestorOp(absPath, op, opts) {
  if (!ANCESTOR_OPS.includes(op)) throw new TypeError(`unknown ancestor operation ${JSON.stringify(op)}`);
  const target = isUnknown(absPath) ? null : normalizeTarget(absPath);
  const ci = opts.caseInsensitive;
  // As in checkPathWrite: the home and system globs are decided before an unresolved root.
  if (target !== null) {
    const base = ancestorHit(target, op, protectedGlobs(opts), ci);
    if (base !== null) return base;
  }
  const bad = badProjectRoots(opts.projectRoots);
  if (bad && target === null) return badRootsDeny();
  if (target === null) return unresolvedDeny(op);
  const hit = ancestorHit(target, op, projectGlobs(opts), ci);
  if (hit !== null) return hit;
  return bad ? badRootsDeny() : null;
}

// ---- Commands ----------------------------------------------------------------------------------

const isFlag = (w) => typeof w === 'string' && w.startsWith('-') && w !== '-';

function programName(word) {
  return path.posix.basename(word).toLowerCase();
}

// Non-flag words from `start` that could be the next subcommand: the first non-flag word,
// and, while a non-flag word directly follows a flag with no `=` (so it may be that flag's
// value), the next one too.
function subcommandCandidates(words, start) {
  const out = [];
  for (let i = start; i < words.length; i++) {
    if (isFlag(words[i])) continue;
    out.push(i);
    const prev = words[i - 1];
    const maybeValue = i > start && isFlag(prev) && !prev.includes('=');
    if (!maybeValue) break;
  }
  return out;
}

// Walks a denied subcommand tree, mapping aliases to canonical names; returns the matched
// canonical words or null. `at` holds the canonical words above this level.
function matchTree(words, start, tree, aliases, at = []) {
  const here = aliases[at.join(' ')] ?? {};
  for (const i of subcommandCandidates(words, start)) {
    const word = Object.hasOwn(here, words[i]) ? here[words[i]] : words[i];
    const node = Object.hasOwn(tree, word) ? tree[word] : undefined;
    if (node === undefined) continue;
    if (node === true) return [word];
    const rest = matchTree(words, i + 1, node, aliases, [...at, word]);
    if (rest) return [word, ...rest];
  }
  return null;
}

function flagName(word) {
  const eq = word.indexOf('=');
  return eq === -1 ? word : word.slice(0, eq);
}

// True when `w` is the short flag `short` (`-s`), alone or with an attached value.
const isShortFlag = (w, short) => !w.startsWith('--') && w.startsWith(short);

// The value of a codex `-c`/`--config` word at `i`, or undefined when it is not one.
function codexConfigValue(words, i) {
  const w = words[i];
  if (w === '-c' || w === '--config') return words[i + 1];
  if (w.startsWith('--config=')) return w.slice('--config='.length);
  if (w.startsWith('-c=')) return w.slice(3);
  if (isShortFlag(w, '-c')) return w.slice(2);
  return undefined;
}

function deniedCodexKey(value) {
  const eq = value.indexOf('=');
  const key = (eq === -1 ? value : value.slice(0, eq)).replace(/["'\s]/g, '');
  return (
    CODEX_CONFIG_SECTIONS.some((s) => key === s || key.startsWith(`${s}.`)) ||
    CODEX_CONFIG_KEY_PREFIXES.some((p) => key.startsWith(p))
  );
}

function hostDeny(prog, what) {
  return {
    rule: HOST_CFG,
    reason: `${prog} ${what} changes ${prog === 'claude' ? 'Claude Code' : 'Codex'} settings, hooks or plugins and ${PROTECTED}.`,
    floor: true,
    certain: true,
  };
}

function checkFence(words) {
  const allowed = FENCE_ALLOWED_SUBCOMMANDS.join(', ');
  // Every word that could be the subcommand (see subcommandCandidates) must be allowed.
  const candidates = subcommandCandidates(words, 1);
  for (const i of candidates) {
    const w = words[i];
    if (isUnknown(w)) {
      return {
        rule: FENCE_CMD,
        reason: `A fence command whose subcommand could not be determined ${PROTECTED}; agents may run only fence ${allowed}.`,
        floor: true,
        certain: false,
      };
    }
    if (!FENCE_ALLOWED_SUBCOMMANDS.includes(w)) {
      return {
        rule: FENCE_CMD,
        reason: `"fence ${w}" ${PROTECTED}; agents may run only fence ${allowed}. A human runs the others.`,
        floor: true,
        certain: true,
      };
    }
  }
  if (candidates.length) return null;
  const odd = words.slice(1).find((w) => !FENCE_BARE_FLAGS.includes(w));
  if (odd === undefined) return null;
  return {
    rule: FENCE_CMD,
    reason: `"fence ${odd}" without a subcommand ${PROTECTED}; agents may run only fence ${allowed}.`,
    floor: true,
    certain: true,
  };
}

function checkHost(prog, words) {
  if (words.slice(1).some(isUnknown)) {
    return {
      rule: HOST_CFG,
      reason: `A ${prog} command with a word that could not be determined (it may be a settings flag or subcommand) ${PROTECTED}.`,
      floor: true,
      certain: false,
    };
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!isFlag(w)) continue;
    const name = flagName(w);
    if (LAUNCH_OVERRIDE_FLAGS[prog].includes(name)) return hostDeny(prog, `launched with ${name}`);
    if (prog !== 'codex') continue;
    const short = CODEX_SHORT_OVERRIDE_FLAGS.find((f) => isShortFlag(w, f));
    if (short) return hostDeny(prog, `launched with ${short}`);
    const value = codexConfigValue(words, i);
    if (typeof value === 'string' && deniedCodexKey(value)) {
      return hostDeny(prog, `launched with ${w === '-c' || w === '--config' ? `${w} ${value}` : w}`);
    }
  }
  const matched = matchTree(words, 1, DENIED_SUBCOMMANDS[prog], SUBCOMMAND_ALIASES[prog]);
  if (matched) return hostDeny(prog, matched.join(' '));
  return null;
}

export function checkCommandArgv(argv) {
  if (!Array.isArray(argv)) {
    return {
      rule: FENCE_CMD,
      reason: `A command line that is not a word list cannot be checked and ${PROTECTED}.`,
      floor: true,
      certain: false,
    };
  }
  if (argv.length === 0) return null;
  const first = argv[0];
  if (typeof first !== 'string') {
    return {
      rule: FENCE_CMD,
      reason: `A command whose program could not be determined may be fence, claude or codex and ${PROTECTED}.`,
      floor: true,
      certain: false,
    };
  }
  // Any other word that is neither a string nor UNKNOWN is read as UNKNOWN (fail closed).
  argv = argv.map((w) => (typeof w === 'string' ? w : UNKNOWN));
  const prog = programName(first);
  if (prog === 'fence') return checkFence(argv);
  if (prog === 'claude' || prog === 'codex') return checkHost(prog, argv);
  return null;
}
