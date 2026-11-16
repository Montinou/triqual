// The failure taxonomy of the evals (<evals>/taxonomy.json), the per-session category labels
// (<evals>/label-categories.jsonl) and the client-data exclusion that gates what reaches a judge. node: built-ins only.
import { readFileSync } from 'node:fs';
import { readJsonl } from './eval-store.mjs';

// Thrown for a taxonomy file that breaks the contract. The message names the field, never a value.
export class TaxonomyError extends Error {
  constructor(message) { super(message); this.name = 'TaxonomyError'; }
}

const ID = /^[a-z][a-z0-9-]{1,39}$/;
const CHECKS = new Set(['code', 'judge']);
const MIN_EXAMPLES = 3;
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Reads and validates `file`: { judgeExclude?: string[], categories: [{ id, name, definition, examples, check }] }.
// `labels` is the labeled session ids (a Set, a Map keyed by id or an array); every example must be one of them.
export function loadTaxonomy(file, { labels } = {}) {
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new TaxonomyError('taxonomy file: unreadable or not JSON'); }
  if (!isObject(doc)) throw new TaxonomyError('taxonomy file: not an object');
  const labeled = new Set(labels instanceof Map ? labels.keys() : (labels ?? []));
  const judgeExclude = doc.judgeExclude ?? [];
  if (!Array.isArray(judgeExclude) || !judgeExclude.every(nonEmptyString)) throw new TaxonomyError('judgeExclude: must be a list of non-empty strings');
  if (!Array.isArray(doc.categories)) throw new TaxonomyError('categories: must be a list');
  const seen = new Set();
  const categories = doc.categories.map((c, i) => {
    const at = `categories[${i}]`;
    if (!isObject(c)) throw new TaxonomyError(`${at}: not an object`);
    if (typeof c.id !== 'string' || !ID.test(c.id)) throw new TaxonomyError(`${at}.id: must match ${ID}`);
    if (seen.has(c.id)) throw new TaxonomyError(`${at}.id: duplicate`);
    seen.add(c.id);
    if (!nonEmptyString(c.name)) throw new TaxonomyError(`${at}.name: must be a non-empty string`);
    if (!nonEmptyString(c.definition)) throw new TaxonomyError(`${at}.definition: must be a non-empty string`);
    if (!CHECKS.has(c.check)) throw new TaxonomyError(`${at}.check: must be "code" or "judge"`);
    if (!Array.isArray(c.examples) || new Set(c.examples).size < MIN_EXAMPLES) throw new TaxonomyError(`${at}.examples: needs at least ${MIN_EXAMPLES}`);
    if (!c.examples.every((e) => typeof e === 'string' && labeled.has(e))) throw new TaxonomyError(`${at}.examples: every example must be a labeled session id`);
    return { id: c.id, name: c.name, definition: c.definition, examples: [...c.examples], check: c.check };
  });
  return { categories, judgeExclude: [...judgeExclude] };
}

// Map<sessionId, string[]> of the lines { sessionId, categories: [id] }; a line of another shape is skipped.
export function loadLabelCategories(file) {
  const out = new Map();
  for (const r of readJsonl(file).rows) {
    if (typeof r.sessionId === 'string' && Array.isArray(r.categories) && r.categories.every((c) => typeof c === 'string')) out.set(r.sessionId, [...r.categories]);
  }
  return out;
}

const trimSlashes = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

// Whether a session whose project path is `project` must not reach a judge. No pattern: never. With a pattern, an
// unknown (null or empty) project counts as excluded. A pattern matches the path equal to it (without its trailing
// slash) or under it; `~/` expands to `home` (a `~` pattern with no usable `home` counts as excluded: the gate fails
// closed); case-insensitive on darwin.
export function judgeExcluded(project, patterns, { home, platform } = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  if (typeof project !== 'string' || project === '') return true;
  const fold = platform === 'darwin' ? (s) => s.toLowerCase() : (s) => s;
  const path = fold(trimSlashes(project));
  return patterns.some((raw) => {
    if (typeof raw !== 'string' || raw === '') return false;
    const tilde = raw === '~' || raw.startsWith('~/');
    if (tilde && !nonEmptyString(home)) return true;
    const expanded = tilde ? `${trimSlashes(home)}${raw.slice(1)}` : raw;
    const p = fold(trimSlashes(expanded));
    return p !== '' && (path === p || path.startsWith(p === '/' ? '/' : `${p}/`));
  });
}
