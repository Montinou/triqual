// `fence uninstall [--purge]` (spec, "CLI").
//
//   uninstall({home, run, env?, purge?, io?, claudePath?, codexPath?, adminDir?, lockedDir?})
//     -> Promise<{ok, removed, manual, warnings, kept, stopped?, reason?}>
//
// Removes, in this order: the Claude Code plugin (`claude plugin uninstall fence@triqual`) and the
// Codex bridge (`codex plugin remove fence-codex@triqual`), each through its CLI when that CLI is
// present (found as an absolute path on env.PATH, or passed as claudePath / codexPath), run through
// the injected `run`; then the watchdog (the trampoline ~/.local/bin/fence-hook and the bundle
// ~/.local/share/fence/fence-hook.mjs), the shim (~/.local/bin/fence and fence-cli.mjs), `current`,
// git.json, versions/, the recorded smoke result and the leftovers an interrupted install or upgrade
// leaves (.staging-*, .old-* in versions/, *.bak-* and *.tmp-* beside the launchers). The policy
// (~/.config/fence) and the state (logs, keep files, health) are kept unless `purge`.
//
// A host CLI that is present and fails (a non-zero exit, a signal or a throw from the runner) STOPS
// the uninstall before anything is removed: the plugin's hooks are still registered, and a hook
// whose launcher is gone denies every call (spec, "Watchdog"), so removing the launcher then would
// lock the host up. The result is ok:false with `stopped: true`, the step to run by hand and a
// message saying the hooks are still registered; running uninstall again after fixing it finishes
// the job. A CLI that is absent is skipped and its command is printed for the human.
//
// Anything else it can not do itself is returned in `manual` and printed through io.out: the Codex
// trust records of the fence hooks (Codex keeps them in its own config, and fence never edits Codex
// configuration), the root-owned directories (the admin directory on purge, the locked-mode copy).
// A directory it could not remove (non-empty) or an entry that failed to go is reported in
// `warnings`. After a complete uninstall it prints that Claude Code and Codex must be restarted.
//
// Uninstall weakens fence, so the command table (humanonly.mjs) runs requireHuman and the sudo gate
// before this implementation; it does not repeat them. Nothing outside the fence paths derived from
// `home` is touched; adminDir and lockedDir are only looked at (they are root-owned).

import nodeFs from 'node:fs';
import nodePath from 'node:path';

import { errText, failed, findOnPath } from './install.mjs';
import { fencePaths } from './paths.mjs';

export const CLAUDE_PLUGIN = 'fence@triqual';
export const CODEX_BRIDGE = 'fence-codex@triqual';
export const RESTART_NOTICE = 'Restart Claude Code and Codex so they stop using the fence hooks.';
const CLI_TIMEOUT_MS = 120_000;
// What an interrupted install or upgrade leaves beside the installed files.
const LEFTOVER = /\.(?:bak|tmp)-/;

