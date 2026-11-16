import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-improve.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { PAID_NOTE } from '../cli/lib/eval-auth.mjs';
import { reviseList } from '../cli/lib/eval-improve.mjs';
import { splitOf } from '../cli/lib/eval-validate.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-improve-'));
const mode = (f) => statSync(f).mode & 0o777;
const turn = (role, text, at) => JSON.stringify({ type: role, timestamp: at, cwd: '/home/x/proj', entrypoint: 'cli', message: { role, content: text } });
const MODEL = 'claude-haiku-5-5';
const KEYS = ['added', 'at', 'empty', 'errors', 'failed', 'judged', 'kept', 'limits', 'paidOnly', 'pluginVersion', 'proposed', 'rates', 'refereed', 'revise', 'scores'];

const TAXONOMY = {
  judgeExclude: [],
  categories: [
    { id: 'stalls', name: 'Stalls', definition: 'The assistant stopped when it could go on.', examples: ['a', 'b', 'c'], check: 'judge' },
    { id: 'owner-chased-progress', name: 'Owner chased progress', definition: 'The owner asked for progress again and again.', examples: ['a', 'b', 'c'], check: 'code' },
  ],
};

// The transcript's file time is `touched` (default: weeks before the round's clock, so the session is quiet).
const OLD = new Date('2026-11-01T00:00:00Z');
function write(f, sessionId, at, touched = OLD) {
  mkdirSync(join(f.root, '-home-x-proj'), { recursive: true });
  const file = join(f.root, '-home-x-proj', `${sessionId}.jsonl`);
  writeFileSync(file, `${turn('user', `invented task of ${sessionId}`, at)}\n${turn('assistant', 'invented reply', at)}\n`);
  utimesSync(file, touched, touched);
}

// s1 and s2 are sampled; n1 started after both and is not; o1 (added by a test) started before both.
function fixture({ sample = true, chain } = {}) {
  const base = tmp();
  const evals = join(base, 'evals');
  const root = join(base, 'projects');
  const judges = join(base, 'judges');
  for (const d of [join(base, 'home'), join(evals, 'review'), judges]) mkdirSync(d, { recursive: true });
  const f = { base, evals, root, judges, sampleFile: join(evals, 'review', 'sample.jsonl') };
  write(f, 's1', '2026-11-10T10:00:00.000Z');
  write(f, 's2', '2026-11-11T10:00:00.000Z');
  write(f, 'n1', '2026-11-12T10:00:00.000Z');
  if (sample) writeFileSync(f.sampleFile, ['s1', 's2'].map((id) => `${JSON.stringify({ sessionId: id, project: '/home/x/proj', stratum: 'random' })}\n`).join(''));
  writeFileSync(join(evals, 'label-categories.jsonl'), ['a', 'b', 'c'].map((id) => `${JSON.stringify({ sessionId: id, categories: [] })}\n`).join(''));
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(TAXONOMY));
  writeFileSync(join(judges, 'stalls.md'), `---\nmodel: ${MODEL}\n---\nDecide whether the session shows the failure.\n`);
  const reference = join(base, 'reference.md');
  writeFileSync(reference, `---\nmodel: ${MODEL}\n---\nLabel the session.\n`);
  const referee = join(base, 'referee.md');
  writeFileSync(referee, `---\nmodel: ${MODEL}\n---\nRule on the disagreement.\n`);
  const auth = join(base, 'eval-auth.json');
  writeFileSync(auth, JSON.stringify({ chain: chain ?? [{ name: 'pro', env: { CLAUDE_CODE_OAUTH_TOKEN: 'pro-tok' } }, { name: 'api', env: { ANTHROPIC_API_KEY: 'api-tok' }, paid: true }] }));
  f.env = { HOME: join(base, 'home'), PATH: process.env.PATH, TRIQUAL_EVALS_DIR: evals, TRIQUAL_TRANSCRIPTS_DIR: root, TRIQUAL_EVAL_AUTH_FILE: auth, TRIQUAL_CLAUDE_BIN: 'claude-stub' };
  f.reference = reference;
  f.referee = referee;
  return f;
}

const LIMIT = { type: 'result', subtype: 'success', is_error: true, result: "You've hit your 5-hour limit", api_error_status: 429, api_error: 'usage_limit_reached' };
const result = (so) => ({ type: 'result', is_error: false, structured_output: so });

