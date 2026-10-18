// The sudo gate for weakening commands and the sudo configuration check (spec, "CLI").
//
// sudoGate runs `sudo -k` (drop any cached credential) then `sudo -v` (authenticate afresh; Touch ID
// where PAM has it). Anything but two clean exits denies. `run` is required (the CLI wiring passes
// realRun); `sudoPath` exists only for unit tests, the CLI never passes it, so the gate uses SUDO from
// the command table in humanonly.mjs.
//
// sudoConfigWarnings reads the sudoers files through an injected reader, following @include /
// #include / @includedir / #includedir up to MAX_INCLUDE_DEPTH levels, and warns when the gate means
// nothing: a NOPASSWD tag, `Defaults !authenticate`, or a timestamp_timeout longer than
// MAX_TIMESTAMP_MINUTES (or negative: never expires). A file it can not read is a warning too.

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { SUDO } from './humanonly.mjs';

export const MAX_TIMESTAMP_MINUTES = 15;
export const MAX_INCLUDE_DEPTH = 4;
export const SUDOERS = '/etc/sudoers';

// The real process runner, for the CLI wiring to pass as `run` (spawnSync shape). With `input`, the
// data goes to the program's stdin and its stdout is discarded (sudo prompts on the terminal, not
// on stdin); otherwise the terminal is inherited.
export function realRun(cmd, args, { input } = {}) {
  if (input !== undefined) return spawnSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'inherit'] });
  return spawnSync(cmd, args, { stdio: 'inherit' });
}

function failed(r) {
  if (!r) return 'no result';
  if (r.error) return r.error.message;
  if (r.status !== 0) return r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  return null;
}

export function sudoGate({ sudoPath = SUDO, run } = {}) {
  if (typeof run !== 'function') throw new Error('sudoGate: no process runner was given');
  if (typeof sudoPath !== 'string' || !nodePath.isAbsolute(sudoPath)) {
    return { ok: false, reason: `the sudo path must be absolute, got ${JSON.stringify(sudoPath)}` };
  }
  const k = failed(run(sudoPath, ['-k']));
  if (k) return { ok: false, reason: `sudo -k failed (${k})` };
  const v = failed(run(sudoPath, ['-v']));
  if (v) return { ok: false, reason: `sudo -v failed (${v})` };
  return { ok: true };
}

// The real reader, for the CLI wiring (read-only): read(file) -> text, list(dir) -> names.
export const realSudoersReader = Object.freeze({
  read: (file) => nodeFs.readFileSync(file, 'utf8'),
  list: (dir) => nodeFs.readdirSync(dir),
});

// Logical lines: continuations joined, comments dropped. `#include` / `#includedir` are directives,
// not comments.
function logicalLines(text) {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && (!l.startsWith('#') || /^#include(?:dir)?\s/.test(l)));
}

const INCLUDE = /^[@#]include\s+(.+)$/;
const INCLUDEDIR = /^[@#]includedir\s+(.+)$/;

function directivePath(raw, fromFile) {
  let p = raw.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return nodePath.isAbsolute(p) ? p : nodePath.join(nodePath.dirname(fromFile), p);
}

function attempt(fn, arg) {
  try {
    const v = fn(arg);
    return v === null || v === undefined ? null : v;
  } catch {
    return null;
  }
}

// reader = { read(file) -> string | null (or throws), list(dir) -> string[] | null (or throws) }.
// -> the logical lines of `root` and everything it includes, plus the problems met on the way.
function collect(reader, root) {
  const lines = [];
  const problems = [];
  const seen = new Set();
  const visit = (file, depth) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = attempt(reader.read, file);
    if (text === null) {
      problems.push(`sudo configuration ${file} could not be read; it was not checked`);
      return;
    }
    for (const line of logicalLines(String(text))) {
      const dir = INCLUDEDIR.exec(line);
      const inc = dir ? null : INCLUDE.exec(line);
      if (!dir && !inc) {
        lines.push(line);
        continue;
      }
      const target = directivePath((dir ?? inc)[1], file);
      if (depth + 1 > MAX_INCLUDE_DEPTH) {
        problems.push(`sudo configuration ${target} is included deeper than ${MAX_INCLUDE_DEPTH} levels; it was not checked`);
        continue;
      }
      if (inc) {
        visit(target, depth + 1);
        continue;
      }
      const names = typeof reader.list === 'function' ? attempt(reader.list, target) : null;
      if (!Array.isArray(names)) {
        problems.push(`sudo configuration directory ${target} could not be read; it was not checked`);
        continue;
      }
      // sudo skips names ending in `~` or containing a `.`
      for (const name of [...names].filter((n) => !n.endsWith('~') && !n.includes('.')).sort()) {
        visit(nodePath.join(target, name), depth + 1);
      }
    }
  };
  visit(root, 0);
  return { lines, problems };
}

export function sudoConfigWarnings({ read, list, root = SUDOERS } = {}) {
  if (typeof read !== 'function') throw new Error('sudoConfigWarnings: no sudoers reader was given');
  const { lines, problems } = collect({ read, list }, root);
  const warnings = [...problems];
  if (lines.some((l) => /\bNOPASSWD\s*:/.test(l))) {
    warnings.push('sudo is configured NOPASSWD for some rule; the sudo gate does not ask for authentication there');
  }
  if (lines.some((l) => /^Defaults\S*\s.*!\s*authenticate\b/.test(l))) {
    warnings.push('sudo is configured with Defaults !authenticate; the sudo gate does not ask for authentication there');
  }
  for (const l of lines) {
    const m = /\btimestamp_timeout\s*=\s*(-?\d+(?:\.\d+)?)/.exec(l);
    if (!m) continue;
    const minutes = Number(m[1]);
    if (minutes < 0 || minutes > MAX_TIMESTAMP_MINUTES) {
      warnings.push(
        `sudo timestamp_timeout is ${m[1]}${minutes < 0 ? ' (never expires)' : ' minutes'}; above ${MAX_TIMESTAMP_MINUTES} the sudo gate means little`,
      );
      break;
    }
  }
  return warnings;
}