function isLink(file) {
  try {
    return nodeFs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function uninstall({
  home,
  run,
  env = process.env,
  purge = false,
  io,
  claudePath,
  codexPath,
  adminDir,
  lockedDir,
} = {}) {
  if (typeof run !== 'function') throw new Error('uninstall: no process runner was given');
  let paths;
  try {
    paths = fencePaths(home);
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
  const admin = adminDir === undefined ? paths.adminDir : adminDir;
  const locked = lockedDir === undefined ? paths.lockedDir : lockedDir;
  const removed = [];
  const manual = [];
  const warnings = [];
  const say = (line) => {
    if (typeof io?.out === 'function') io.out(line);
  };

  // 1 and 2: the host registrations, through their CLIs
  const hostFailures = [];
  const viaCli = (label, name, explicit, args) => {
    const cli = explicit ?? findOnPath(name, env?.PATH);
    const command = `${name} ${args.join(' ')}`;
    if (!cli) {
      manual.push(`${label}: the ${name} CLI was not found on PATH; run \`${command}\` yourself.`);
      return;
    }
    let r;
    try {
      r = run(cli, args, { cwd: paths.home, env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
    } catch (err) {
      r = { error: err instanceof Error ? err : new Error(String(err)) };
    }
    const f = failed(r);
    if (f) {
      const detail = r?.stderr ? `: ${String(r.stderr).trim().split('\n').slice(-1)[0].slice(0, 200)}` : '';
      const step = `${label}: \`${command}\` failed (${f}${detail}); run it yourself.`;
      manual.push(step);
      hostFailures.push(step);
      return;
    }
    say(`${label}: ran \`${command}\`.`);
  };
  viaCli('Claude Code', 'claude', claudePath, ['plugin', 'uninstall', CLAUDE_PLUGIN]);
  viaCli('Codex', 'codex', codexPath, ['plugin', 'remove', CODEX_BRIDGE]);
  if (hostFailures.length > 0) {
    const reason = `uninstall stopped before removing anything: ${hostFailures.length} host plugin step(s) failed, so the fence hooks are still registered and removing the launcher now would make them deny every call; fix the step(s) below and run fence uninstall again`;
    say(reason);
    for (const m of manual) say(m);
    return { ok: false, stopped: true, reason, removed, manual, warnings, kept: [] };
  }
  manual.push(
    `Codex: fence can not remove the trust records of its hooks; delete the fence hook entries from the trust state in ${nodePath.join(paths.home, '.codex', 'config.toml')}, and turn the hooks feature off there if nothing else needs it.`,
  );

  // 3: the installed files
  let failedRemovals = 0;
  const remove = (file, { recursive = false } = {}) => {
    try {
      if (!nodeFs.existsSync(file) && !isLink(file)) return;
      nodeFs.rmSync(file, { recursive, force: true });
      removed.push(file);
    } catch (err) {
      failedRemovals += 1;
      warnings.push(`removing ${file} failed: ${errText(err)}`);
    }
  };
  // leftovers of an interrupted install or upgrade: `<managed name>.bak-*` / `.tmp-*` beside it
  const removeLeftovers = (dir, names) => {
    let entries = [];
    try {
      entries = nodeFs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const i = e.search(LEFTOVER);
      if (i > 0 && names.has(e.slice(0, i))) remove(nodePath.join(dir, e));
    }
  };
  for (const file of [paths.watchdog, paths.watchdogBundle, paths.shim, paths.shimModule, paths.current, paths.gitPin]) remove(file);
  remove(paths.versionsDir, { recursive: true }); // takes .staging-* and .old-* with it
  remove(paths.smokeResult);
  const base = (f) => nodePath.basename(f);
  removeLeftovers(paths.binDir, new Set([base(paths.watchdog), base(paths.shim)]));
  removeLeftovers(paths.shareDir, new Set([base(paths.watchdogBundle), base(paths.shimModule), base(paths.current), base(paths.gitPin)]));
  removeLeftovers(paths.stateDir, new Set([base(paths.smokeResult)]));
  removeLeftovers(paths.configDir, new Set([base(paths.policy)]));
  try {
    nodeFs.rmdirSync(paths.shareDir);
    removed.push(paths.shareDir);
  } catch (err) {
    if (err?.code === 'ENOTEMPTY' || err?.code === 'EEXIST') {
      let left = [];
      try {
        left = nodeFs.readdirSync(paths.shareDir);
      } catch {
        // reported without the listing
      }
      warnings.push(`${paths.shareDir} was not removed: it is not empty${left.length ? ` (${left.slice(0, 8).join(', ')})` : ''}; remove what is left of it yourself`);
    } else if (err?.code !== 'ENOENT') {
      warnings.push(`removing ${paths.shareDir} failed: ${errText(err)}`);
    }
  }

  // 4: the policy and the state
  const kept = [];
  if (purge) {
    remove(paths.configDir, { recursive: true });
    remove(paths.stateDir, { recursive: true });
    if (admin && nodeFs.existsSync(admin)) {
      manual.push(`The admin directory ${admin} (hatch, integrity manifest, grants) is root-owned; remove it yourself with \`sudo rm -rf ${admin}\`.`);
    }
  } else {
    kept.push(paths.policy, paths.stateDir);
    say(`Kept the policy ${paths.policy} and the state and logs in ${paths.stateDir}; run fence uninstall --purge to remove them.`);
  }
  if (locked && nodeFs.existsSync(locked)) {
    manual.push(`The locked-mode copy ${locked} is root-owned; remove it yourself with \`sudo rm -rf ${locked}\`.`);
  }

  for (const w of warnings) say(`warning: ${w}`);
  for (const m of manual) say(m);
  say(RESTART_NOTICE);
  return { ok: failedRemovals === 0, removed, manual, warnings, kept, notice: RESTART_NOTICE };
}
