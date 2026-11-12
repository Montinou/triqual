// The sessions store of the evals data: <evals>/sessions.jsonl, one line per sessionId, the signals of
// lib/eval-sessions.mjs plus `projectDir` and `refreshedAt`. node: built-ins only.
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir } from './eval-paths.mjs';
import { mainTranscripts, sessionSignals } from './eval-sessions.mjs';
import { withStoreLock } from './role-eval.mjs';

// { rows, skipped } of a JSONL file: the lines that parse to an object are rows, every other non-empty line (a torn
// last line included) is counted in `skipped`. A missing or unreadable file has none.
export function readJsonl(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { rows: [], skipped: 0 }; }
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try { row = JSON.parse(line); } catch { skipped += 1; continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped };
}

// Whether a transcript that ends at `end` is newer than the stored line that ends at `storedEnd`.
const grew = (end, storedEnd) => end !== null && (typeof storedEnd !== 'string' || end > storedEnd);

// Reads the main transcripts under `root` (outside the lock, so a slow scan never holds it), then merges them into
// `file` under the store lock: a new sessionId is added, a stored line is replaced when its transcript's `end` grew, a
// stored line whose transcript is gone stays. The file is rewritten through a temp file and a rename, so a reader
// sees the old store or the new one. { sessions: every stored line, added, updated, skipped: lines of the file that
// were not rows }.
export function refreshSessions({ root, file, prices, now = new Date() }) {
  const found = new Map();
  for (const t of mainTranscripts(root)) {
    const sig = { ...sessionSignals(t.file, { prices }), projectDir: t.projectDir };
    const prev = found.get(sig.sessionId);
    if (prev === undefined || grew(sig.end, prev.end)) found.set(sig.sessionId, sig);
  }
  const refreshedAt = new Date(now).toISOString();
  const dir = dirname(file);
  ensureDir(dir);
  return withStoreLock(join(dir, 'sessions.lock'), () => {
    const { rows, skipped: bad } = readJsonl(file);
    const stored = new Map();
    let skipped = bad;
    for (const r of rows) {
      if (typeof r.sessionId === 'string') stored.set(r.sessionId, r);
      else skipped += 1;
    }
    let added = 0;
    let updated = 0;
    for (const [id, sig] of found) {
      const cur = stored.get(id);
      if (cur === undefined) { stored.set(id, { ...sig, refreshedAt }); added += 1; }
      else if (grew(sig.end, cur.end)) { stored.set(id, { ...sig, refreshedAt }); updated += 1; }
    }
    if (added + updated > 0) {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, [...stored.values()].map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
        renameSync(tmp, file);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      chmodSync(file, 0o600);
    }
    return { sessions: [...stored.values()], added, updated, skipped };
  }, { waitMs: 30000 });
}

// The stored signals cut to the UTC days since..until (both included, either may be undefined): usd, turns, models and
// unpriced count only the turns of those days (the rule of `triqual cost`; a turn with no usable timestamp is in no
// day). null when the session has no turn in the window. The rest (start, end, context, compactions...) stays that of
// the whole session.
export function inWindow(sig, { since, until }) {
  const models = {};
  let usd = 0;
  let turns = 0;
  for (const [day, byModel] of Object.entries(sig.days ?? {})) {
    if ((since && day < since) || (until && day > until)) continue;
    for (const [model, m] of Object.entries(byModel)) {
      const t = models[model] ??= { messages: 0, usd: m.usd === null ? null : 0 };
      t.messages += m.messages;
      turns += m.messages;
      if (m.usd !== null) { t.usd += m.usd; usd += m.usd; }
    }
  }
  if (turns === 0) return null;
  const unpriced = Object.keys(models).filter((k) => models[k].usd === null).sort();
  return { ...sig, models, usd, turns, unpriced };
}
