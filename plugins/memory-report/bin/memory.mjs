#!/usr/bin/env node
// `triqual memory` / `memory.mjs`: the memory-report command line. Loads on Node 20 with node: built-ins only; lib/ is imported
// dynamically inside a try so a broken install prints one fixed line instead of a stack trace.
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage: triqual memory <command>

  allow <entry>...     add entries to the allowlist and print it
  allow --list         print the allowlist, one entry per line
  deny <entry>...      remove entries from the allowlist
  setup --suggest [--json]          list candidate projects from the last 30 days of notes
  setup --done [--no-client-terms]  mark the setup done (--no-client-terms: no client terms on purpose)
  setup --decline                   record that you declined the setup
  block <term>...      add client terms; a note containing one is never sent
  block --list         print the client terms, one per line
  unblock <term>...    remove client terms
  never <entry>...     add entries that are never sent
  never --list         print the never-send entries, one per line
  unnever <entry>...   remove entries from the never-send list
  status               show setup, the insights gate, the last run and the config warnings
  repos [--json]       show each project's repositories, the owners and the merge suggestions (printed, never run)
  report [--now]       show the latest report; --now builds one in the foreground (it can take a few minutes)
  entries: a name (acme), a repository (host/owner/name) or an owner (host/owner/*); allow, deny, never and unnever take all three, and a pasted URL is normalized
  --help               show this help
`;

// Collapses any run of whitespace or line breaks to one space, so a state value always prints on one line.
const oneLine = (value) => String(value).replace(/\s+/gu, ' ').trim();

// An untrusted string (a project name, folder, repository, owner or note) as text output shows it (repo-identity fix 1
// I1, Ruling 15): every C0 and C1 control character, DEL, the Unicode line and paragraph separators and the bidi and
// invisible format characters (U+061C, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF; the set merges.mjs's CONTROL
// refuses) in a visible escaped form (`\n`, `\r`, `\t`, `\xHH`, `\uHHHH`), and `\` as `\\`, so nothing can split a line,
// reorder or hide text or reach the terminal as an escape sequence, and a literal `\n` reads apart from an escaped one.
// Anything else is kept exactly. A printed command (`backslash: false`) keeps its backslashes: it only exists when none
// of its parts holds a CONTROL character, so the escaping leaves it unchanged and the shell reads it as written.
// JSON output stays raw: JSON.stringify escapes C0 controls, `"` and `\`, but not DEL, C1, U+2028, U+2029 or the format
// characters, which a JSON reader gets as data.
const ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\\': '\\\\' };
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\\]/g;
const visible = (value, { backslash = true } = {}) => String(value).replace(UNSEEN, (c) => {
  if (c === '\\' && !backslash) return c;
  if (Object.hasOwn(ESCAPES, c)) return ESCAPES[c];
  const code = c.charCodeAt(0);
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
});
const text = (value, fallback) => (typeof value === 'string' && value !== '' ? oneLine(value) : fallback);

// Edit commands over a config list: the key, what the list is called in the "missing" line, and the helpers.
const LIST_COMMANDS = {
  allow: { add: 'allowProjects' },
  deny: { remove: 'denyProjects', noun: 'the allowlist' },
  block: { add: 'blockTerms' },
  unblock: { remove: 'unblockTerms', noun: 'the client terms' },
  never: { add: 'neverProjects' },
  unnever: { remove: 'unneverProjects', noun: 'the never-send list' },
};
const LIST_VIEWS = { allow: 'allowlist', block: 'clientTerms', never: 'neverSend' };
const LIST_KEYS = { deny: 'allowlist', unblock: 'clientTerms', unnever: 'neverSend' };

// One stored element as `--list` prints it (repo-identity spec 4.5): a string as stored, anything else as JSON, and
// ` (invalid)` after an element that fails validation.
const shown = (value, valid) => `${typeof value === 'string' ? value : JSON.stringify(value)}${valid ? '' : ' (invalid)'}`;

// The removal fallback of each typed entry for `deny` and `unnever` (spec 4.1): [{ name, form, url, sshFailed }]. A
// remote URL goes through the async normalizeRemote (SSH hosts resolve through `ssh -G`, or `deps.sshHost` in tests),
// `form` null when it does not normalize; a repository-shaped entry through normalizeEntrySync; anything else keeps its
// typed form, for the sync edit to accept as a name or refuse. Runs one URL at a time, sharing one sshHost cache.
async function entryForms(names, { env, deps }) {
  const [entries, repo] = await Promise.all([import('../lib/entries.mjs'), import('../lib/repo.mjs')]);
  const sshHost = deps?.sshHost ?? repo.defaultSshHost({ run: deps?.run ?? repo.defaultRun({ envBase: deps?.envBase ?? env }) });
  const cache = new Map();
  const forms = [];
  for (const name of names) {
    if (entries.isUrlShaped(name)) {
      const { repo: form, sshFailed } = await repo.normalizeRemote(name, { sshHost, cache });
      forms.push({ name, form, url: true, sshFailed });
    } else forms.push({ name, form: entries.normalizeEntrySync(name) ?? name, url: false, sshFailed: false });
  }
  return forms;
}

// The stored forms of each typed entry for `allow` and `never` (spec 4.1 adding; final fix I1, Ruling 10 N2), resolved
// before anything is written: [{ name, forms }]. Throws a fixed message, writing nothing, when an argument cannot be
// stored as an entry that could ever match:
// - a remote URL (`://`, or the scp shape with or without `user@`) goes through normalizeRemote and loses a browser
//   file-view path (`/tree/…`, `/blob/…`, `/-/tree/…`); refused when it does not normalize;
// - a repository or owner entry on a host other than CANONICAL_HOSTS is resolved through `ssh -G` (deps.sshHost in
//   tests), as an SSH remote's host is: `github.com-work/client/*` is stored `github.com/client/*`; refused when ssh -G
//   fails. `never` also keeps the typed form when it differs, which can only block more (an https clone whose host is the
//   literal one); `allow` stores the resolved form only;
// - every stored repository or owner form must be a fixed point of normalizeEntrySync (`…/app.git.git` is refused);
// - anything else keeps its typed form, for the sync edit to accept as a name or refuse.
async function addForms(cmd, names, { env, deps }) {
  const [entries, repo] = await Promise.all([import('../lib/entries.mjs'), import('../lib/repo.mjs')]);
  const sshHost = deps?.sshHost ?? repo.defaultSshHost({ run: deps?.run ?? repo.defaultRun({ envBase: deps?.envBase ?? env }) });
  const cache = new Map();
  const resolveHost = (host) => {
    if (!cache.has(host)) cache.set(host, Promise.resolve().then(() => sshHost(host)).catch(() => null));
    return cache.get(host);
  };
  const stable = (form) => form !== null && entries.normalizeEntrySync(form) === form;
  const out = [];
  for (const [i, name] of names.entries()) {
    const n = i + 1;
    if (entries.isUrlShaped(name)) {
      const { repo: raw, sshFailed } = await repo.normalizeRemote(name, { sshHost, cache });
      if (raw === null) throw new Error(`argument ${n} is a remote URL that does not normalize to a repository${sshFailed ? ' (its SSH host did not resolve)' : ''}`);
      const form = entries.stripBrowserPath(raw);
      if (!stable(form)) throw new Error(`argument ${n} does not normalize to a stable entry`);
      out.push({ name, forms: [form] });
      continue;
    }
    const typed = entries.normalizeEntrySync(name);
    if (typed === null) {
      out.push({ name, forms: [name] });
      continue;
    }
    if (!stable(typed)) throw new Error(`argument ${n} does not normalize to a stable entry`);
    const slash = typed.indexOf('/');
    const host = typed.slice(0, slash);
    if (entries.CANONICAL_HOSTS.has(host)) {
      out.push({ name, forms: [typed] });
      continue;
    }
    const resolved = host.startsWith('-') ? null : await resolveHost(host);
    const form = typeof resolved === 'string' && resolved !== '' ? entries.normalizeEntrySync(`${resolved}${typed.slice(slash)}`) : null;
    if (!stable(form)) throw new Error(`argument ${n}: its host did not resolve through ssh -G to a usable host`);
    out.push({ name, forms: cmd === 'never' && form !== typed ? [typed, form] : [form] });
  }
  return out;
}

// Final fix I1: the typed arguments whose repository or owner forms match no repository recorded in repo-map.json (a
// typo, a browser URL, or a clone not seen yet). They are still added; the caller warns on stderr.
async function unmatched(paths, added) {
  const [entries, repo] = await Promise.all([import('../lib/entries.mjs'), import('../lib/repo.mjs')]);
  const map = repo.readRepoMap(paths);
  const known = Object.values(map?.folders ?? {}).flatMap((f) => f.repos.map((r) => r.repo));
  return added
    .filter(({ forms }) => forms.every((f) => ['repo', 'owner'].includes(entries.classifyEntry(f))))
    .filter(({ forms }) => !forms.some((f) => known.some((r) => entries.entryMatchesRepo(f, r))))
    .map(({ name }) => name);
}

// `setup` flags: exactly one mode, plus its own modifier (--json with --suggest, --no-client-terms with --done).
function parseSetup(args) {
  const known = new Set(['--suggest', '--json', '--done', '--no-client-terms', '--decline']);
  if (args.some((a) => !known.has(a))) return null;
  const has = (f) => args.includes(f);
  const modes = ['--suggest', '--done', '--decline'].filter(has);
  if (modes.length !== 1) return null;
  if (has('--json') && modes[0] !== '--suggest') return null;
  if (has('--no-client-terms') && modes[0] !== '--done') return null;
  return { mode: modes[0], json: has('--json'), noClientTerms: has('--no-client-terms') };
}

// `setup: done <date> | declined <date> | not set up`: declined when the decline is later than setupAt or there is no setupAt.
function setupLine({ setupAt, setupDeclinedAt }) {
  const day = (iso) => iso.slice(0, 10);
  if (setupDeclinedAt !== undefined && (setupAt === undefined || Date.parse(setupDeclinedAt) > Date.parse(setupAt))) return `setup: declined ${day(setupDeclinedAt)}`;
  if (setupAt !== undefined) return `setup: done ${day(setupAt)}`;
  return 'setup: not set up';
}

function statusLines(paths, config, state, lock) {
  let holder = 'none';
  if (lock === 'corrupt') holder = 'unreadable';
  else if (lock !== null) holder = `pid ${lock.pid} since ${oneLine(lock.startedAt)}`;
  const loaded = config.loadConfig(paths);
  const { warnings } = loaded;
  const gate = config.insightsGate(loaded.config, loaded.invalidKeys);
  return [
    `last success: ${text(state.lastSuccessAt, 'never')}`,
    `last attempt: ${text(state.lastAttemptAt, 'never')}`,
    `last error: ${text(state.lastError, 'none')}`,
    `lock holder: ${holder}`,
    setupLine(loaded.config),
    gate.open ? 'insights gate: open' : `insights gate: off (${gate.reason})`,
    `client terms: ${loaded.config.clientTerms.length}`,
    `never-send: ${loaded.config.neverSend.length}`,
    `allowlisted projects: ${loaded.config.allowlist.length}`,
    ...(warnings.length === 0 ? ['config warnings: none'] : ['config warnings:', ...warnings.map((w) => `  ${oneLine(w)}`)]),
  ];
}

// The latest report's path and summary line, or "no report yet". Without --now, `report` also marks it seen (spec 5, 8);
// after `report --now` it only prints, since seen.json is written by the plain read.
async function showReport(paths, stdout, { markSeen }) {
  const [state, render] = await Promise.all([import('../lib/state.mjs'), import('../lib/render.mjs')]);
  const { lastReportPath, lastSuccessAt, lastSummary } = state.readState(paths);
  if (typeof lastReportPath !== 'string' || lastReportPath === '') {
    stdout.write('no report yet\n');
    return 0;
  }
  stdout.write(`${oneLine(lastReportPath)}\n`);
  if (lastSummary !== null && typeof lastSummary === 'object') stdout.write(`${render.summaryLine(lastSummary, lastReportPath)}\n`);
  if (markSeen) state.writeSeen(paths, { seenReport: lastReportPath, seenSuccessAt: lastSuccessAt });
  return 0;
}

// Ruling 12: with an untrusted resolution and repository or owner never-send entries, setup lists no candidate and
// `triqual memory repos` prints no merge command (fix 1 M4).
export const IDENTITY_NOTE = 'Repository identity unavailable: no candidates are listed this run because never-send has repository or owner entries.';
const identityNoteLine = () => `memory-report: ${IDENTITY_NOTE.charAt(0).toLowerCase()}${IDENTITY_NOTE.slice(1)}\n`;

// Opens the sources read-only, resolves the repositories (writing only repo-map.json) and runs fn(ctx, mods); the
// sources are always closed. `deps` carries the resolution seams ({ run, sshHost, budgetMs, envBase }).
async function withResolvedSources(paths, config, { env, deps, nowMs }, fn) {
  const [sources, report, policy, suggest, merges] = await Promise.all([
    import('../lib/sources.mjs'), import('../lib/report.mjs'), import('../lib/policy.mjs'), import('../lib/suggest.mjs'),
    import('../lib/merges.mjs'),
  ]);
  const ctx = await sources.openSources(paths, config.loadConfig(paths).config, { ...deps?.sourcesOptions, now: () => nowMs });
  try {
    ctx.repos = await report.resolveForRun(paths, ctx, env, deps ?? {});
    return await fn(ctx, { policy, suggest, merges });
  } finally {
    sources.closeSources(ctx);
  }
}

// `setup --suggest | --done | --decline`. --suggest resolves the repositories (spec 5.1) and prints the candidates.
async function runSetup(paths, config, { mode, json, noClientTerms }, { env, stdout, stderr, deps }) {
  const nowMs = (deps?.now ?? Date.now)();
  if (mode === '--done') {
    config.markSetupDone(paths, { noClientTerms, nowIso: new Date(nowMs).toISOString() });
    return 0;
  }
  if (mode === '--decline') {
    config.markSetupDeclined(paths, { nowIso: new Date(nowMs).toISOString() });
    return 0;
  }
  if (!existsSync(paths.dbFile)) {
    stderr.write('memory-report: claude-mem.db not found\n');
    return 1;
  }
  const nowIso = new Date(nowMs).toISOString();
  const { result, hidden } = await withResolvedSources(paths, config, { env, deps, nowMs }, (ctx, { policy, suggest }) => ({
    result: suggest.suggestCandidates(ctx, { days: 30, commands: { env, nowIso } }),
    hidden: policy.identityUnavailable(ctx.config, ctx.repos),
  }));
  const shown = hidden ? { ...result, candidates: [], owners: [], merges: [], repos: { ...result.repos, unambiguous: 0 } } : result;
  if (json) {
    if (hidden) stderr.write(identityNoteLine());
    const { candidates, homeProject, owners, merges, repos } = shown;
    stdout.write(`${JSON.stringify({ candidates, homeProject, owners, merges, repos })}\n`);
  } else if (hidden) stdout.write(`${IDENTITY_NOTE}\n`);
  else shown.candidates.forEach((c, i) => stdout.write(`${i + 1}. ${visible(c.project)} — ${c.notes} notes — ${c.cwd === null ? 'no recorded folder' : visible(c.cwd)}\n`));
  return 0;
}

// A base project's effective status (0.3.1), from the real predicates over the same keys as its listed folders: the
// base and its worktree keys (`base/…`). Blocking always uses the run's resolution (`ctx.repos`): current evidence can
// only block more (fix round 2). The allow side uses `statusRepos`, the resolution the insights would use: the run's, or
// emptyRepos() when it is untrusted (fix round 1 Minor 2), so the status never says more than the next report sends.
// - never sent: the base or any of its worktree keys is blocked;
// - allowed by name: a name rule covers the base (and so its worktree keys);
// - allowed by repository: the base and every worktree key with folders are covered (`entry` the one allowlist entry
//   that matched the listed folders, else null);
// - otherwise not allowed.
function keyStatus(policy, ctx, statusRepos, project, cwds) {
  const { config } = ctx;
  const worktrees = [...ctx.repos.keys.keys()].filter((key) => typeof key === 'string' && key.startsWith(`${project}/`)).sort();
  if ([project, ...worktrees].some((key) => policy.isBlocked(key, null, config, ctx.repos))) return { status: 'never sent', entry: null };
  if (policy.allowedByNameKey(project, config)) return { status: 'allowed by name', entry: null };
  const withFolders = worktrees.filter((key) => (ctx.repos.keys.get(key)?.folders?.size ?? 0) > 0);
  if ([project, ...withFolders].every((key) => policy.isCoveredKey(key, null, config, statusRepos))) {
    const entries = policy.allowEntriesMatching(ctx.repos, cwds, config);
    return { status: 'allowed by repository', entry: entries.length === 1 ? entries[0] : null };
  }
  return { status: 'not allowed', entry: null };
}

// The `triqual memory repos` model: every base project with a recorded folder, its folders with their status and the
// repositories the map recorded for them (seenAt), the single repository it could be allowed by, and why it cannot be
// allowed by repository at all; its effective status and the repositories of its eligible folders that are not in the
// allowlist (`unlisted`, 0.3.1); `entry`, the one allowlist entry it is allowed by, is for the text line only and is left
// out of the JSON; plus the resolution counts, the owners and the merges of spec 5.1 and 5.4. Under Ruling 12
// (`hidden`) the merges keep their names but carry no commands; the statuses are still given.
function reposModel(ctx, { policy, suggest, merges }, map, { env, nowIso, emptyRepos }) {
  const hidden = policy.identityUnavailable(ctx.config, ctx.repos);
  const statusRepos = policy.reposUntrusted(ctx.repos) ? emptyRepos() : ctx.repos;
  const result = suggest.suggestCandidates(ctx, { days: 30, commands: { env, nowIso } });
  const keys = [];
  const bases = [...merges.foldersByBase(ctx.repos)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [project, cwds] of bases) {
    if (cwds.size === 0) continue;
    const sorted = [...cwds].sort();
    const reasons = [...new Set(sorted.flatMap((cwd) => policy.folderAllowBlockers(ctx.repos, cwd)))];
    const unlisted = [...new Set(sorted.flatMap((cwd) => policy.folderUnlistedRepos(ctx.repos, cwd, ctx.config)))].sort();
    const { status, entry } = keyStatus(policy, ctx, statusRepos, project, sorted);
    keys.push({
      project,
      repo: policy.allowRepoOf(ctx.repos, sorted),
      reasons,
      folders: sorted.map((cwd) => ({
        cwd,
        status: policy.folderStatus(ctx.repos, cwd),
        repos: (map?.folders?.[cwd]?.repos ?? []).map(({ repo, seenAt }) => ({ repo, seenAt })),
      })),
      status,
      unlisted,
      entry,
    });
  }
  const { resolved, withCwd, complete } = result.repos;
  const shownMerges = hidden ? result.merges.map((m) => ({ ...m, commands: null })) : result.merges;
  return { hidden, model: { resolved, withCwd, complete, keys, owners: result.owners, merges: shownMerges } };
}

// A key's text line (0.3.1): `<project> — <status>`, the one matched allowlist entry in parentheses after `allowed by
// repository`, and otherwise `; not by repository: <reasons>` when there are any: the folder blockers, then each
// unlisted repository as `<repo> is not in the allowlist`. Every untrusted string goes through `visible`.
function keyLine(key) {
  let line = `${visible(key.project)} — ${key.status}`;
  if (key.status === 'allowed by repository') return key.entry === null ? line : `${line} (${visible(key.entry)})`;
  const reasons = [...key.reasons, ...key.unlisted.map((repo) => `${visible(repo)} is not in the allowlist`)];
  if (reasons.length > 0) line += `; not by repository: ${reasons.join('; ')}`;
  return line;
}

// The text form of the `triqual memory repos` model; names are POSIX-quoted with merges.shellQuote, and every untrusted
// string goes through `visible`. A command line only exists when none of its parts holds a merges.mjs CONTROL character
// (the set `visible` escapes besides `\`), so `visible` without its backslash escape leaves it unchanged and a name
// holding a `\` still prints a command the shell reads back exactly.
function reposText(model, quote, hidden) {
  const out = [`resolved: ${model.resolved} of ${model.withCwd} keys (${model.complete ? 'complete' : 'partial'})`];
  if (hidden) out.push(IDENTITY_NOTE);
  for (const key of model.keys) {
    out.push(keyLine(key));
    for (const f of key.folders) {
      out.push(`  ${visible(f.cwd)} (${f.status})`);
      for (const r of f.repos) out.push(`    ${visible(r.repo)} (seen ${visible(r.seenAt)})`);
    }
  }
  if (model.owners.length === 0) out.push('owners: none');
  else {
    out.push('owners:');
    for (const o of model.owners) out.push(`  ${visible(o.owner)} — ${o.projects} projects — ${o.notes} notes`);
  }
  if (model.merges.length === 0) out.push('merges: none');
  else {
    out.push('merges:');
    for (const m of model.merges) {
      let line = `  ${visible(m.repo)}: into ${visible(quote(m.into))}`;
      if (m.from.length > 0) line += ` from ${m.from.map((n) => visible(quote(n))).join(', ')}`;
      if (m.worktrees.length > 0) line += `; worktrees ${m.worktrees.map((n) => visible(quote(n))).join(', ')}`;
      if (m.stranded > 0) line += `; stranded ${m.stranded}`;
      out.push(line);
      if (m.commands !== null) for (const c of [m.commands.backup, ...m.commands.dryRun, ...m.commands.run]) out.push(`    ${visible(c, { backslash: false })}`);
      if (m.note !== null) out.push(`    note: ${visible(m.note)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// `triqual memory repos [--json]` (spec 5.2): resolves and persists the map, then prints the model. Exit 1 when claude-mem's
// database is missing or the resolution fails.
async function runRepos(paths, config, { json }, { env, stdout, stderr, deps }) {
  if (!existsSync(paths.dbFile)) {
    stderr.write('memory-report: claude-mem.db not found\n');
    return 1;
  }
  const nowMs = (deps?.now ?? Date.now)();
  const repo = await import('../lib/repo.mjs');
  const built = await withResolvedSources(paths, config, { env, deps, nowMs }, (ctx, mods) => {
    if (ctx.repos.error !== null && ctx.repos.error !== undefined) return null;
    return {
      ...reposModel(ctx, mods, repo.readRepoMap(paths), { env, nowIso: new Date(nowMs).toISOString(), emptyRepos: repo.emptyRepos }),
      quote: mods.merges.shellQuote,
    };
  });
  if (built === null) {
    stderr.write('memory-report: the repositories could not be resolved\n');
    return 1;
  }
  if (json) {
    if (built.hidden) stderr.write(identityNoteLine());
    // `entry` is for the text line only: the JSON keys keep their fields plus `status` and `unlisted`.
    stdout.write(`${JSON.stringify({ ...built.model, keys: built.model.keys.map(({ entry, ...key }) => key) })}\n`);
  } else stdout.write(reposText(built.model, built.quote, built.hidden));
  return 0;
}

// Runs the command line; resolves to the exit code. `deps` ({ runner, sourcesOptions, now, nodeVersion, isAlive }) is
// handed to runReport, and as its `deps` too ({ run, sshHost, budgetMs, envBase } for the repository resolution);
// tests use it to fake the child `claude`, the clock, git and ssh.
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, deps } = {}) {
  const [cmd, ...args] = argv;
  if (cmd === '--help' || cmd === '-h') {
    stdout.write(USAGE);
    return 0;
  }
  const noArgs = args.length === 0;
  const valid = cmd === 'allow' || cmd === 'deny' || cmd in LIST_COMMANDS
    || (cmd === 'setup' && parseSetup(args) !== null)
    || ((cmd === 'status' || cmd === 'generate') && noArgs)
    || (cmd === 'repos' && (noArgs || (args.length === 1 && args[0] === '--json')))
    || (cmd === 'report' && (noArgs || (args.length === 1 && args[0] === '--now')));
  if (!valid) {
    stderr.write(USAGE);
    return 1;
  }
  let config;
  try {
    config = await import('../lib/config.mjs');
  } catch {
    stderr.write('memory-report: cannot load its modules\n');
    return 1;
  }
  const paths = config.resolvePaths(env, env.HOME || undefined);
  try {
    if (cmd === 'status') {
      const state = await import('../lib/state.mjs');
      let lock = null;
      try {
        lock = state.readLock(paths);
      } catch {
        lock = 'corrupt';
      }
      stdout.write(`${statusLines(paths, config, state.readState(paths), lock).join('\n')}\n`);
      return 0;
    }
    if (cmd === 'report' && noArgs) return await showReport(paths, stdout, { markSeen: true });
    if (cmd === 'report' || cmd === 'generate') {
      const { runReport } = await import('../lib/report.mjs');
      // A foreground run is silent for minutes (the real database took 155 s); say so on stderr so a caller does not
      // take the silence for a hang. `generate` is the hook's detached child and stays silent.
      if (cmd === 'report') stderr.write('memory-report: generating the report, this can take a few minutes…\n');
      const code = await runReport({ paths, env, mode: cmd === 'generate' ? 'generate' : 'now', ...deps, deps });
      if (cmd === 'report') {
        if (code === 0) await showReport(paths, stdout, { markSeen: false });
        else stderr.write(code === 2 ? 'memory-report: another run holds the lock\n' : 'memory-report: run failed (triqual memory status)\n');
      }
      return code;
    }
    if (cmd in LIST_VIEWS && args.includes('--list')) {
      for (const { value, valid } of config.listEntries(paths, LIST_VIEWS[cmd])) stdout.write(`${shown(value, valid)}\n`);
      return 0;
    }
    if (cmd === 'setup') return await runSetup(paths, config, parseSetup(args), { env, stdout, stderr, deps });
    if (cmd === 'repos') return await runRepos(paths, config, { json: args.includes('--json') }, { env, stdout, stderr, deps });
    const names = args.map((a) => a.trim()).filter(Boolean);
    if (names.length === 0 || names.some((n) => n.startsWith('--'))) {
      stderr.write(USAGE);
      return 1;
    }
    const key = LIST_VIEWS[cmd] ?? LIST_KEYS[cmd];
    const print = (list) => { for (const value of list) stdout.write(`${shown(value, config.isValidElement(key, value))}\n`); };
    if (cmd === 'allow' || cmd === 'never') {
      const added = await addForms(cmd, names, { env, deps });
      print(config[LIST_COMMANDS[cmd].add](paths, added.flatMap((a) => a.forms)));
      for (const name of await unmatched(paths, added)) stderr.write(`memory-report: no known repository matches ${visible(name)}; check it\n`);
      return 0;
    }
    if (cmd === 'block') {
      print(config.blockTerms(paths, names));
      return 0;
    }
    const { remove, noun } = LIST_COMMANDS[cmd];
    // A remote URL's normalized form comes from here (async); the sync edit normalizes a repository-shaped one itself.
    const urls = cmd === 'unblock' ? [] : (await entryForms(names, { env, deps })).filter((f) => f.url);
    const normalized = new Map(urls.map((f) => [f.name, f.form]));
    const { list, missing } = config[remove](paths, names, { normalized });
    print(list);
    if (missing.length > 0) stdout.write(`missing (not in ${noun}): ${missing.join(', ')}\n`);
    return 0;
  } catch (err) {
    stderr.write(`memory-report: ${err.message}\n`);
    return 1;
  }
}

const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isEntry) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
