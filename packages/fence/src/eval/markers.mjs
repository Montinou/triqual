// Switch-off markers: the raw-text test behind the floor's "names a protected path" rule.
//
//   switchOffMarkers({home, platform, realpath?})            RegExp[], one per marker
//   namesSwitchOff(rawText, {home, platform, readPaths?, projectRoots?})   the matched marker source, or null
//   switchOffSamples({home, platform, realpath?})            one concrete example per marker (drift test)
//
// The markers are narrower than the self-protection globs (src/eval/builtin.mjs): only the files that
// can switch fence off or change what it enforces. A marker is literal text; after its last character
// the next one must be a boundary (see BOUNDARY; a `.` also counts after the settings markers), except for
// the marker whose protected glob continues the same path segment (`~/.local/bin/fence*`), which takes any
// character after it. Every regexp is a literal prefix followed by lookarounds of one character, so a scan
// is linear in the text.
//
// Codex: only `~/.codex/plugins/cache/<marketplace>/fence` is listed under `~/.codex/plugins/`. The
// layout of Codex's plugin registries is not known to builtin.mjs, so the spec defers listing the
// remaining Codex markers exactly to 0.2.0; the protected glob `~/.codex/plugins/**` still covers
// every resolved target.

import fs from 'node:fs';

import { SYSTEM_GLOBS } from './builtin.mjs';

// After a marker: `/`, a quote (backtick included: it closes a command substitution), whitespace, `;`, `|`,
// `&`, `)`, `<`, `>` or the end of the text. `.` is a boundary only after the settings markers
// (`settings.json`, `settings.local.json`), so `~/.zshrc.bak` is another file.
const BOUNDARY = '(?=[/\'"`\\s;|&)<>]|$)';
const BOUNDARY_DOT = '(?=[/.\'"`\\s;|&)<>]|$)';
// One path segment of any marketplace name: no separator, whitespace or quote.
const SEGMENT = '[^/\\s\'"`]+';
// What may not precede a written absolute path or `~/`: a word, path or variable character, so
// `$TMP/home/<user>/...` and `/tmp/sandbox/home/<user>/...` are not the real home.
const NOT_AFTER = '(?<![\\w.~$}-])';
const NOT_AFTER_TILDE = '(?<![\\w.~$}/-])';
// The start of a word: the start of the text or after whitespace, a quote, `=`, `<`, `>`, `(`, `;`, `|` or `&`.
const WORD_START = '(?<![^\\s\'"=<>(;|&])';

// Home markers. `path` is relative to the home; `*` stands for one segment of any name. `sample` is a
// concrete file the marker names and a protected glob must cover; `continues` takes any character after.
const HOME_MARKERS = [
  { path: '.config/fence', sample: '.config/fence/policy.json' },
  { path: '.local/share/fence', sample: '.local/share/fence/engine/x.mjs' },
  { path: '.local/state/fence', sample: '.local/state/fence/sessions/s.json' },
  { path: '.local/bin/fence', sample: '.local/bin/fence-hook', continues: true },
  { path: '.claude/settings', sample: '.claude/settings.json', dot: true },
  { path: '.codex/config.toml', sample: '.codex/config.toml' },
  { path: '.codex/hooks.json', sample: '.codex/hooks.json' },
  { path: '.codex/requirements.toml', sample: '.codex/requirements.toml' },
  { path: '.zshrc', sample: '.zshrc' },
  { path: '.zprofile', sample: '.zprofile' },
  { path: '.zshenv', sample: '.zshenv' },
  { path: '.bashrc', sample: '.bashrc' },
  { path: '.bash_profile', sample: '.bash_profile' },
  { path: '.profile', sample: '.profile' },
  { path: '.claude/plugins/cache/*/fence', sample: '.claude/plugins/cache/any-market/fence/hooks/hooks.json' },
  { path: '.claude/plugins/marketplaces/*/plugins/fence', sample: '.claude/plugins/marketplaces/m/plugins/fence/x' },
  { path: '.claude/plugins/installed_plugins.json', sample: '.claude/plugins/installed_plugins.json' },
  { path: '.claude/plugins/known_marketplaces.json', sample: '.claude/plugins/known_marketplaces.json' },
  { path: '.codex/plugins/cache/*/fence', sample: '.codex/plugins/cache/any-market/fence/x' },
];

// Project markers: only at the start of a word, optionally after `./`.
const PROJECT_MARKERS = [
  { path: '.claude/settings', sample: '.claude/settings.local.json', dot: true },
  { path: '.codex/config.toml', sample: '.codex/config.toml' },
];

