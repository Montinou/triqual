// The reference reader of the evals: a model reads one session's rendered transcript and proposes the good/bad label and
// the failure categories present, once per session, into <evals>/review/reference.jsonl. acceptReference copies those
// proposals into the label files that nothing else has written. A session under the taxonomy's judgeExclude is never
// sent. node: built-ins only.
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { askModel, appendPrivate } from './eval-ask.mjs';
import { AuthError, ChainExhausted, childEnv, withChain } from './eval-auth.mjs';
import { loadJudgePrompt, renderForJudge } from './eval-judge.mjs';
import { ensureDir } from './eval-paths.mjs';
import { withStoreLock } from './role-eval.mjs';
import { readJsonl } from './eval-store.mjs';

const REASON_CHARS = 400;
const QUOTE_CHARS = 300;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const judgeCategories = (taxonomy) => taxonomy.categories.filter((c) => c.check === 'judge');

// loadJudgePrompt(file) with one line per judge category appended to the body, in taxonomy order. `hash` is the SHA-256 of
// that body and the model; `schema` is the JSON schema of the answer.
export function loadReferencePrompt(file, taxonomy) {
  const loaded = loadJudgePrompt(file);
  const cats = judgeCategories(taxonomy);
  const body = `${loaded.body.trimEnd()}\n\n${cats.map((c) => `- ${c.id} (${c.name}): ${c.definition}`).join('\n')}\n`;
  const ids = cats.map((c) => c.id);
  const one = { type: 'object', properties: { present: { type: 'boolean' }, quote: { type: 'string' } }, required: ['present', 'quote'], additionalProperties: false };
  const schema = {
    type: 'object',
    properties: {
      label: { type: 'string', enum: ['good', 'bad'] },
      reason: { type: 'string' },
      categories: { type: 'object', properties: Object.fromEntries(ids.map((id) => [id, one])), required: ids, additionalProperties: false },
    },
    required: ['label', 'reason', 'categories'],
  };
  return { model: loaded.model, body, hash: createHash('sha256').update(`${loaded.model}\n${body}`).digest('hex'), schema };
}

// The checked row fields of an answer, or null when it fails the schema (done here, whatever the model was told).
function checked(answer, ids) {
  if (!isObject(answer) || (answer.label !== 'good' && answer.label !== 'bad') || typeof answer.reason !== 'string' || !isObject(answer.categories)) return null;
  const keys = Object.keys(answer.categories);
  if (keys.length !== ids.length || !ids.every((id) => keys.includes(id))) return null;
  const categories = {};
  for (const id of ids) {
    const c = answer.categories[id];
    if (!isObject(c) || typeof c.present !== 'boolean') return null;
    categories[id] = { present: c.present, quote: typeof c.quote === 'string' ? c.quote.slice(0, QUOTE_CHARS) : '' };
  }
  return { label: answer.label, reason: answer.reason.slice(0, REASON_CHARS), categories };
}

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

// Takes the run marker `<file>.run` (`<pid> <host>`): false when a live process holds it, a marker whose process is gone
// is taken over. The test-and-set is one critical section under the store lock; the marker, not the lock, spans the run,
// because withStoreLock holds only for a synchronous function.
function takeRun(file) {
  ensureDir(dirname(file));
  const marker = `${file}.run`;
  return withStoreLock(`${file}.lock`, () => {
    let pid = NaN;
    try { pid = Number.parseInt(readFileSync(marker, 'utf8'), 10); } catch { /* no marker */ }
    if (Number.isInteger(pid) && processAlive(pid)) return false;
    writeFileSync(marker, `${process.pid} ${hostname()}\n`, { mode: 0o600 });
    chmodSync(marker, 0o600);
    return true;
  });
}

function releaseRun(file) {
  const marker = `${file}.run`;
  try {
    if (Number.parseInt(readFileSync(marker, 'utf8'), 10) === process.pid) unlinkSync(marker);
  } catch { /* already gone */ }
}

