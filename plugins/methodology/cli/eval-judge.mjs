// `triqual eval judge --category <id> --sessions <file>`: runs the category's judge over the listed sessions and appends
// { sessionId, category, result, promptHash, model, auth, at } to <evals>/judgments/<category>.jsonl, once per
// (sessionId, promptHash). <file> is JSONL with `sessionId`, or one id per line. A session under a judgeExclude pattern
// of the taxonomy is recorded undecided/excluded and never spawned (the exclusion comes before any credential entry is
// chosen). A usage-limit or API-error outcome writes no line, so a later run judges that session. The sessions run one
// at a time through the credential chain (lib/eval-auth.mjs): a limit moves every later session to the next entry.
// The last stdout line is `judged <n>: <entry> <k>[, ...]; errors <e>; left <m>`. It prints counts, ids and entry
// names, never transcript text or a secret. Exit codes: 0 every session got a line; 1 some were left (an error, a
// credential problem, every entry limited); 2 usage (a code category included).
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { appendFileSync, chmodSync, openSync, closeSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthError, ChainExhausted, authPath, childEnv, loadChain, withChain } from './lib/eval-auth.mjs';
import { ensureDir, evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { JudgePromptError, judgeSession, loadJudgePrompt, redactSecrets, spawnCapture } from './lib/eval-judge.mjs';
import { readJsonl } from './lib/eval-store.mjs';
import { TaxonomyError, judgeExcluded, loadLabelCategories, loadTaxonomy } from './lib/eval-taxonomy.mjs';
import { withStoreLock } from './lib/role-eval.mjs';

export const SUMMARY = 'run a category judge over sessions, recording pass/fail once per prompt (judge)';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JUDGES = join(HERE, '..', 'evals', 'judges');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CATEGORY = /^[a-z][a-z0-9-]{1,39}$/;

const USAGE = [
  'usage:',
  '  triqual eval judge --category <id> --sessions <file>',
  '      Judges each session of <file> (JSONL with sessionId, or one id per line) with the judge prompt of the',
  '      category (plugins/methodology/evals/judges/<id>.md, front matter model: <full model id>) and appends',
  '      { sessionId, category, result, promptHash, model, auth, at } to <evals>/judgments/<id>.jsonl, once per',
  '      session and prompt hash. A session under a judgeExclude pattern of the taxonomy (<evals>/taxonomy.json) is',
  '      recorded undecided/excluded and never sent to a model. Transcript text is redacted for secrets before it is',
  '      sent. The model credentials come from the chain in TRIQUAL_EVAL_AUTH_FILE,',
  '      else ~/.config/triqual/eval-auth.json (no file: the ambient login). A usage limit or an API error writes no',
  '      line; the session is judged by a later run. Only category checks of kind "judge" are accepted.',
  '      Last line: judged <n>: <entry> <k>[, ...]; errors <e>; left <m>. Exit 0 when every session got a line, else 1.',
  '  triqual eval judge --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(category|sessions)(?:=(.*))?$/s.exec(argv[i]);
    if (!m) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

// The session ids of the list file, in order, without duplicates.
function readIds(file) {
  const ids = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let id = line;
    if (line.startsWith('{')) {
      try { id = JSON.parse(line)?.sessionId; } catch { id = undefined; }
    }
    if (typeof id === 'string' && ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function appendLine(file, row) {
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, now = () => new Date(), spawn = spawnCapture,
  judgesDir = DEFAULT_JUDGES, platform = process.platform,
} = {}) {
  const usage = (m) => { stderr.write(`triqual eval judge: ${m}\n${USAGE}`); return 2; };
  const fail = (m) => { stderr.write(`triqual eval judge: ${m}\n`); return 1; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) return usage(error);
  if (!opts.category || !opts.sessions) return usage('--category and --sessions are both needed');
  if (!CATEGORY.test(opts.category)) return usage('--category is not a category id');

  const home = env.HOME || homedir();
  const evals = evalsDir(env, home);
  let taxonomy;
  try {
    taxonomy = loadTaxonomy(join(evals, 'taxonomy.json'), { labels: loadLabelCategories(join(evals, 'label-categories.jsonl')) });
  } catch (err) {
    if (err instanceof TaxonomyError) return fail(err.message);
    throw err;
  }
  const category = taxonomy.categories.find((c) => c.id === opts.category);
  if (!category) return usage('unknown category');
  if (category.check !== 'judge') return usage('this category is checked by code, not by a judge');

  let prompt;
  try { prompt = loadJudgePrompt(join(judgesDir, `${opts.category}.md`)); } catch (err) {
    if (err instanceof JudgePromptError) return fail(err.message);
    throw err;
  }
  let chain;
  try { chain = loadChain(authPath(env, home)); } catch (err) {
    if (err instanceof AuthError) return fail(err.message);
    throw err;
  }
  let ids;
  try { ids = readIds(opts.sessions); } catch { return fail('the sessions file is unreadable'); }

  const store = new Map(readJsonl(join(evals, 'sessions.jsonl')).rows.filter((r) => typeof r.sessionId === 'string').map((r) => [r.sessionId, r]));
  const root = transcriptsRoot(env, home);
  const dir = join(evals, 'judgments');
  ensureDir(dir);
  const file = join(dir, `${opts.category}.jsonl`);
  const cwd = join(evals, 'judge-cwd');
  ensureDir(cwd);
  const bin = env.TRIQUAL_CLAUDE_BIN || 'claude';
  closeSync(openSync(file, 'a', 0o600));

  const keyOf = (id) => `${id}\0${prompt.hash}`;
  const done = new Set(readJsonl(file).rows.filter((r) => r.promptHash === prompt.hash).map((r) => keyOf(r.sessionId)));
  // Appends one line unless one for (session, prompt hash) is there already (re-read under the lock: two runs never duplicate).
  const record = (id, fields) => withStoreLock(`${file}.lock`, () => {
    if (readJsonl(file).rows.some((r) => r.sessionId === id && r.promptHash === prompt.hash)) { done.add(keyOf(id)); return false; }
    appendLine(file, {
      sessionId: id, category: opts.category, result: fields.result, ...(fields.reason === undefined ? {} : { reason: fields.reason }),
      promptHash: prompt.hash, model: prompt.model, ...(fields.auth === undefined ? {} : { auth: fields.auth }), at: new Date(now()).toISOString(),
    });
    done.add(keyOf(id));
    return true;
  });

  const byEntry = new Map();
  let excluded = 0;
  let errors = 0;
  let judged = 0;
  const chainRun = withChain(chain, async (id, entry) => judgeSession({
    category: opts.category, prompt, session: join(root, store.get(id).projectDir, `${id}.jsonl`), spawn,
    env: childEnv(entry, env, { home }), cwd, bin,
  }));
  let stop = null;

  for (const id of ids) {
    if (done.has(keyOf(id))) continue;
    const s = store.get(id);
    if (judgeExcluded(s?.project ?? null, taxonomy.judgeExclude, { home, platform })) {
      if (record(id, { result: 'undecided', reason: 'excluded' })) excluded += 1;
      continue;
    }
    if (stop !== null) continue;
    if (s === undefined || typeof s.projectDir !== 'string') {
      errors += 1;
      stderr.write(`triqual eval judge: ${id}: not in the sessions store; run "triqual eval review sample" first\n`);
      continue;
    }
    let ran;
    try {
      ran = await chainRun.run(id);
    } catch (err) {
      if (err instanceof ChainExhausted) { stderr.write(`triqual eval judge: every credential entry hit a usage limit (tried: ${err.tried.join(', ')})\n`); stop = 'limit'; continue; }
      if (err instanceof AuthError) { stderr.write(`triqual eval judge: ${err.message}\n`); stop = 'auth'; continue; }
      throw err;
    }
    const { result: out, entry } = ran;
    if (out.error !== undefined) {
      errors += 1;
      stderr.write(`triqual eval judge: ${id}: ${redactSecrets(out.error).text}\n`);
      continue;
    }
    const fields = { result: out.result, ...(out.result === 'undecided' ? { reason: out.reason } : {}), auth: entry.name };
    if (record(id, fields)) { judged += 1; byEntry.set(entry.name, (byEntry.get(entry.name) ?? 0) + 1); }
  }

  const left = ids.filter((id) => !done.has(keyOf(id))).length;
  if (excluded > 0) stdout.write(`excluded ${excluded}\n`);
  const pairs = [...byEntry].map(([name, k]) => `${name} ${k}`).join(', ');
  stdout.write(`judged ${judged}: ${pairs === '' ? 'none' : pairs}; errors ${errors}; left ${left}\n`);
  return left > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
