// The six host probes `fence doctor` takes (doctor.mjs), over the real host CLIs.
//
//   createProbes({run, env, home, readText?, claudePath?, codexPath?, timeoutMs?}) -> {
//     claudeVersion()           -> string | null     first line of `claude --version`
//     claudePluginEnabled()     -> boolean | null    `claude plugin list --json`: fence@triqual enabled
//     claudeMarketplaceSource() -> {kind, path?} | null   `claude plugin marketplace list --json`
//     codexBridgeInstalled()    -> boolean | null    `codex plugin list --json`: fence-codex@triqual
//     codexHooksFeature()       -> boolean | null    `codex features list`: the `hooks` row
//     codexHooksTrusted()       -> boolean | null    <home>/.codex/config.toml trust records
//   }
//
// Every probe answers null ("could not verify": doctor reports unknown, never a failure) when the CLI
// is not an absolute executable found on env.PATH, the run fails, times out or throws, or the answer
// is not the shape expected. Each CLI is run once per probe through the injected `run` (the wiring
// passes captureRun); nothing here writes anything, and fence never edits host configuration.
//
// The marketplace probe maps Claude's marketplace `source` field (github, git, url, directory, file)
// to the probe's {kind} (any other value is null, "could not verify"); for a directory or file source
// it adds the `path`. Doctor fails a fence
// plugin served from a directory or file (its hooks.json then sits outside the protected paths).
// codexHooksTrusted needs the bridge's hook entries in `[hooks.state."<plugin>:<hooks file>:<event>:<i>:<j>"]`
// tables with a `trusted_hash`: trusted when there is at least one fence-codex entry and every one has
// a hash (Codex keeps no other trust record, and never runs an untrusted hook). `home` is the host's
// home directory, never $HOME.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { findOnPath } from './install.mjs';

export const CLAUDE_PLUGIN_ID = 'fence@triqual';
export const CLAUDE_MARKETPLACE = 'triqual';
export const CODEX_BRIDGE_ID = 'fence-codex@triqual';
export const PROBE_TIMEOUT_MS = 30_000;

const PATH_KINDS = new Set(['directory', 'file']);

const MARKETPLACE_KINDS = Object.freeze({ github: 'github', git: 'git', url: 'url', directory: 'directory', file: 'file' });

// Claude's marketplace `source` value -> the probe's kind: one of github, git, url, directory, file;
// anything else (an unknown value, text that is not exactly one of them, not text at all) is null,
// "could not verify".
export function marketplaceKind(source) {
  return typeof source === 'string' && Object.hasOwn(MARKETPLACE_KINDS, source) ? MARKETPLACE_KINDS[source] : null;
}

// `config.toml` text -> Map<hook key, trusted>: the keys of the `[hooks.state."<key>"]` tables, each
// true when the table holds a `trusted_hash = "..."`.
export function parseCodexHookTrust(text) {
  const out = new Map();
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      const m = /^hooks\.state\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(header[1].trim());
      current = m ? (m[1] ?? m[2]) : null;
      if (current !== null && !out.has(current)) out.set(current, false);
      continue;
    }
    if (current !== null && /^trusted_hash\s*=\s*["'][^"']+["']/.test(line)) out.set(current, true);
  }
  return out;
}

export function createProbes({ run, env = process.env, home, readText = (f) => nodeFs.readFileSync(f, 'utf8'), claudePath, codexPath, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof run !== 'function') throw new Error('createProbes: no process runner was given');

  // stdout of `<program> <args>` when it exits 0, else null.
  const stdoutOf = (name, explicit, args) => {
    const program = explicit ?? findOnPath(name, env?.PATH);
    if (typeof program !== 'string' || !nodePath.isAbsolute(program)) return null;
    let r;
    try {
      r = run(program, args, { encoding: 'utf8', timeout: timeoutMs });
    } catch {
      return null;
    }
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  };
  const jsonOf = (name, explicit, args) => {
    const out = stdoutOf(name, explicit, args);
    if (out === null) return null;
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  };
  const claude = (args) => stdoutOf('claude', claudePath, args);
  const claudeJson = (args) => jsonOf('claude', claudePath, args);
  const codexJson = (args) => jsonOf('codex', codexPath, args);

  return {
    claudeVersion() {
      const out = claude(['--version']);
      const line = out === null ? '' : out.split(/\r?\n/)[0].trim();
      return line === '' ? null : line;
    },

    claudePluginEnabled() {
      const list = claudeJson(['plugin', 'list', '--json']);
      if (!Array.isArray(list)) return null;
      return list.some((p) => p && p.id === CLAUDE_PLUGIN_ID && p.enabled === true);
    },

    claudeMarketplaceSource() {
      const list = claudeJson(['plugin', 'marketplace', 'list', '--json']);
      if (!Array.isArray(list)) return null;
      const market = list.find((m) => m && m.name === CLAUDE_MARKETPLACE);
      if (!market) return null;
      const kind = marketplaceKind(market.source);
      if (kind === null) return null;
      return PATH_KINDS.has(kind) && typeof market.path === 'string' ? { kind, path: market.path } : { kind };
    },

    codexBridgeInstalled() {
      const list = codexJson(['plugin', 'list', '--json']);
      if (list === null || typeof list !== 'object' || !Array.isArray(list.installed)) return null;
      return list.installed.some((p) => p && p.pluginId === CODEX_BRIDGE_ID && p.installed === true && p.enabled !== false);
    },

    codexHooksFeature() {
      const out = stdoutOf('codex', codexPath, ['features', 'list']);
      if (out === null) return null;
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] === 'hooks') return cols.at(-1) === 'true' ? true : cols.at(-1) === 'false' ? false : null;
      }
      return null;
    },

    codexHooksTrusted() {
      let text;
      try {
        text = readText(nodePath.join(home, '.codex', 'config.toml'));
      } catch (err) {
        return err?.code === 'ENOENT' ? false : null;
      }
      const prefix = `${CODEX_BRIDGE_ID}:`;
      const mine = [...parseCodexHookTrust(text)].filter(([key]) => key.startsWith(prefix));
      return mine.length > 0 && mine.every(([, trusted]) => trusted);
    },
  };
}