// Proposes a reference line for each of `sessions` that is not excluded and has none yet (whatever prompt wrote it).
// { proposed, byEntry: { [entry]: lines }, errors, left, stop: null | 'limit' | 'auth' | 'busy' }; `left` counts the
// sessions that are not excluded and still have no line. A limit on every chain entry stops with 'limit', an unreadable
// credential source with 'auth'; the sessions not reached stay in `left`. One run at a time per evals directory: while
// another run is in progress this one returns at once with 'busy' and proposes nothing. A line is appended only when the
// file, re-read under the store lock, has none for the session yet.
export async function proposeReference({ evals, sessions, prompt, chain, spawn, env, home, cwd, bin, now = () => new Date() }) {
  const file = join(evals, 'review', 'reference.jsonl');
  const readDone = () => new Set(readJsonl(file).rows.filter((r) => typeof r.sessionId === 'string').map((r) => r.sessionId));
  const leftOf = (done) => sessions.filter((s) => s.excluded !== true && !done.has(s.sessionId)).length;
  if (!takeRun(file)) return { proposed: 0, byEntry: {}, errors: 0, left: leftOf(readDone()), stop: 'busy' };
  try {
    const done = readDone();
    const ids = Object.keys(prompt.schema.properties.categories.properties);
    const byEntry = {};
    let proposed = 0;
    let errors = 0;
    let stop = null;
    const runner = withChain(chain, async (input, entry) => askModel({
      model: prompt.model, input, schema: prompt.schema, spawn, env: childEnv(entry, env ?? {}, { home }), cwd, bin,
    }));
    // Appends the line unless the file, re-read under the lock, has one for the session already.
    const record = (row) => withStoreLock(`${file}.lock`, () => {
      const had = readDone().has(row.sessionId);
      if (!had) appendPrivate(file, row);
      done.add(row.sessionId);
      return !had;
    });

    for (const s of sessions) {
      if (s.excluded === true || done.has(s.sessionId)) continue;
      const rendered = s.file === null ? '' : renderForJudge(s.file);
      if (rendered.trim() === '') { errors += 1; continue; }
      let outcome;
      try {
        outcome = await runner.run(`${prompt.body}\n\n--- session transcript ---\n${rendered}`);
      } catch (err) {
        if (err instanceof ChainExhausted) { stop = 'limit'; break; }
        if (err instanceof AuthError) { stop = 'auth'; break; }
        throw err;
      }
      const row = outcome.result.answer === undefined ? null : checked(outcome.result.answer, ids);
      if (row === null) { errors += 1; continue; }
      const written = record({
        sessionId: s.sessionId, label: row.label, reason: row.reason, categories: row.categories,
        promptHash: prompt.hash, model: prompt.model, auth: outcome.entry.name, at: new Date(now()).toISOString(),
      });
      if (!written) continue;
      byEntry[outcome.entry.name] = (byEntry[outcome.entry.name] ?? 0) + 1;
      proposed += 1;
    }
    return { proposed, byEntry, errors, left: leftOf(done), stop };
  } finally { releaseRun(file); }
}

// For each of `sessions` with a reference line: a label line in <evals>/review/labels.jsonl and a category line in
// <evals>/label-categories.jsonl, each only when the session has none there. Existing lines are never rewritten.
// { labels, categories }: the lines appended.
export function acceptReference({ evals, sessions, now = () => new Date() }) {
  const refs = new Map();
  for (const r of readJsonl(join(evals, 'review', 'reference.jsonl')).rows) if (typeof r.sessionId === 'string' && !refs.has(r.sessionId)) refs.set(r.sessionId, r);
  const labelFile = join(evals, 'review', 'labels.jsonl');
  const catFile = join(evals, 'label-categories.jsonl');
  const labeled = new Set(readJsonl(labelFile).rows.map((r) => r.sessionId));
  const categorized = new Set(readJsonl(catFile).rows.map((r) => r.sessionId));
  const at = new Date(now()).toISOString();
  let labels = 0;
  let categories = 0;
  for (const { sessionId } of sessions) {
    const ref = refs.get(sessionId);
    if (ref === undefined) continue;
    if (!labeled.has(sessionId)) {
      appendPrivate(labelFile, { sessionId, label: ref.label, note: `auto: ${ref.reason}`, at });
      labeled.add(sessionId);
      labels += 1;
    }
    if (!categorized.has(sessionId)) {
      const present = isObject(ref.categories) ? Object.entries(ref.categories).filter(([, c]) => c?.present === true).map(([id]) => id) : [];
      appendPrivate(catFile, { sessionId, categories: present });
      categorized.add(sessionId);
      categories += 1;
    }
  }
  return { labels, categories };
}
