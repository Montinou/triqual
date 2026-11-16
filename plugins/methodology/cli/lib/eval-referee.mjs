// The referee of the evals: where a category judge and the session's category label disagree, a model reads the session
// once more and rules; the ruling is kept in <evals>/rulings.jsonl and the label file follows it. A session under the
// taxonomy's judgeExclude is never sent. node: built-ins only.
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { askModel, appendPrivate } from './eval-ask.mjs';
import { AuthError, ChainExhausted, childEnv, withChain } from './eval-auth.mjs';
import { redactSecrets, renderForJudge } from './eval-judge.mjs';
import { ensureDir } from './eval-paths.mjs';
import { readJsonl } from './eval-store.mjs';
import { loadLabelCategories, loadRulings } from './eval-taxonomy.mjs';
import { withStoreLock } from './role-eval.mjs';

const QUOTE_CHARS = 300;
const WHY_CHARS = 400;
const MISLEADING_CHARS = 500;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const REFEREE_SCHEMA = {
  type: 'object',
  properties: { present: { type: 'boolean' }, quote: { type: 'string' }, why: { type: 'string' }, misleading: { type: 'string' } },
  required: ['present', 'quote', 'why', 'misleading'],
  additionalProperties: false,
};

// The sessions (of `sessions`, in order) that are not excluded, have a line in `labelCategories` (Map sessionId ->
// [category]), have a pass or fail verdict of `category` under the judge `version` (a prompt hash), whose verdict
// contradicts the label (fail against a label without the category, pass against one with it) and that have no ruling
// in `rulings` (a Map from loadRulings) for the category. [{ session, judge: 'pass'|'fail' }].
export function disagreements({ category, sessions, labelCategories, judgments, version, rulings }) {
  const verdict = new Map();
  for (const j of judgments ?? []) {
    if (isObject(j) && j.promptHash === version && (j.category === undefined || j.category === category) && typeof j.sessionId === 'string'
      && (j.result === 'pass' || j.result === 'fail')) verdict.set(j.sessionId, j.result);
  }
  const out = [];
  for (const session of sessions) {
    if (session.excluded === true) continue;
    const labeled = labelCategories?.get(session.sessionId);
    const judge = verdict.get(session.sessionId);
    if (labeled === undefined || judge === undefined) continue;
    if ((judge === 'fail') === labeled.includes(category)) continue;
    if (rulings?.has(`${session.sessionId}\0${category}`)) continue;
    out.push({ session, judge });
  }
  return out;
}

// Rewrites <evals>/label-categories.jsonl through a temp file and a rename (mode 0600), under the store lock, so that on
// each existing line a category with a ruling in `rulings` (a Map from loadRulings) is present exactly when the ruling's
// `present` is true. A line with no ruling, the line order and every other category stay as they are; a changed line is
// written as JSON, an unchanged one byte for byte; no line is added. Returns the number of lines changed.
export function applyRulings({ evals, rulings }) {
  const file = join(evals, 'label-categories.jsonl');
  const bySession = new Map();
  for (const [key, r] of rulings) {
    const [sessionId, category] = key.split('\0');
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push([category, r.present === true]);
  }
  if (bySession.size === 0) return 0;
  return withStoreLock(`${file}.lock`, () => {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return 0; }
    let changed = 0;
    const out = text.split('\n').map((line) => {
      let row;
      try { row = JSON.parse(line); } catch { return line; }
      if (!isObject(row) || typeof row.sessionId !== 'string' || !Array.isArray(row.categories) || !row.categories.every((c) => typeof c === 'string')) return line;
      let categories = [...row.categories];
      for (const [category, present] of bySession.get(row.sessionId) ?? []) {
        const has = categories.includes(category);
        if (present && !has) categories = [...categories, category];
        else if (!present && has) categories = categories.filter((c) => c !== category);
      }
      if (categories.length === row.categories.length && categories.every((c, i) => c === row.categories[i])) return line;
      changed += 1;
      return JSON.stringify({ ...row, categories });
    });
    if (changed === 0) return 0;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, out.join('\n'), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return changed;
  });
}