// A spawn stub that answers by the schema it is sent: the reference schema (a label and the categories present), the
// judge schema (a critique and a pass or fail) or the referee schema (a ruling). `limited(env)` makes a call a limit.
function stub({ limited = () => false } = {}) {
  const calls = [];
  const spawn = async (bin, args, { env }) => {
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    calls.push({ env, kind: schema.properties.categories ? 'reference' : schema.properties.critique ? 'judge' : 'referee' });
    let reply;
    if (limited(env)) reply = LIMIT;
    else if (schema.properties.categories) reply = result({ label: 'bad', reason: 'invented', categories: { stalls: { present: true, quote: 'q' } } });
    else if (schema.properties.critique) reply = result({ critique: 'invented', result: 'pass' });
    else reply = result({ present: true, quote: 'q', why: 'invented', misleading: 'none' });
    return { code: 0, stdout: JSON.stringify(reply), stderr: '' };
  };
  return { calls, spawn };
}

let clock = Date.parse('2026-11-16T12:00:00Z');
async function run(f, argv, spawn, extra = {}) {
  let out = '';
  let err = '';
  clock += 60_000;
  const code = await main(argv, {
    env: f.env, spawn, judgesDir: f.judges, referencePrompt: f.reference, refereePrompt: f.referee, platform: 'linux', pluginVersion: '9.9.9', ...extra,
    now: () => new Date(clock), stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const reports = (f) => {
  try { return readdirSync(join(f.evals, 'rounds')).sort(); } catch { return []; }
};
const reportOf = (f) => JSON.parse(readFileSync(join(f.evals, 'rounds', reports(f).at(-1)), 'utf8'));

test('a first run writes one report with the fifteen keys, mode 0600, and exits 0; a second run over an older unsampled session makes no call', async () => {
  const f = fixture();
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 0, r.err);
  assert.equal(reports(f).length, 1);
  assert.match(reports(f)[0], /^\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/);
  const file = join(f.evals, 'rounds', reports(f)[0]);
  assert.equal(mode(file), 0o600);
  const rep = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(rep).sort(), KEYS);
  assert.deepEqual([rep.added, rep.proposed, rep.judged, rep.refereed, rep.errors, rep.limits, rep.pluginVersion], [1, 3, 3, 3, 0, false, '9.9.9']);
  assert.ok(Array.isArray(rep.scores) && Array.isArray(rep.revise));
  assert.ok(Array.isArray(rep.rates.month) && Array.isArray(rep.rates.version));
  assert.deepEqual(Object.keys(rep.rates).sort(), ['month', 'version']);
  assert.deepEqual([rep.failed, rep.paidOnly], [[], false]);
  assert.deepEqual([rep.kept, rep.empty], [3, 0], 'the render of s1, s2 and the drawn n1 is kept');
  assert.ok(r.out.includes('renders: kept 3, empty 0'), r.out);
  assert.equal(rep.scores.length, 2);
  assert.deepEqual(rep.scores.map((x) => x.category).sort(), ['owner-chased-progress', 'stalls']);
  assert.deepEqual(readFileSync(f.sampleFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).sessionId), ['s1', 's2', 'n1']);
  assert.ok(r.out.trim().split('\n').length <= 30);
  assert.ok(r.out.includes('labels are checked only where a judge disagreed with them'));
  assert.ok(r.out.includes(file));
  assert.ok(r.out.includes('stalls: dev '));
  assert.ok(existsSync(join(f.evals, 'scores.jsonl')));
  assert.equal(mode(join(f.evals, 'scores.jsonl')), 0o600);
  assert.ok(!r.out.includes('invented'), 'no transcript text is printed');

  // The older session is in the store after the second refresh, but started before the newest sampled one.
  write(f, 'o1', '2026-11-05T10:00:00.000Z');
  const sample = readFileSync(f.sampleFile, 'utf8');
  const before = s.calls.length;
  const again = await run(f, [], s.spawn);
  assert.equal(again.code, 0, again.err);
  assert.equal(s.calls.length, before);
  assert.equal(readFileSync(f.sampleFile, 'utf8'), sample);
  assert.equal(reportOf(f).added, 0);
  assert.deepEqual([reportOf(f).kept, reportOf(f).empty], [0, 0], 'nothing new to keep');
  assert.ok(!again.out.includes('renders:'), 'no renders line when both numbers are zero');
});

test('--more 0 draws nothing; the steps still run', async () => {
  const f = fixture();
  const s = stub();
  const r = await run(f, ['--more', '0'], s.spawn);
  assert.equal(r.code, 0, r.err);
  assert.equal(reportOf(f).added, 0);
  assert.equal(reportOf(f).proposed, 2);
  assert.equal(readFileSync(f.sampleFile, 'utf8').trim().split('\n').length, 2);
});

