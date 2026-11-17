// `triqual eval experiments [start <id> | stop <id>]`: the experiments file (TRIQUAL_EXPERIMENTS_FILE, else
// ~/.config/triqual/experiments.json). With no argument it lists the experiments, and exits 2 naming the field when the
// file is invalid. `start <id>` sets status "active", `start` (the UTC day) and `evaluators`: for a session experiment the
// hash of the evaluator snapshot made now (<evals>/snapshots/<hash>/, refused with exit 2 when no evaluator is usable),
// for a role or skill experiment "objective". `stop <id>` sets status "done". The file is rewritten atomically (0600).
// Prints ids, counts and hashes, never transcript text. Exit codes: 0 done; 1 an unreadable taxonomy or a file that could
// not be written; 2 usage, an invalid file, an unknown id, a refused start.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir, evalsDir, experimentsPath } from './lib/eval-paths.mjs';
import { loadExperiments, validateExperiments } from './lib/eval-experiments.mjs';
import { readValidation, snapshot, usableSet } from './lib/eval-snapshot.mjs';
import { TaxonomyError, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';
import { withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'list, start and stop experiments (experiments)';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JUDGES = join(HERE, '..', 'evals', 'judges');
const DEFAULT_CHECKS = join(HERE, 'lib', 'eval-checks.mjs');

const USAGE = [
  'usage:',
  '  triqual eval experiments',
  '      Lists the experiments of the experiments file (TRIQUAL_EXPERIMENTS_FILE, else ~/.config/triqual/experiments.json)',
  '      and exits 2 naming the first invalid field when the file is invalid.',
  '  triqual eval experiments start <id>',
  '      Sets status "active", start (the UTC day) and evaluators. A session experiment freezes the evaluators usable now',
  '      (the code checks and the judges validated on their current prompt) as a snapshot under <evals>/snapshots/<hash>/',
  '      and records its hash; with none usable it is refused. A role or skill experiment records "objective".',
  '  triqual eval experiments stop <id>',
  '      Sets status "done".',
  '  triqual eval experiments --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The raw document of `file`: { doc, list } with `list` its experiments array (missing file: an empty one), or { problem }.
function readDoc(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return { doc: { experiments: [] }, list: [] };
    return { problem: `experiments file: unreadable (${err?.code ?? 'error'})` };
  }
  let doc;
  try { doc = JSON.parse(text); } catch { return { problem: 'experiments file: not JSON' }; }
  if (!isObject(doc) || !Array.isArray(doc.experiments)) return { problem: 'experiments file: invalid field experiments (must be a list)' };
  return { doc, list: doc.experiments };
}

// Replaces the file with `doc` through a temp file and a rename, 0600.
function writeDoc(file, doc) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(file, 0o600);
}

const utcDay = (d) => new Date(d).toISOString().slice(0, 10);

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(),
  judgesDir = DEFAULT_JUDGES, checksFile = DEFAULT_CHECKS,
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval experiments: ${m}\n${USAGE}`); return 2; };
  const refuse = (m) => { stderr.write(`triqual eval experiments: ${m}\n`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval experiments: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const [sub, id, ...extra] = argv;
  if (sub !== undefined && sub !== 'start' && sub !== 'stop') return usage(`unknown argument ${clip(sub)}`);
  if (sub === undefined && id !== undefined) return usage(`unknown argument ${clip(id)}`);
  if (sub !== undefined && (id === undefined || id === '')) return usage(`${sub} needs an experiment id`);
  if (extra.length > 0) return usage(`unknown argument ${clip(extra[0])}`);

  const home = env.HOME || homedir();
  const file = experimentsPath(env, home);
  const read = readDoc(file);
  if (read.problem) return refuse(read.problem);
  const checked = validateExperiments(read.list);
  if (!checked.ok) return refuse(`invalid experiments file: ${checked.field}`);

  if (sub === undefined) {
    const list = loadExperiments(file);
    if (list.length === 0) { stdout.write('no experiments\n'); return 0; }
    const w = (key) => Math.max(...list.map((e) => String(e[key]).length));
    for (const e of list) {
      const arms = Object.keys(e.arms).map((a) => (a === e.control ? `${a}*` : a)).join(' vs ');
      stdout.write(`${String(e.id).padEnd(w('id'))}  ${e.kind.padEnd(w('kind'))}  ${e.status.padEnd(w('status'))}  ${e.start ?? '-'}  ${arms}  margin ${e.margin}  ${e.objective}${e.evaluators ? `  evaluators ${e.evaluators}` : ''}\n`);
    }
    return 0;
  }

  const index = read.list.findIndex((e) => e.id === id);
  if (index < 0) return refuse(`no experiment ${clip(id)}`);
  const target = read.list[index];

  if (sub === 'stop') {
    try {
      ensureDir(dirname(file));
      withStoreLock(`${file}.lock`, () => {
        const again = readDoc(file);
        if (again.problem) throw new Error(again.problem);
        again.list[index] = { ...again.list[index], status: 'done' };
        writeDoc(file, again.doc);
      }, { waitMs: 30000 });
    } catch (err) {
      return fail(`experiments file could not be written: ${err?.code ?? err?.message ?? 'error'}`);
    }
    stdout.write(`stopped ${id}\n`);
    return 0;
  }

  // start
  if (target.status === 'active') return refuse(`experiment ${clip(id)} is already active`);
  const probe = read.list.map((e, i) => (i === index ? { ...e, status: 'active', evaluators: 'pending' } : e));
  const probed = validateExperiments(probe);
  if (!probed.ok) {
    return refuse(probed.field === `experiments.${index}.status`
      ? `${probed.field}: another experiment is already active for this ${target.kind === 'role' ? 'role' : target.kind}`
      : `invalid experiments file: ${probed.field}`);
  }

  let evaluators = 'objective';
  let summary = 'objective evaluators';
  if (target.kind === 'session') {
    const evals = evalsDir(env, home);
    let taxonomy;
    try {
      taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: loadLabelCategories(join(evals, 'label-categories.jsonl')) });
    } catch (err) {
      if (err instanceof TaxonomyError) return fail(err.message);
      throw err;
    }
    let validation;
    try {
      validation = readValidation(evals);
    } catch (err) {
      return fail(err.message);
    }
    const set = usableSet({ taxonomy, validation, judgesDir });
    if (set.categories.length === 0) {
      return refuse(`no usable evaluator${set.excluded.length > 0 ? ` (excluded: ${set.excluded.join(', ')}); validate a judge with "triqual eval validate"` : ''}`);
    }
    try {
      evaluators = snapshot(set, { evalsDir: evals, checksFile, judgesDir });
    } catch (err) {
      return fail(`snapshot could not be written: ${err?.code ?? err?.message ?? 'error'}`);
    }
    summary = `snapshot ${evaluators}: ${set.categories.length} categories${set.excluded.length > 0 ? `, excluded ${set.excluded.join(', ')}` : ''}`;
  }

  try {
    ensureDir(dirname(file));
    withStoreLock(`${file}.lock`, () => {
      const again = readDoc(file);
      if (again.problem) throw new Error(again.problem);
      again.list[index] = { ...again.list[index], status: 'active', start: utcDay(now()), evaluators };
      writeDoc(file, again.doc);
    }, { waitMs: 30000 });
  } catch (err) {
    return fail(`experiments file could not be written: ${err?.code ?? err?.message ?? 'error'}`);
  }
  stdout.write(`started ${id}: ${summary}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
