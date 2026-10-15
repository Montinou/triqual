// The Codex skill links and role agents (spec Addendum F.4, F.7): the part of `triqual sync` that the harness session
// refresh repeats, with no CLI call and no TTY. Both follow Claude's enabled state (user-scope enabledPlugins) and use
// the user-scope installs only. Each function edits the given manifest entry; the caller holds the manifest lock.
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BRAND } from './brand.mjs';
import { backupFile, sha256, writeAtomic } from './fsx.mjs';
import {
  codexAgentToml, CODEX_READONLY_REVIEWERS, CODEX_XHIGH, isGenerated, parseRole, rolesSha,
} from './agents.mjs';
import { forgetFile, forgetLink, recordFile, recordLink } from './harness-manifest.mjs';

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

// What is at `path`: missing, a symlink (its text, the absolute target, and whether it dangles) or something else.
export function linkState(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (!st.isSymbolicLink()) return { kind: 'other' };
  const text = readlinkSync(path);
  return { kind: 'link', text, abs: resolve(dirname(path), text), dangling: !existsSync(path) };
}

// Points `path` at `target` in one rename, replacing a link that is there.
export function placeLink(target, path) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

// True when `abs` lies in the cache of a plugin the supersedes patterns name: `<name>@*` matches any marketplace's
// `~/.claude/plugins/cache/<marketplace>/<name>/`, `<name>@<marketplace>` that marketplace's only.
export function inSupersededCache(home, abs, patterns) {
  const cache = join(home, '.claude', 'plugins', 'cache') + sep;
  if (!abs.startsWith(cache)) return false;
  const [market, name] = abs.slice(cache.length).split(sep);
  if (!market || !name) return false;
  return patterns.some((p) => typeof p === 'string'
    && (p.endsWith('@*') ? p.slice(0, -2) === name : p === `${name}@${market}`));
}

// name → target for the links we want: the methodology skills (every dir under its install's skills/) while it is
// enabled in Claude, and progress-tracking while that is. Doctor compares the links against the same map.
export function wantedLinks(installs) {
  const want = new Map();
  const m = installs.methodology;
  if (m?.enabled) {
    const names = readdirSync(join(m.installPath, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_NAME.test(d.name)).map((d) => d.name).sort();
    for (const name of names) want.set(name, join(m.installPath, 'skills', name));
  }
  const pt = installs['progress-tracking'];
  if (pt?.enabled) want.set('progress-tracking', join(pt.installPath, 'skills', 'progress-tracking'));
  return want;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The skill links in `dir` (spec F.4). Our link, or a missing one, is (re)pointed at the install; a dangling link, or
// one into a superseded plugin's cache (unless keepSuperseded), is replaced with its old target recorded; anything
// else is left alone and named in the detail. A superseded link with none of our names is removed too (only while
// methodology is enabled in Claude), and our recorded links whose plugin is disabled (or gone) in Claude are removed.
// Returns { status, detail }.
export function applyLinks({ home, dir, installs, supersedes, keepSuperseded }, entry) {
  const want = wantedLinks(installs);
  const superseded = (abs) => !keepSuperseded && inSupersededCache(home, abs, supersedes);
  const done = { linked: 0, repointed: 0, replaced: 0, superseded: 0, disabled: 0 };
  const leftAlone = [];
  if (want.size > 0) mkdirSync(dir, { recursive: true });
  for (const [name, target] of want) {
    const path = join(dir, name);
    const cur = linkState(path);
    const rec = entry.links.find((l) => l.path === path);
    if (cur.kind === 'link' && cur.text === target) {
      recordLink(entry, path, target);
    } else if (cur.kind === 'missing') {
      placeLink(target, path);
      recordLink(entry, path, target);
      done.linked += 1;
    } else if (cur.kind === 'link' && rec?.target === cur.text) {
      placeLink(target, path);
      recordLink(entry, path, target);
      done.repointed += 1;
    } else if (cur.kind === 'link' && (cur.dangling || superseded(cur.abs))) {
      placeLink(target, path);
      recordLink(entry, path, target, cur.text);
      done.replaced += 1;
    } else {
      leftAlone.push(name);
    }
  }
  // Superseded links are methodology's to remove: nothing is touched while it is disabled (or not installed) in Claude,
  // even when progress-tracking still wants its link.
  if (installs.methodology?.enabled && !keepSuperseded && existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (want.has(name)) continue;
      const path = join(dir, name);
      const cur = linkState(path);
      if (cur.kind !== 'link' || !superseded(cur.abs)) continue;
      unlinkSync(path);
      recordLink(entry, path, null, cur.text);
      done.superseded += 1;
    }
  }
  for (const rec of [...entry.links]) {
    if (rec.target === null || dirname(rec.path) !== dir || want.has(basename(rec.path))) continue;
    const cur = linkState(rec.path);
    if (cur.kind === 'link' && cur.text === rec.target) {
      unlinkSync(rec.path);
      done.disabled += 1;
    }
    forgetLink(entry, rec.path);
  }
  const parts = [];
  if (done.linked) parts.push(`linked ${done.linked}`);
  if (done.repointed) parts.push(`re-pointed ${done.repointed} to the installed version`);
  if (done.replaced) parts.push(`replaced ${done.replaced} dangling or superseded (old targets recorded)`);
  if (done.superseded) parts.push(`removed ${plural(done.superseded, 'superseded link')}`);
  if (done.disabled) parts.push(`removed ${done.disabled} whose plugin is disabled in Claude`);
  const changed = parts.length > 0;
  if (!changed) {
    parts.push(want.size > 0 ? `${plural(want.size - leftAlone.length, 'link')} current`
      : 'no skills to link: methodology and progress-tracking are disabled or not installed in Claude');
  }
  if (leftAlone.length) parts.push(`left alone (not ours): ${leftAlone.join(', ')}`);
  return { status: changed ? 'done' : 'already', detail: parts.join('; ') };
}

const isOurs = isGenerated;

// The Codex agent file triqual sync writes for `role` from the roles install `roles` (doctor compares against it).
export const codexAgentText = (role, roles) => codexAgentToml(role, {
  rolesVersion: roles.version, xhigh: CODEX_XHIGH, readOnly: CODEX_READONLY_REVIEWERS,
});

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Backs up (into backupDir) and removes every `.toml` in `dir` that carries our mark but is not in `shipped`, and
// forgets it in the manifest entry. A file without our mark is never touched. Returns the number removed.
function removeRetired(dir, shipped, backupDir, entry) {
  let removed = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.toml') && !shipped.has(f)).sort()) {
    const path = join(dir, file);
    if (!lstatSync(path).isFile()) continue;
    const text = readText(path);
    if (text === null || !isOurs(text)) continue;
    backupFile(path, backupDir);
    unlinkSync(path);
    forgetFile(entry, path);
    removed += 1;
  }
  return removed;
}