// One literal character as a regexp body; with `ci`, a letter matches either case (the file system of
// darwin is case-insensitive). Done per letter, not with the `i` flag, so `$HOME` stays exact.
const SPECIAL = /[\\^$.*+?()[\]{}|/-]/;
const escapeRe = (s, ci) =>
  [...s]
    .map((c) => {
      if (SPECIAL.test(c)) return `\\${c}`;
      return ci && c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
    })
    .join('');

// A literal path as a regexp body: `*` is a segment, and a space may be written `\ `.
function body(path, ci) {
  return path
    .split('*')
    .map((part) => part.split(' ').map((w) => escapeRe(w, ci)).join('(?: |\\\\ )'))
    .join(SEGMENT);
}

function realpathOr(p, realpath) {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

// The admin directory, the locked-mode directory, Claude managed settings and Codex managed requirements:
// the root-owned globs of builtin.mjs without their `/**`. An unknown platform gets both lists.
function systemPaths(platform) {
  const globs = SYSTEM_GLOBS[platform] ?? [...SYSTEM_GLOBS.darwin, ...SYSTEM_GLOBS.linux];
  return [...new Set(globs.map((g) => g.replace(/\/\*\*$/, '')))];
}

function buildEntries({ home, platform, realpath = fs.realpathSync.native }) {
  const ci = platform === 'darwin';
  const homes = [...new Set([home, realpathOr(home, realpath)].map((h) => h.replace(/\/+$/, '')))].filter(Boolean);
  const prefix = [
    `${NOT_AFTER_TILDE}~/`,
    '\\$HOME[\'"]?/',
    '\\$\\{HOME\\}[\'"]?/',
    ...homes.map((h) => `${NOT_AFTER}${body(h, ci)}/`),
  ].join('|');
  const end = (m) => (m.continues ? '' : m.dot ? BOUNDARY_DOT : BOUNDARY);
  const out = [];
  for (const m of HOME_MARKERS) {
    const sample = m.sample;
    out.push({
      re: new RegExp(`(?:${prefix})${body(m.path, ci)}${end(m)}`),
      readRe: new RegExp(`(?:${homes.map((h) => `${NOT_AFTER}${body(h, ci)}/`).join('|')})${body(m.path, ci)}${end(m)}`),
      text: `~/${sample}`,
      path: `${home}/${sample}`,
    });
  }
  for (const p of systemPaths(platform)) {
    const re = new RegExp(`${NOT_AFTER}${body(p, ci)}${BOUNDARY}`);
    out.push({ re, readRe: re, text: `${p}/x`, path: `${p}/x` });
  }
  for (const m of PROJECT_MARKERS) {
    out.push({
      re: new RegExp(`${WORD_START}(?:\\./)?${body(m.path, ci)}${end(m)}`),
      // A resolved read path is absolute: the project marker names its tail, and the read counts only
      // when it lies under a project root (see namesSwitchOff).
      readRe: new RegExp(`(?<=/)${body(m.path, ci)}${end(m)}`),
      project: true,
      text: m.sample,
      path: `/work/repo/${m.sample}`,
    });
  }
  return out;
}

export function switchOffMarkers(opts) {
  return buildEntries(opts).map((e) => e.re);
}

// One example per marker, in table order: the text that names it and the file it stands for.
export function switchOffSamples(opts) {
  return buildEntries(opts).map((e) => ({ marker: e.re, text: e.text, path: e.path }));
}

function countMatches(re, text) {
  const g = new RegExp(re.source, `${re.flags}g`);
  let n = 0;
  for (const _ of text.matchAll(g)) n += 1;
  return n;
}

// Whether the absolute `path` lies under one of the project roots (absolute, as resolved by the caller).
function underRoot(path, roots, ci) {
  const norm = (p) => (ci ? p.toLowerCase() : p);
  return roots.some((r) => typeof r === 'string' && r !== '' && norm(path).startsWith(`${norm(r.replace(/\/+$/, ''))}/`));
}

// The source of the first marker the raw command text names, or null. A marker is suppressed only when
// its number of matches is at most the number of resolved read paths it matches: a plain read is not a
// switch-off, but a second mention that is not a read stays in doubt. A project marker's read counts only
// when the read path lies under one of `projectRoots` (the call's effective cwd or project roots); with
// none given, no read of a project marker counts.
export function namesSwitchOff(rawText, { home, platform, readPaths = [], projectRoots = [], realpath } = {}) {
  if (typeof rawText !== 'string' || rawText === '') return null;
  const ci = platform === 'darwin';
  for (const { re, readRe, project } of buildEntries({ home, platform, realpath })) {
    const found = countMatches(re, rawText);
    if (found === 0) continue;
    const reads = readPaths.reduce(
      (n, p) => n + (typeof p === 'string' && readRe.test(p) && (!project || underRoot(p, projectRoots, ci)) ? 1 : 0),
      0,
    );
    if (found > reads) return re.source;
  }
  return null;
}
