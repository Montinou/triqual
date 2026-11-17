// The evaluator snapshot of a session experiment: the set of evaluators usable now, frozen under a hash so the report
// scores every session of the experiment with the same checks and prompts. node: built-ins only.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadJudgePrompt } from './eval-judge.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// JSON with the keys of every object sorted, so the same value always gives the same text.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

// The parsed <evals>/validation.json; {} when the file does not exist yet. Any other failure (a file that is not JSON,
// an unreadable one) throws an Error whose message names validation.json, so nothing proceeds on a silently empty set.
export function readValidation(evalsDir) {
  let text;
  try {
    text = readFileSync(join(evalsDir, 'validation.json'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`validation.json: ${err?.code ?? 'unreadable'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('validation.json: not JSON');
  }
}

// The evaluators usable now: every code category, and each judge category whose validation entry is `usable` and was
// measured on the current prompt (equal hash). A judge without a readable prompt or a usable validation is excluded.
// `taxonomy` is { categories, judgeExclude } as loadTaxonomy returns it; `validation` is the parsed validation.json.
// Returns { categories (by id), judgeExclude, excluded (ids, sorted) }.
export function usableSet({ taxonomy, validation, judgesDir }) {
  const categories = [];
  const excluded = [];
  for (const c of taxonomy.categories) {
    if (c.check === 'code') { categories.push(c); continue; }
    let hash = null;
    try { hash = loadJudgePrompt(join(judgesDir, `${c.id}.md`)).hash; } catch { /* no readable prompt: no evaluator */ }
    const v = isObject(validation) && isObject(validation[c.id]) ? validation[c.id] : null;
    if (v !== null && v.usable === true && hash !== null && v.promptHash === hash) categories.push(c);
    else excluded.push(c.id);
  }
  categories.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { categories, judgeExclude: [...(taxonomy.judgeExclude ?? [])], excluded: excluded.sort() };
}

function writeFile0600(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// Freezes `set` as <evals>/snapshots/<hash>/ and returns the hash: the SHA-256 of the canonical JSON of the set, the
// checks file text and the text of each judge prompt in the set. The directory holds taxonomy.json (the usable
// categories, judgeExclude and excluded), eval-checks.mjs, judges/<id>.md and validation.json (the entries of those
// judges, from <evals>/validation.json). The same input gives the same hash; an existing snapshot is left as it is.
export function snapshot(set, { evalsDir, checksFile, judgesDir }) {
  const checks = readFileSync(checksFile, 'utf8');
  const prompts = {};
  for (const c of set.categories) if (c.check === 'judge') prompts[c.id] = readFileSync(join(judgesDir, `${c.id}.md`), 'utf8');
  const hash = createHash('sha256').update(canonical({ set, checks, prompts })).digest('hex');

  const root = join(evalsDir, 'snapshots');
  const dir = join(root, hash);
  if (existsSync(dir)) return hash;

  const parsed = readValidation(evalsDir);
  const all = isObject(parsed) ? parsed : {};
  const validation = {};
  for (const id of Object.keys(prompts)) if (Object.hasOwn(all, id)) validation[id] = all[id];

  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.${hash}.${process.pid}.tmp`);
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, 'judges'), { recursive: true, mode: 0o700 });
    chmodSync(tmp, 0o700);
    chmodSync(join(tmp, 'judges'), 0o700);
    writeFile0600(join(tmp, 'taxonomy.json'), `${JSON.stringify({ categories: set.categories, judgeExclude: set.judgeExclude, excluded: set.excluded }, null, 2)}\n`);
    writeFile0600(join(tmp, 'eval-checks.mjs'), checks);
    for (const [id, text] of Object.entries(prompts)) writeFile0600(join(tmp, 'judges', `${id}.md`), text);
    writeFile0600(join(tmp, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(dir)) return hash; // another start made the same snapshot first
    throw err;
  }
  return hash;
}