test('a stub that returns a limit on every call gives exit 3, limits true, and arrays for scores and rates', async () => {
  const f = fixture();
  const s = stub({ limited: () => true });
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  const rep = reportOf(f);
  assert.equal(rep.limits, true);
  assert.ok(Array.isArray(rep.scores) && Array.isArray(rep.rates.month) && Array.isArray(rep.rates.version));
  assert.equal(rep.proposed, 0);
});

test('without --paid no call carries the paid entry variable; with --paid the paid entry is used', async () => {
  const limitedSub = (env) => env.CLAUDE_CODE_OAUTH_TOKEN === 'pro-tok';
  const f = fixture();
  const s = stub({ limited: limitedSub });
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  assert.ok(s.calls.length > 0);
  assert.ok(s.calls.every((c) => c.env.ANTHROPIC_API_KEY === undefined));
  assert.equal(reportOf(f).limits, true);

  const g = fixture();
  const p = stub({ limited: limitedSub });
  const paid = await run(g, ['--paid'], p.spawn);
  assert.equal(paid.code, 0, paid.err);
  assert.ok(p.calls.some((c) => c.env.ANTHROPIC_API_KEY === 'api-tok'));
  assert.equal(reportOf(g).judged, 3);
});

test('a chain of paid entries only, without --paid: no call, limits false, the note in the summary, exit 3', async () => {
  const f = fixture({ chain: [{ name: 'only-paid', env: { ANTHROPIC_API_KEY: 'api-tok' }, paid: true }] });
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  assert.equal(s.calls.length, 0);
  assert.equal(reportOf(f).limits, false);
  assert.ok(r.out.includes(PAID_NOTE), r.out);
  const rep = reportOf(f);
  assert.equal(rep.paidOnly, true);
  assert.ok(rep.failed.includes('review propose'), rep.failed.join());
  assert.ok(r.out.includes(`steps that returned non-zero: ${rep.failed.join(', ')}`), r.out);
});

// ---- the kept renders and the sessions with nothing to judge ----

const renderFile = (f, id) => join(f.evals, 'review', 'renders', `${id}.txt`);

test('a sample with one text-less session and nothing else wrong: exit 0, failed [], errors 0, empty 1, kept for the others, no call for it', async () => {
  const f = fixture();
  writeFileSync(join(f.root, '-home-x-proj', 's2.jsonl'), `${turn('user', [], '2026-11-11T10:00:00.000Z')}\n`);
  utimesSync(join(f.root, '-home-x-proj', 's2.jsonl'), OLD, OLD);
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 0, r.err);
  const rep = reportOf(f);
  assert.deepEqual([rep.failed, rep.errors, rep.empty, rep.kept], [[], 0, 1, 2]);
  assert.deepEqual([rep.added, rep.proposed, rep.judged, rep.refereed], [1, 2, 2, 2]);
  assert.ok(r.out.includes('renders: kept 2, empty 1'), r.out);
  assert.equal(existsSync(renderFile(f, 's1')), true);
  assert.equal(existsSync(renderFile(f, 'n1')), true, 'the session drawn this round is kept');
  assert.equal(existsSync(renderFile(f, 's2')), false);
  assert.equal(statSync(join(f.evals, 'review', 'renders')).mode & 0o777, 0o700);
  assert.equal(mode(renderFile(f, 's1')), 0o600);
  assert.equal(s.calls.length, 6, 'two proposals, two judgments and two rulings: none for the text-less session');
  assert.ok(!r.out.includes('invented task'), 'no kept text is printed');
  assert.ok(!JSON.stringify(rep).includes('invented task'), 'no kept text is in the report');
});

test('a session whose transcript is deleted after it was kept is still judged in the next round', async () => {
  const f = fixture();
  const s = stub();
  assert.equal((await run(f, ['--more', '0'], s.spawn)).code, 0);
  assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')).sort(), ['s1.txt', 's2.txt']);
  rmSync(join(f.root, '-home-x-proj', 's1.jsonl'));
  rmSync(join(f.evals, 'judgments'), { recursive: true });
  const again = await run(f, ['--more', '0'], s.spawn);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual([reportOf(f).failed, reportOf(f).errors, reportOf(f).judged], [[], 0, 2]);
});

test('a session whose render cannot be written is a failed step with the right kept, and the round goes on', async () => {
  const f = fixture();
  mkdirSync(renderFile(f, 's1'), { recursive: true }); // s1's render path is occupied by a directory
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  const rep = reportOf(f);
  assert.deepEqual(rep.failed, ['keep renders']);
  assert.deepEqual([rep.kept, rep.empty], [2, 0], 's2 and the drawn n1 were still kept');
  assert.deepEqual([rep.added, rep.proposed, rep.judged], [1, 3, 3]);
  assert.ok(failedLine(r.out).includes('keep renders'), r.out);
  assert.ok(r.out.includes('renders: kept 2, empty 0'), r.out);
});

