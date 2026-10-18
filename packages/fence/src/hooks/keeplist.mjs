// Compaction keep-list (spec, "Compaction keep-list and session start").
//
//   renderKeepList(policy, {profile}) -> string
//   keepFileName(sessionId) -> '<session>.md' | null
//   writeKeepList(stateDir, sessionId, text, {fs, sha}) -> {ok: boolean, reason?: string}
//   readKeepSnapshot(stateDir, sessionId, {fs}) -> {sha, text} | null
//
// The keep-list is the rule text of the policy as the model should still see it after a compaction:
// the active profile (name capped at 64 characters), the protected branches and `denyFileWrites`, one line
// for the built-ins (these three come first and are always kept whole), then one line per rule
// (`id: decision match-summary — why`). At most KEEP_CAP (2000) characters; the rule lines get what the fixed
// lines leave. When they do not fit, the longest `why` is shortened first (repeatedly), then the longest
// match summary (which leaves bare `id: decision` lines); then one `rules:` line of ids; when even that
// does not fit, as many `id: decision` lines as fit are kept in policy order and one last line counts the
// rest (`… and N more rules (run fence check to list them)`). The final hard cut of the whole text is
// reached only when the fixed lines alone exceed the cap (an absurd policy, such as thousands of protected
// branches), and then it cuts the end of the text.
//
// PreCompact (engine `precompact`) writes the rendering to <stateDir>/keep/<session_id>.md. The session id
// comes from an untrusted payload and becomes a file name only when it is a plain identifier; anything
// else writes nothing. The write goes to a temp name in the same directory and is renamed into place, so
// a reader never sees a partial file; keep/ must be a real directory (never a symlink). Nothing in
// writeKeepList throws.
//
// The snapshot file is a header line `fence-policy-sha256: <64 hex>` (the sha256 of the policy file the
// rendering came from, when the caller gives it) followed by the rendering. SessionStart on `compact` reads
// it back with readKeepSnapshot(stateDir, sessionId) -> {sha: string | null, text} | null (null: no safe id,
// no snapshot, or one that is not a small regular file) and compares the sha with the current policy's.
// KEEP_NAME / KEEP_TMP are the file-name shapes of a snapshot and of the temp file of an unfinished write:
// the only names the retention prune (log/prune.mjs) removes from keep/.

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { randomBytes } from 'node:crypto';

export const KEEP_CAP = 2000;
export const KEEP_DIR = 'keep';
export const SNAPSHOT_SHA_HEADER = 'fence-policy-sha256: ';
export const KEEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;
export const KEEP_TMP = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md\.\d+\.[0-9a-f]{12}\.tmp$/;
// A snapshot is at most KEEP_CAP characters of rendering plus the header; a larger file is not one.
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

const ELLIPSIS = '…';
const PROFILE_NAME_CAP = 64;
// A session id: letters, digits, `_`, `-` and inner dots; never leading dot, no `..`, at most 128 characters.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const BUILTINS_LINE =
  'built-ins: the fence policy, state, install and admin directories, host settings and plugin directories, and the fence, claude and codex commands that change them are self-protected and cannot be changed through the agent.';

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const list = (xs, sep) => xs.map(oneLine).join(sep);

export function keepFileName(sessionId) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId) || sessionId.includes('..')) return null;
  return `${sessionId}.md`;
}