// The checked ruling fields of an answer, or null when it fails the schema (done here, whatever the model was told).
function checked(answer) {
  if (!isObject(answer) || typeof answer.present !== 'boolean' || typeof answer.quote !== 'string'
    || typeof answer.why !== 'string' || typeof answer.misleading !== 'string') return null;
  return { present: answer.present, quote: answer.quote.slice(0, QUOTE_CHARS), why: answer.why.slice(0, WHY_CHARS), misleading: answer.misleading.slice(0, MISLEADING_CHARS) };
}

// The category's quote on the session's (first) line of <evals>/review/reference.jsonl, or null.
function referenceQuotes(evals) {
  const out = new Map();
  for (const r of readJsonl(join(evals, 'review', 'reference.jsonl')).rows) {
    if (typeof r.sessionId === 'string' && !out.has(r.sessionId)) out.set(r.sessionId, r.categories);
  }
  return (sessionId, category) => {
    const q = out.get(sessionId)?.[category]?.quote;
    return typeof q === 'string' && q.trim() !== '' ? q : null;
  };
}

// Rules on every disagreement of `categories` ([{ category, judgments, version }] with the category's id, name and
// definition) over `sessions` (sampleSessions rows), then applies the rulings to the label file.
// { refereed, byEntry, errors, left, applied, stop: null | 'limit' | 'auth' }. A ruling is appended only when the
// rulings file, re-read under the store lock, has none for the pair yet. `left` counts the disagreements that still have
// no ruling; a limit on every chain entry stops with 'limit', an unreadable credential source with 'auth'.
export async function runReferee({ evals, sessions, categories, prompt, chain, spawn, env, home, cwd, bin, now = () => new Date() }) {
  const file = join(evals, 'rulings.jsonl');
  ensureDir(dirname(file));
  const labels = loadLabelCategories(join(evals, 'label-categories.jsonl'));
  const quoteOf = referenceQuotes(evals);
  const byEntry = {};
  let refereed = 0;
  let errors = 0;
  let stop = null;
  const runner = withChain(chain, async (input, entry) => askModel({
    model: prompt.model, input, schema: REFEREE_SCHEMA, spawn, env: childEnv(entry, env ?? {}, { home }), cwd, bin,
  }));
  const record = (row) => withStoreLock(`${file}.lock`, () => {
    if (loadRulings(file).has(`${row.sessionId}\0${row.category}`)) return false;
    appendPrivate(file, row);
    return true;
  });
  const pending = (c) => disagreements({ category: c.id, sessions, labelCategories: labels, judgments: c.judgments, version: c.version, rulings: loadRulings(file) });

  for (const c of categories) {
    if (stop !== null) break;
    for (const { session, judge } of pending(c)) {
      const rendered = session.file === null ? '' : renderForJudge(session.file);
      if (rendered.trim() === '') { errors += 1; continue; }
      const labeled = labels.get(session.sessionId).includes(c.id);
      const quote = quoteOf(session.sessionId, c.id);
      const input = `${prompt.body}\n\nFailure category: ${c.id} (${c.name})\nDefinition: ${c.definition}\nThe judge said: ${judge}\n`
        + `The label says: ${labeled ? 'present' : 'absent'}\nReference quote: ${quote === null ? 'none' : redactSecrets(quote).text}\n\n--- session transcript ---\n${rendered}`;
      let outcome;
      try {
        outcome = await runner.run(input);
      } catch (err) {
        if (err instanceof ChainExhausted) { stop = 'limit'; break; }
        if (err instanceof AuthError) { stop = 'auth'; break; }
        throw err;
      }
      const fields = outcome.result.answer === undefined ? null : checked(outcome.result.answer);
      if (fields === null) { errors += 1; continue; }
      const written = record({
        sessionId: session.sessionId, category: c.id, present: fields.present, source: 'referee', judge, quote: fields.quote,
        why: fields.why, misleading: fields.misleading, promptHash: prompt.hash, model: prompt.model, auth: outcome.entry.name,
        at: new Date(now()).toISOString(),
      });
      if (!written) continue;
      byEntry[outcome.entry.name] = (byEntry[outcome.entry.name] ?? 0) + 1;
      refereed += 1;
    }
  }
  const applied = applyRulings({ evals, rulings: loadRulings(file) });
  const left = categories.reduce((n, c) => n + pending(c).length, 0);
  return { refereed, byEntry, errors, left, applied, stop };
}