test('a session whose transcript changed within the hour is neither drawn nor kept; a later round takes it', async () => {
  const f = fixture();
  write(f, 'n1', '2026-11-12T10:00:00.000Z', new Date('2026-11-16T11:50:00Z')); // modified 10 minutes before the round
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([reportOf(f).added, reportOf(f).kept], [0, 2]);
  assert.equal(existsSync(renderFile(f, 'n1')), false);
  clock += 3 * 60 * 60 * 1000;
  const later = await run(f, [], s.spawn);
  assert.equal(later.code, 0, later.err);
  assert.equal(reportOf(f).added, 1);
  assert.equal(existsSync(renderFile(f, 'n1')), true);
});

test('a keepRenders that fails for every session lands keep renders in failed, the report is still written and the later steps ran', async () => {
  const f = fixture();
  mkdirSync(join(f.evals, 'review'), { recursive: true });
  writeFileSync(join(f.evals, 'review', 'renders'), 'not a directory'); // the render directory cannot be created
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  assert.equal(reports(f).length, 1);
  const rep = reportOf(f);
  assert.deepEqual(rep.failed, ['keep renders']);
  assert.deepEqual([rep.kept, rep.empty], [0, 0]);
  assert.deepEqual([rep.added, rep.proposed, rep.judged], [1, 3, 3]);
  assert.ok(failedLine(r.out).includes('keep renders'), r.out);
});

test('the steps run in order: review sample, keep renders, review propose', async () => {
  const f = fixture();
  mkdirSync(join(f.evals, 'review'), { recursive: true });
  writeFileSync(join(f.evals, 'review', 'renders'), 'not a directory');
  const s = stub();
  const boom = async () => { throw new Error('boom'); };
  const r = await run(f, [], s.spawn, { commands: { review: boom } });
  assert.equal(r.code, 3, r.err);
  assert.deepEqual(reportOf(f).failed.slice(0, 3), ['review sample', 'keep renders', 'review propose']);
});

// ---- a failed step is visible in the exit code, the summary and the report ----

const failedLine = (out) => out.split('\n').find((l) => l.startsWith('steps that returned non-zero')) ?? '';
const dirAt = (p) => mkdirSync(p, { recursive: true });

test('a sample step that returns non-zero: exit 3, failed and the summary name it, the report exists, later steps ran', async () => {
  const f = fixture();
  dirAt(`${f.sampleFile}.${process.pid}.tmp`); // the draw cannot write its temp file: it returns 1
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  assert.equal(reports(f).length, 1);
  const rep = reportOf(f);
  assert.deepEqual(rep.failed, ['review sample']);
  assert.equal(rep.paidOnly, false);
  assert.equal(rep.added, 0);
  assert.ok(failedLine(r.out).includes('review sample'), r.out);
  assert.deepEqual([rep.proposed, rep.judged, rep.refereed], [2, 2, 2]);
  assert.equal(rep.scores.length, 2);
});

test('a sample step that throws: exit 3, failed and the summary name it, the report exists, later steps ran', async () => {
  const f = fixture();
  const s = stub();
  const r = await run(f, [], s.spawn, { commands: { review: async (argv, deps) => { if (argv[0] === 'sample') throw new Error('boom'); return (await import('../cli/eval-review.mjs')).main(argv, deps); } } });
  assert.equal(r.code, 3, r.err);
  assert.equal(reports(f).length, 1);
  const rep = reportOf(f);
  assert.deepEqual(rep.failed, ['review sample']);
  assert.ok(failedLine(r.out).includes('review sample'), r.out);
  assert.deepEqual([rep.added, rep.proposed, rep.judged], [0, 2, 2]);
});

test('a validate that fails is in failed, the summary and the exit code', async () => {
  const f = fixture();
  dirAt(join(f.evals, 'validation.json')); // validation.json cannot be rewritten
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  assert.deepEqual(reportOf(f).failed, ['validate stalls']);
  assert.ok(failedLine(r.out).includes('validate stalls'), r.out);
});

test('a scores append that throws is in failed and the report is still written with every score', async () => {
  const f = fixture();
  dirAt(join(f.evals, 'scores.jsonl')); // the append throws
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 3, r.err);
  assert.equal(reports(f).length, 1);
  const rep = reportOf(f);
  assert.deepEqual(rep.failed, ['score stalls', 'score owner-chased-progress']);
  assert.equal(rep.scores.length, 2);
  assert.ok(failedLine(r.out).includes('score stalls'), r.out);
});