// The Codex role agents in `dir` (spec F.7), from the user-scope roles install, while methodology and roles are
// enabled in Claude: one `<name>.toml` per role, a file without our mark (new or legacy) backed up (into backupDir) and
// replaced. A `.toml` of ours (isGenerated) whose role is no longer shipped (safety-shadow after roles 0.3.0) is backed
// up and removed; any other file is never touched. Otherwise the agent files we recorded (and still carry our mark)
// are removed. Returns { status, detail }.
export function applyAgents({ dir, installs, backupDir }, entry) {
  const roles = installs.roles;
  if (!installs.methodology?.enabled || !roles?.enabled) {
    let removed = 0;
    for (const rec of [...entry.files]) {
      if (rec.sha256 === null || dirname(rec.path) !== dir) continue;
      const text = readText(rec.path);
      if (text !== null && isOurs(text)) {
        unlinkSync(rec.path);
        removed += 1;
      }
      forgetFile(entry, rec.path);
    }
    entry.rolesSha = null;
    if (!roles) {
      // Reported, not thrown: the removals above must still reach the manifest.
      const detail = 'roles is not installed at user scope: '
        + `run claude plugin install roles@${BRAND.marketplace} --scope user`;
      return { status: 'failed', detail: removed ? `${detail} (removed ${plural(removed, 'agent')})` : detail };
    }
    const why = 'methodology or roles is disabled in Claude';
    return removed ? { status: 'done', detail: `${why}: removed ${plural(removed, 'agent')}` }
      : { status: 'already', detail: `${why}: no agents` };
  }
  if (typeof roles.version !== 'string' || roles.version === '') {
    throw new Error('the roles install has no version in installed_plugins.json');
  }
  const agents = join(roles.installPath, 'agents');
  const files = readdirSync(agents).filter((f) => f.endsWith('.md')).sort();
  let written = 0;
  let replaced = 0;
  const shipped = new Set();
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const role = parseRole(readFileSync(join(agents, file), 'utf8'));
    if (!SAFE_NAME.test(role.name)) throw new Error(`role name not usable as a file name: ${role.name}`);
    shipped.add(`${role.name}.toml`);
    const text = codexAgentText(role, roles);
    const path = join(dir, `${role.name}.toml`);
    const current = readText(path);
    if (current === text) {
      recordFile(entry, path, sha256(text));
      continue;
    }
    let backup = null;
    if (current !== null && !isOurs(current)) {
      backup = backupFile(path, backupDir);
      replaced += 1;
    }
    writeAtomic(path, text);
    recordFile(entry, path, sha256(text), backup);
    written += 1;
  }
  const retired = removeRetired(dir, shipped, backupDir, entry);
  entry.rolesSha = rolesSha(agents);
  const gone = retired ? `removed ${plural(retired, 'agent')} no longer shipped` : '';
  if (!written) {
    const current = `${plural(files.length, 'agent')} current (roles ${roles.version})`;
    return retired ? { status: 'done', detail: `${gone}; ${current}` } : { status: 'already', detail: current };
  }
  const extra = (replaced ? `, ${replaced} hand-written backed up and replaced` : '') + (retired ? `, ${gone}` : '');
  return { status: 'done', detail: `wrote ${plural(written, 'agent')} from roles ${roles.version}${extra}` };
}