// Cuts `s` to `n` characters including the ellipsis, never splitting a surrogate pair.
function shorten(s, n) {
  if (n <= 0) return '';
  if (n === 1) return ELLIPSIS;
  let head = s.slice(0, n - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head + ELLIPSIS;
}

function matchSummary(rule) {
  const m = rule.match ?? {};
  const out = [];
  if (m.class) out.push(`class=${list(m.class, ',')}`);
  if (m.paths) out.push(`paths(${m.access ?? 'any'})=${list(m.paths, ',')}`);
  if (m.argv) out.push(`argv=${m.argv.map((p) => JSON.stringify(p.join(' '))).join('|')}`);
  if (m.mcp) out.push(`mcp=${list(m.mcp, ',')}`);
  if (m.domains) out.push(`domains=${list(m.domains, ',')}`);
  if (rule.except?.paths) out.push(`except paths=${list(rule.except.paths, ',')}`);
  if (rule.except?.domains) out.push(`except domains=${list(rule.except.domains, ',')}`);
  return oneLine(out.join(' '));
}

// One shrinking step: the longest of `cur` is shortened (from its `full` text) by `excess` characters, but
// not below the second longest, so repeated steps level the longest down first. Returns false when every
// entry is already empty.
function shrinkLongest(cur, full, excess) {
  let longest = -1;
  let second = 0;
  cur.forEach((w, i) => {
    if (longest === -1 || w.length > cur[longest].length) {
      if (longest !== -1) second = Math.max(second, cur[longest].length);
      longest = i;
    } else {
      second = Math.max(second, w.length);
    }
  });
  if (longest === -1 || cur[longest].length === 0) return false;
  const len = cur[longest].length;
  let target = Math.max(len - excess, second);
  if (target >= len) target = len - 1;
  cur[longest] = shorten(full[longest], target);
  return true;
}

// The lines that fit `budget` characters when the rules are cut to bare `id: decision` lines: as many as fit
// in policy order, then one line counting the rest. [] when not even the count line fits.
function truncateBare(bare, budget) {
  for (let k = bare.length - 1; k >= 0; k--) {
    const lines = [...bare.slice(0, k), `${ELLIPSIS} and ${bare.length - k} more rules (run fence check to list them)`];
    if (lines.join('\n').length <= budget) return lines;
  }
  return [];
}

export function renderKeepList(policy, { profile = 'default', cap = KEEP_CAP } = {}) {
  const profiles = policy?.profiles ?? {};
  const prof = Object.hasOwn(profiles, profile) ? profiles[profile] : null;
  let profileName = oneLine(profile);
  if (profileName.length > PROFILE_NAME_CAP) profileName = shorten(profileName, PROFILE_NAME_CAP);
  const head =
    prof === null
      ? `fence policy, profile ${profileName} (not defined by this policy)`
      : `fence policy, profile ${profileName} (undecided: ${prof.undecided})`;

  const branches = policy?.branches ?? {};
  const protectedBranches = Array.isArray(branches.protected) ? branches.protected : [];
  const tail = [
    `protected branches: ${protectedBranches.length === 0 ? '(none)' : list(protectedBranches, ', ')}; denyFileWrites: ${branches.denyFileWrites === true}`,
    BUILTINS_LINE,
  ];

  const rules = Array.isArray(policy?.rules) ? policy.rules : [];
  const ids = rules.map((r) => oneLine(r.id));
  const decisions = rules.map((r) => oneLine(r.decision));
  const sumFull = rules.map(matchSummary);
  const whyFull = rules.map((r) => oneLine(r.why));
  const sums = sumFull.slice();
  const whys = whyFull.slice();

  // The head, the protected-branches line and the built-ins line come first and are always whole; the rule
  // lines get what is left of the cap (after the newline that joins them to the fixed lines).
  const fixed = [head, ...tail].join('\n');
  const budget = cap - fixed.length - 1;
  const size = (lines) => lines.join('\n').length;
  const fullLines = () =>
    ids.map((id, i) => {
      const s = sums[i] === '' ? '' : ` ${sums[i]}`;
      const w = whys[i] === '' ? '' : ` — ${whys[i]}`;
      return `${id}: ${decisions[i]}${s}${w}`;
    });

  let lines = [];
  if (ids.length > 0 && budget > 0) {
    lines = fullLines();
    while (size(lines) > budget && shrinkLongest(whys, whyFull, size(lines) - budget)) lines = fullLines();
    while (size(lines) > budget && shrinkLongest(sums, sumFull, size(lines) - budget)) lines = fullLines();
    // Both loops end only when every why and summary is empty, so `lines` is now the bare `id: decision` set.
    if (size(lines) > budget) {
      const idLine = [`rules: ${ids.join(',')}`]; // every id on one line
      lines = size(idLine) <= budget ? idLine : truncateBare(lines, budget);
    }
  }
  const text = [fixed, ...lines].join('\n');
  return text.length > cap ? shorten(text, cap) : text;
}

function isRealDir(fsImpl, dir) {
  const st = fsImpl.lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink();
}

// -> {sha, text} | null. `sha` is null when the file has no header (or an unreadable one).
export function readKeepSnapshot(stateDir, sessionId, { fs: fsImpl = nodeFs } = {}) {
  try {
    const name = keepFileName(sessionId);
    if (name === null) return null;
    const dir = nodePath.join(stateDir, KEEP_DIR);
    if (!isRealDir(fsImpl, dir)) return null;
    const file = nodePath.join(dir, name);
    // One open descriptor decides everything: no symlink is followed (O_NOFOLLOW) and a FIFO does not block
    // the open (O_NONBLOCK); the type and size come from fstat of that descriptor, and at most one byte more
    // than the bound is read from it, so a file that grows after the check is still refused.
    const fd = fsImpl.openSync(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0));
    let content;
    try {
      const st = fsImpl.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null;
      const buf = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
      let n = 0;
      while (n < buf.length) {
        const got = fsImpl.readSync(fd, buf, n, buf.length - n, n);
        if (got === 0) break;
        n += got;
      }
      if (n > MAX_SNAPSHOT_BYTES) return null;
      content = buf.subarray(0, n).toString('utf8');
    } finally {
      fsImpl.closeSync(fd);
    }
    const nl = content.indexOf('\n');
    const first = nl < 0 ? content : content.slice(0, nl);
    if (first.startsWith(SNAPSHOT_SHA_HEADER)) {
      const sha = first.slice(SNAPSHOT_SHA_HEADER.length);
      if (HEX64.test(sha)) return { sha, text: nl < 0 ? '' : content.slice(nl + 1) };
    }
    return { sha: null, text: content };
  } catch {
    return null;
  }
}

export function writeKeepList(stateDir, sessionId, text, { fs: fsImpl = nodeFs, sha } = {}) {
  const name = keepFileName(sessionId);
  if (name === null) return { ok: false, reason: 'unsafe session id' };
  const content = typeof sha === 'string' && HEX64.test(sha) ? `${SNAPSHOT_SHA_HEADER}${sha}\n${text}` : text;
  let tmp = null;
  try {
    const dir = nodePath.join(stateDir, KEEP_DIR);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!isRealDir(fsImpl, dir)) return { ok: false, reason: `${KEEP_DIR} is not a real directory` };
    tmp = nodePath.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    fsImpl.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    fsImpl.renameSync(tmp, nodePath.join(dir, name));
    return { ok: true };
  } catch (err) {
    if (tmp !== null) {
      try {
        fsImpl.unlinkSync(tmp);
      } catch {
        // best effort: the temp name never matches a snapshot name
      }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