test('no sample: exit 1, a message naming the sample command, no report', async () => {
  const f = fixture({ sample: false });
  const s = stub();
  const r = await run(f, [], s.spawn);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('triqual eval review sample'), r.err);
  assert.deepEqual(reports(f), []);
  assert.equal(s.calls.length, 0);
});

test('usage: --help prints the usage and returns 0; a bad --more or an unknown argument returns 2', async () => {
  const f = fixture();
  const s = stub();
  const help = await run(f, ['--help'], s.spawn);
  assert.equal(help.code, 0);
  assert.match(help.out, /triqual eval improve/);
  assert.match(help.out, /keep renders/);
  assert.match(help.out, /\bkept\b.*\bempty\b/s);
  for (const bad of [['--more'], ['--more', 'x'], ['--more', '-1'], ['--nope']]) {
    const r = await run(f, bad, s.spawn);
    assert.equal(r.code, 2, bad.join(' '));
  }
  assert.deepEqual(reports(f), []);
});

test('the dispatcher lists improve with its summary', async () => {
  let out = '';
  await evalMain([], { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  assert.match(out, /^ {2}improve +\S/m);
});

// ---- reviseList ----

// The first `count` ids of a split (train: stratum cost; dev or test: random by the hash parity).
function idsOf(split, count) {
  const out = [];
  for (let i = 0; out.length < count; i += 1) {
    const id = `x${split}${i}`;
    const stratum = split === 'train' ? 'cost' : 'random';
    if (splitOf(id, stratum) === split) out.push({ sessionId: id, stratum });
  }
  return out;
}
const CAT = { id: 'stalls', check: 'judge' };
const CODE = { id: 'owner-chased-progress', check: 'code' };

// Every session is labeled without the category and judged `fail`: a disagreement with the label.
function inputs(rows, { ruled = true, categories = [CAT] } = {}) {
  const labelCategories = new Map(rows.map((r) => [r.sessionId, []]));
  const rulings = new Map(ruled ? rows.flatMap((r) => categories.map((c) => [`${r.sessionId}\0${c.id}`, { present: false }])) : []);
  const verdicts = new Map(categories.map((c) => [c.id, new Map(rows.map((r) => [r.sessionId, 'fail']))]));
  return { categories, sample: rows, labelCategories, rulings, verdicts };
}

test('reviseList: three ruled disagreements in train and dev list the category', () => {
  assert.deepEqual(reviseList(inputs([...idsOf('train', 1), ...idsOf('dev', 2)])), ['stalls']);
  assert.deepEqual(reviseList(inputs(idsOf('train', 3))), ['stalls']);
  assert.deepEqual(reviseList(inputs(idsOf('dev', 3))), ['stalls']);
});

test('reviseList: two do not, and three in the test split do not', () => {
  assert.deepEqual(reviseList(inputs(idsOf('dev', 2))), []);
  assert.deepEqual(reviseList(inputs(idsOf('test', 3))), []);
  assert.deepEqual(reviseList(inputs([...idsOf('test', 3), ...idsOf('dev', 2)])), []);
});

test('reviseList: disagreements with labels that have no ruling do not count', () => {
  assert.deepEqual(reviseList(inputs(idsOf('train', 3), { ruled: false })), []);
});

test('reviseList: agreements and undecided verdicts do not count', () => {
  const rows = idsOf('train', 4);
  const i = inputs(rows);
  i.verdicts.set('stalls', new Map([[rows[0].sessionId, 'pass'], [rows[1].sessionId, 'pass'], [rows[2].sessionId, 'undecided'], [rows[3].sessionId, 'fail']]));
  assert.deepEqual(reviseList(i), []);
  i.labelCategories.set(rows[0].sessionId, ['stalls']);
  i.verdicts.set('stalls', new Map(rows.map((r) => [r.sessionId, 'pass'])));
  assert.deepEqual(reviseList(i), []);
  i.verdicts.set('stalls', new Map(rows.map((r) => [r.sessionId, 'fail'])));
  assert.deepEqual(reviseList(i), ['stalls']); // three fail verdicts against labels without the category
});

test('reviseList: a code category is never listed', () => {
  assert.deepEqual(reviseList(inputs(idsOf('train', 5), { categories: [CODE] })), []);
  assert.deepEqual(reviseList(inputs(idsOf('train', 5), { categories: [CODE, CAT] })), ['stalls']);
});
