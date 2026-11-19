import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-report.mjs';
import { main as evalMain } from '../cli/eval.mjs';
import { buildRows, sessionVerdict, verdict } from '../cli/lib/eval-report.mjs';
import { snapshot } from '../cli/lib/eval-snapshot.mjs';
import { loadJudgePrompt } from '../cli/lib/eval-judge.mjs';

const VERDICTS = ['insufficient data', 'worse', 'propose', 'non-inferior, not cheaper', 'inconclusive'];
const experiment = (over = {}) => ({
  id: 'e1', kind: 'session', status: 'active', start: '2026-11-01', control: 'off',
  arms: { off: { model: 'm1' }, on: { model: 'm2' } }, margin: 0.1, objective: 'cost', evaluators: 'h', ...over,
});

// `total` units of `arm`, the first `healthy` of them healthy, the rest unhealthy; cost from costOf(i).
const units = (arm, healthy, total, costOf = () => 1, extra = {}) => Array.from({ length: total }, (_, i) => ({
  arm, contaminated: false, verdict: i < healthy ? 'healthy' : 'unhealthy', cost: costOf(i), project: '/home/x/Client', models: ['m1'], ...extra,
}));
const rowsOf = (all) => buildRows(all, experiment());
const armRow = (rows) => rows.find((r) => !r.control);

// ---- the five verdicts, one fixture each -------------------------------------------------------------------------

test('insufficient data: an arm with n 29 never gets past the sample size', () => {
  const rows = rowsOf([...units('off', 27, 30), ...units('on', 27, 29)]);
  assert.equal(armRow(rows).n, 29);
  assert.equal(armRow(rows).verdict, 'insufficient data');
});

test('worse: the whole interval of d is below zero', () => {
  const rows = rowsOf([...units('off', 180, 200, (i) => 10 + (i % 5)), ...units('on', 120, 200, (i) => 10 + (i % 5))]);
  const r = armRow(rows);
  assert.ok(r.dCI[1] < 0);
  assert.equal(r.verdict, 'worse');
});

test('propose: not worse by more than the margin and cheaper', () => {
  const rows = rowsOf([...units('off', 180, 200, (i) => 10 + (i % 5)), ...units('on', 180, 200, (i) => 5 + (i % 5))]);
  const r = armRow(rows);
  assert.ok(r.dCI[0] >= -0.1);
  assert.ok(r.cCI[1] < 0);
  assert.equal(r.required, 112);
  assert.equal(r.verdict, 'propose');
});

test('non-inferior, not cheaper: not worse by more than the margin, cost not shown lower', () => {
  const rows = rowsOf([...units('off', 180, 200, (i) => 10 + (i % 5)), ...units('on', 180, 200, (i) => 11 + (i % 5))]);
  const r = armRow(rows);
  assert.ok(r.dCI[0] >= -0.1);
  assert.ok(r.cCI[1] >= 0);
  assert.equal(r.verdict, 'non-inferior, not cheaper');
});

test('inconclusive: the interval of d crosses both zero and the margin', () => {
  const rows = rowsOf([...units('off', 180, 200), ...units('on', 170, 200)]);
  const r = armRow(rows);
  assert.ok(r.dCI[0] < -0.1 && r.dCI[1] >= 0);
  assert.equal(r.verdict, 'inconclusive');
});

test('no fixture yields two verdicts: verdict() is one of the five strings over a grid of inputs', () => {
  const base = { nArm: 200, nControl: 200, required: 112, margin: 0.1 };
  for (const nArm of [10, 29, 30, 112, 200]) {
    for (const lower of [-0.3, -0.11, -0.1, -0.05, 0.02]) {
      for (const upper of [-0.2, -0.0001, 0, 0.05, 0.3]) {
        if (upper < lower) continue;
        for (const cUpper of [-1, 0, 2, null]) {
          const v = verdict({ ...base, nArm, lower, upper, cUpper });
          assert.equal(typeof v, 'string');
          assert.equal(VERDICTS.filter((s) => s === v).length, 1, `${JSON.stringify({ nArm, lower, upper, cUpper })} -> ${v}`);
        }
      }
    }
  }
});

test('verdict order: insufficient before worse, worse before propose, the margin bound is inclusive', () => {
  const ok = { nArm: 200, nControl: 200, required: 112, margin: 0.1 };
  assert.equal(verdict({ ...ok, nArm: 29, lower: -0.5, upper: -0.4, cUpper: -1 }), 'insufficient data');
  assert.equal(verdict({ ...ok, nArm: 400, nControl: 299, required: 300, lower: 0, upper: 0.1, cUpper: -1 }), 'insufficient data');
  assert.equal(verdict({ ...ok, lower: -0.09, upper: -0.01, cUpper: -1 }), 'worse');
  assert.equal(verdict({ ...ok, lower: -0.1, upper: 0.05, cUpper: -1 }), 'propose');
  assert.equal(verdict({ ...ok, lower: -0.1, upper: 0.05, cUpper: 0 }), 'non-inferior, not cheaper');
  assert.equal(verdict({ ...ok, lower: -0.1001, upper: 0.05, cUpper: -1 }), 'inconclusive');
});

test('parallelism objective tests the arm - control parallelism in place of cost', () => {
  const ok = { nArm: 200, nControl: 200, required: 112, margin: 0.1, objective: 'parallelism', lower: -0.05, upper: 0.05, cUpper: 5 };
  assert.equal(verdict({ ...ok, pLower: 0.2 }), 'propose');
  assert.equal(verdict({ ...ok, pLower: 0 }), 'non-inferior, not more parallel');
  assert.equal(verdict({ ...ok, pLower: null }), 'non-inferior, not more parallel');
  assert.equal(verdict({ ...ok, pLower: 0.2, lower: -0.2, upper: 0.1 }), 'inconclusive');
  const rows = buildRows(
    [...units('off', 180, 200, () => 1, { parallelism: 1.5 }), ...units('on', 180, 200, () => 1, { parallelism: 2.5 })],
    experiment({ objective: 'parallelism' }),
  );
  assert.equal(armRow(rows).verdict, 'propose');
  assert.ok(armRow(rows).pCI[0] > 0);
  assert.equal(armRow(rows).p, 1);
  assert.deepEqual(armRow(rows).cCI, [0, 0]); // the cost difference is still reported, and is none here
});

// ---- the row ------------------------------------------------------------------------------------------------------

test('a row has the shared shape; the control row carries no comparison', () => {
  const rows = rowsOf([...units('off', 180, 200, (i) => 10 + (i % 5)), ...units('on', 170, 200, (i) => 6 + (i % 5))]);
  assert.deepEqual(rows.map((r) => r.arm), ['off', 'on']);
  const [control, arm] = rows;
  assert.deepEqual(Object.keys(control).sort(), ['arm', 'c', 'cCI', 'control', 'costCI', 'costMedian', 'd', 'dCI', 'excluded', 'experiment', 'kind', 'models', 'n', 'p', 'pCI', 'parallelismCI', 'parallelismMedian', 'perProject', 'rate', 'rateCI', 'required', 'verdict'].sort());
  for (const k of ['p', 'pCI', 'parallelismMedian', 'parallelismCI']) assert.equal(control[k], null, k); // a cost experiment has none
  assert.equal(control.control, true);
  for (const k of ['d', 'dCI', 'c', 'cCI', 'required', 'verdict']) assert.equal(control[k], null, k);
  assert.equal(arm.control, false);
  assert.equal(arm.experiment, 'e1');
  assert.equal(arm.kind, 'session');
  assert.equal(control.n, 200);
  assert.equal(control.rate, 0.9);
  assert.equal(control.rateCI.length, 2);
  assert.equal(control.costMedian, 12);
  assert.equal(control.costCI.length, 2);
  assert.ok(Math.abs(arm.d - (-0.05)) < 1e-9);
  assert.equal(arm.required, 112);
  assert.deepEqual(Object.keys(arm.perProject), ['/home/x/Client']);
  assert.equal(arm.perProject['/home/x/Client'].n, 200);
});

test('contaminated sessions are excluded and counted, undecided likewise', () => {
  const all = [
    ...units('off', 36, 40),
    ...units('on', 36, 40),
    ...units('on', 0, 3, () => 1, { contaminated: true }),
    ...units('on', 0, 2).map((u) => ({ ...u, verdict: 'undecided' })),
    ...units('off', 0, 1).map((u) => ({ ...u, verdict: 'undecided' })),
    ...units('other', 5, 5),
  ];
  const rows = rowsOf(all);
  const [control, arm] = rows;
  assert.deepEqual(arm.excluded, { contaminated: 3, undecided: 2 });
  assert.deepEqual(control.excluded, { contaminated: 0, undecided: 1 });
  assert.equal(arm.n, 40);
  assert.equal(control.n, 40);
  assert.equal(arm.rate, 0.9);
  assert.equal(rows.length, 2);
});

test('models seen are listed per arm, sorted and unique', () => {
  const rows = rowsOf([
    ...units('off', 10, 20, () => 1, { models: ['m2', 'm1'] }),
    ...units('on', 10, 20, () => 1, { models: ['m3'] }),
    ...units('on', 10, 1, () => 1, { models: ['m3', 'm4'] }),
  ]);
  assert.deepEqual(rows[0].models, ['m1', 'm2']);
  assert.deepEqual(rows[1].models, ['m3', 'm4']);
});

test('per-project rows split the arm by project', () => {
  const rows = rowsOf([
    ...units('off', 10, 10, () => 4, { project: '/home/x/A' }), ...units('off', 5, 10, () => 8, { project: '/home/x/B' }),
    ...units('on', 10, 10, () => 2, { project: '/home/x/A' }),
  ]);
  const p = rows[0].perProject;
  assert.deepEqual(Object.keys(p).sort(), ['/home/x/A', '/home/x/B']);
  assert.equal(p['/home/x/A'].rate, 1);
  assert.equal(p['/home/x/B'].rate, 0.5);
  assert.equal(p['/home/x/B'].costMedian, 8);
  assert.equal(p['/home/x/B'].n, 10);
  assert.equal(rows[1].perProject['/home/x/A'].costMedian, 2);
});

test('control rate 1.0 gives required 0 and, below 30, insufficient data with no NaN', () => {
  const rows = rowsOf([...units('off', 12, 12), ...units('on', 12, 12)]);
  const r = armRow(rows);
  assert.equal(r.required, 0);
  assert.equal(r.verdict, 'insufficient data');
  assert.ok(!JSON.stringify(rows).includes('NaN'));
  const bad = (v) => typeof v === 'number' && !Number.isFinite(v);
  assert.ok(!JSON.stringify(rows, (k, v) => (bad(v) ? '__bad__' : v)).includes('__bad__'));
});

test('an arm with no counted units gives null statistics, not NaN', () => {
  const rows = rowsOf([...units('off', 12, 12)]);
  const r = armRow(rows);
  assert.equal(r.n, 0);
  for (const k of ['rate', 'rateCI', 'costMedian', 'costCI', 'd', 'dCI', 'c', 'cCI']) assert.equal(r[k], null, k);
  assert.equal(r.verdict, 'insufficient data');
});

// ---- sessionVerdict -----------------------------------------------------------------------------------------------

const snap = ({ checks = { 'code-a': 'pass' }, judges = ['judge-b'], judgeExclude = [], version = 'vc' } = {}) => ({
  hash: 'h',
  categories: [...Object.keys(checks).map((id) => ({ id, check: 'code' })), ...judges.map((id) => ({ id, check: 'judge' }))],
  judgeExclude,
  prompts: Object.fromEntries(judges.map((id) => [id, `hash-${id}`])),
  checks: { CHECKS: Object.fromEntries(Object.entries(checks).map(([id, r]) => [id, () => r])), runCheck: (id, s, f, c) => c[id](s, f), checkVersion: () => version },
});
const sess = { sessionId: 's1', project: '/home/x/Client', file: '/nowhere' };
const judged = (result, over = {}) => ({ sessionId: 's1', category: 'judge-b', result, promptHash: 'hash-judge-b', ...over });

test('sessionVerdict: any fail is unhealthy, then any undecided or missing judgment is undecided, else healthy', () => {
  assert.equal(sessionVerdict(sess, snap(), { 'judge-b': [judged('pass')] }), 'healthy');
  assert.equal(sessionVerdict(sess, snap(), { 'judge-b': [judged('fail')] }), 'unhealthy');
  assert.equal(sessionVerdict(sess, snap({ checks: { 'code-a': 'fail' } }), { 'judge-b': [judged('pass')] }), 'unhealthy');
  assert.equal(sessionVerdict(sess, snap({ checks: { 'code-a': 'undecided' } }), { 'judge-b': [judged('pass')] }), 'undecided');
  assert.equal(sessionVerdict(sess, snap(), { 'judge-b': [judged('undecided')] }), 'undecided');
  // a fail outranks an undecided
  assert.equal(sessionVerdict(sess, snap({ checks: { 'code-a': 'undecided' } }), { 'judge-b': [judged('fail')] }), 'unhealthy');
});

test('a unit with no guardrail verdict is undecided, not healthy', () => {
  assert.equal(sessionVerdict(sess, snap(), {}), 'undecided');
  assert.equal(sessionVerdict(sess, snap(), { 'judge-b': [] }), 'undecided');
  // a judgment of another session, or of another prompt, is no verdict
  assert.equal(sessionVerdict(sess, snap(), { 'judge-b': [judged('pass', { sessionId: 's2' })] }), 'undecided');
  assert.equal(sessionVerdict(sess, snap(), { 'judge-b': [judged('pass', { promptHash: 'older' })] }), 'undecided');
});

const stored = (result, over = {}) => ({ sessionId: 's1', category: 'code-a', result, promptHash: 'vc', ...over });

test('a code check that is undecided (transcript gone) takes the stored line of the snapshot check version', () => {
  const undecided = snap({ checks: { 'code-a': 'undecided' } });
  const base = { 'judge-b': [judged('pass')] };
  assert.equal(sessionVerdict(sess, undecided, { ...base, 'code-a': [stored('pass')] }), 'healthy');
  assert.equal(sessionVerdict(sess, undecided, { ...base, 'code-a': [stored('fail')] }), 'unhealthy');
  // the last stored line of that version wins; an undecided line stays undecided
  assert.equal(sessionVerdict(sess, undecided, { ...base, 'code-a': [stored('fail'), stored('pass')] }), 'healthy');
  assert.equal(sessionVerdict(sess, undecided, { ...base, 'code-a': [stored('undecided')] }), 'undecided');
});

test('a stored code line of another check version, or of another session, is no verdict', () => {
  const undecided = snap({ checks: { 'code-a': 'undecided' } });
  const base = { 'judge-b': [judged('pass')] };
  assert.equal(sessionVerdict(sess, undecided, { ...base, 'code-a': [stored('pass', { promptHash: 'older' })] }), 'undecided');
  assert.equal(sessionVerdict(sess, undecided, { ...base, 'code-a': [stored('pass', { sessionId: 's2' })] }), 'undecided');
  assert.equal(sessionVerdict(sess, undecided, base), 'undecided');
  // a check that decides is never overridden by a stored line
  assert.equal(sessionVerdict(sess, snap({ checks: { 'code-a': 'fail' } }), { ...base, 'code-a': [stored('pass')] }), 'unhealthy');
});

test('judgeExclude: a session of an excluded or unknown project has no judge verdict, a code check still runs', () => {
  const s = snap({ judgeExclude: ['/home/x/Client'] });
  const pass = { 'judge-b': [judged('pass')] };
  assert.equal(sessionVerdict(sess, s, pass, { home: '/home/x', platform: 'linux' }), 'undecided');
  assert.equal(sessionVerdict({ ...sess, project: null }, s, pass, { home: '/home/x', platform: 'linux' }), 'undecided');
  assert.equal(sessionVerdict({ ...sess, project: '/home/x/Other' }, s, pass, { home: '/home/x', platform: 'linux' }), 'healthy');
  assert.equal(sessionVerdict(sess, snap({ judges: [], judgeExclude: ['/home/x/Client'] }), {}, { home: '/home/x', platform: 'linux' }), 'healthy');
  assert.equal(sessionVerdict(sess, snap({ checks: { 'code-a': 'fail' }, judgeExclude: ['/home/x/Client'] }), pass, { home: '/home/x', platform: 'linux' }), 'unhealthy');
});

// ---- the command --------------------------------------------------------------------------------------------------

const CHECKS_SRC = `// invented frozen checks
import { readFileSync } from 'node:fs';
export const CHECKS = { 'chased-progress': (signals, file) => (readFileSync(file, 'utf8').includes('CHASED') ? 'fail' : 'pass') };
export function runCheck(id, signals, file, checks = CHECKS) {
  try { return checks[id](signals, file); } catch (err) { if (err?.code === 'ENOENT') return 'undecided'; throw err; }
}
export const checkVersion = () => 'v-snapshot';
`;
const LIVE_CHECKS_SRC = CHECKS_SRC.replace("includes('CHASED') ? 'fail' : 'pass'", "includes('CHASED') ? 'pass' : 'fail'");
const PROMPT = '---\nmodel: claude-haiku-5-5\n---\nJudge only this invented failure.\n';
const cat = (id, check) => ({ id, name: id, definition: `definition of ${id}`, examples: ['x1', 'x2', 'x3'], check });

// A temp world: an evals dir with a frozen snapshot (one code category, one judge category), the sessions store,
// the transcripts, the judgments, the SessionStart arm records and the experiments file. `plan` is
// [{ id, arm, start?, contaminated?, records?, code, judge, usd, project }]; `records` are the arm values (a string or
// null) of that session's SessionStart records, written to session-arms.jsonl.
function world(plan, { judgeExclude = [], expOver = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cm-t20-'));
  const evals = join(base, 'evals');
  const judgesDir = join(base, 'judges');
  const transcripts = join(base, 'transcripts');
  mkdirSync(evals, { recursive: true });
  mkdirSync(judgesDir);
  mkdirSync(join(transcripts, '-home-x-Client'), { recursive: true });
  writeFileSync(join(judgesDir, 'wrong-turn.md'), PROMPT);
  const checksFile = join(base, 'eval-checks.mjs');
  writeFileSync(checksFile, CHECKS_SRC);
  const taxonomy = { judgeExclude, categories: [cat('chased-progress', 'code'), cat('wrong-turn', 'judge')] };
  writeFileSync(join(evals, 'taxonomy.json'), JSON.stringify(taxonomy));
  const hash = snapshot({ categories: taxonomy.categories, judgeExclude, excluded: [] }, { evalsDir: evals, checksFile, judgesDir });
  const promptHash = loadJudgePrompt(join(judgesDir, 'wrong-turn.md')).hash;

  const sessions = [];
  const judgments = [];
  const codeLines = [];
  const armLines = [];
  for (const p of plan) {
    for (const arm of p.records ?? []) armLines.push(`${JSON.stringify({ sessionId: p.id, source: 'startup', arm, launchId: null, at: '2026-11-05T10:00:00.000Z' })}\n`);
    sessions.push({
      sessionId: p.id, project: p.project ?? '/home/x/Client', projectDir: '-home-x-Client', start: p.start ?? '2026-11-05T10:00:00.000Z',
      end: '2026-11-05T11:00:00.000Z', models: { [p.model ?? 'm1']: { messages: 3, usd: p.usd } }, usd: p.usd, arm: p.arm ?? null, contaminated: p.contaminated === true,
      ...(p.entrypoint === undefined ? {} : { entrypoint: p.entrypoint }),
    });
    // A recorded verdict of the code check (`triqual eval check` wrote it), under the snapshot's check version.
    if (p.stored) codeLines.push({ sessionId: p.id, category: 'chased-progress', result: p.stored.result, promptHash: p.stored.promptHash ?? 'v-snapshot', model: null, auth: 'code', at: '2026-11-06T00:00:00Z' });
    if (p.code !== null) writeFileSync(join(transcripts, '-home-x-Client', `${p.id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: p.code === 'fail' ? 'CHASED invented' : 'fine invented' } })}\n`);
    if (p.judge) judgments.push({ sessionId: p.id, category: 'wrong-turn', result: p.judge, promptHash, model: 'claude-haiku-5-5', auth: 'x', at: '2026-11-06T00:00:00Z' });
  }
  // The last line is cut off mid-write, as a crashed hook leaves it: the reader skips it.
  if (armLines.length > 0) writeFileSync(join(evals, 'session-arms.jsonl'), `${armLines.join('')}{"sessionId":"x","arm":"e1/o`);
  writeFileSync(join(evals, 'sessions.jsonl'), sessions.map((s) => `${JSON.stringify(s)}\n`).join(''));
  mkdirSync(join(evals, 'judgments'));
  writeFileSync(join(evals, 'judgments', 'wrong-turn.jsonl'), judgments.map((j) => `${JSON.stringify(j)}\n`).join(''));
  writeFileSync(join(evals, 'judgments', 'chased-progress.jsonl'), codeLines.map((j) => `${JSON.stringify(j)}\n`).join(''));
  const experiments = join(base, 'experiments.json');
  writeFileSync(experiments, JSON.stringify({ experiments: [{ ...experiment({ evaluators: hash }), ...expOver }] }));
  const env = {
    HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals, TRIQUAL_EXPERIMENTS_FILE: experiments, TRIQUAL_TRANSCRIPTS_DIR: transcripts,
  };
  return { base, evals, env, checksFile, hash, taxonomyFile: join(evals, 'taxonomy.json') };
}

async function run(argv, env) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, platform: 'linux' });
  return { code, out, err };
}

const mk = (n, arm, over = {}) => Array.from({ length: n }, (_, i) => ({ id: `${arm}-${i}`, arm: `e1/${arm}`, code: 'pass', judge: 'pass', usd: 2, ...over }));

test('report --json prints the experiments with their rows, scored by the snapshot', async () => {
  const w = world([
    ...mk(4, 'off'), ...mk(3, 'on'), { id: 'on-bad', arm: 'e1/on', code: 'fail', judge: 'pass', usd: 3 },
    { id: 'on-nojudge', arm: 'e1/on', code: 'pass', judge: null, usd: 3 },
    { id: 'on-old', arm: 'e1/on', start: '2026-10-01T00:00:00Z', code: 'fail', judge: 'fail', usd: 3 },
    { id: 'no-arm', arm: null, code: 'fail', judge: 'fail', usd: 3 },
    // The sessions store never writes an arm next to contaminated: true; the arm is only in the SessionStart records.
    { id: 'on-contam', arm: null, contaminated: true, records: ['e1/on', null], code: 'pass', judge: 'pass', usd: 3 },
    { id: 'off-contam', arm: null, contaminated: true, records: ['e1/off', 'e1/off', null], code: 'pass', judge: 'pass', usd: 3 },
    { id: 'both-contam', arm: null, contaminated: true, records: ['e1/on', 'e1/off'], code: 'pass', judge: 'pass', usd: 3 },
    { id: 'other-contam', arm: null, contaminated: true, records: ['e2/on', null], code: 'pass', judge: 'pass', usd: 3 },
    { id: 'old-contam', arm: null, contaminated: true, start: '2026-10-01T00:00:00Z', records: ['e1/on', null], code: 'pass', judge: 'pass', usd: 3 },
  ]);
  try {
    const { code, out } = await run(['--json'], w.env);
    assert.equal(code, 0);
    const j = JSON.parse(out);
    assert.equal(j.experiments.length, 1);
    const e = j.experiments[0];
    assert.deepEqual(Object.keys(e).sort(), ['evaluators', 'id', 'kind', 'margin', 'rows', 'status']);
    assert.equal(e.id, 'e1');
    assert.equal(e.evaluators, w.hash);
    const [off, on] = e.rows;
    assert.equal(off.n, 4);
    assert.equal(off.rate, 1);
    assert.equal(on.n, 4); // 3 healthy + 1 unhealthy; the other with no judgment is undecided, the older one is before start
    assert.equal(on.rate, 0.75);
    assert.deepEqual(on.excluded, { contaminated: 1, undecided: 1 });
    assert.deepEqual(off.excluded, { contaminated: 1, undecided: 0 }); // both-contam, other-contam and old-contam count nowhere
    assert.deepEqual(on.models, ['m1']);
    assert.equal(on.verdict, 'insufficient data');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a session whose transcript is deleted keeps its stored code verdict; another check version leaves it undecided', async () => {
  const w = world([
    ...mk(3, 'off'),
    ...mk(2, 'on'),
    { id: 'on-gone-pass', arm: 'e1/on', code: null, judge: 'pass', usd: 2, stored: { result: 'pass' } },
    { id: 'on-gone-fail', arm: 'e1/on', code: null, judge: 'pass', usd: 2, stored: { result: 'fail' } },
    { id: 'on-gone-old', arm: 'e1/on', code: null, judge: 'pass', usd: 2, stored: { result: 'pass', promptHash: 'older' } },
    { id: 'on-gone-none', arm: 'e1/on', code: null, judge: 'pass', usd: 2 },
  ]);
  try {
    const { code, out } = await run(['--json'], w.env);
    assert.equal(code, 0);
    const [, on] = JSON.parse(out).experiments[0].rows;
    assert.equal(on.n, 4); // 2 with a transcript, the stored pass and the stored fail
    assert.equal(on.rate, 0.75);
    assert.deepEqual(on.excluded, { contaminated: 0, undecided: 2 });
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('only interactive sessions are units: a print-mode child of an assigned session is not counted', async () => {
  const w = world([
    ...mk(3, 'off'),
    { id: 'on-cli', arm: 'e1/on', entrypoint: 'cli', code: 'pass', judge: 'pass', usd: 2 },
    // a `claude -p` started inside the assigned session inherits its arm in the environment
    { id: 'on-print', arm: 'e1/on', entrypoint: 'sdk-cli', code: 'pass', judge: 'pass', usd: 2 },
    { id: 'on-print-bad', arm: 'e1/on', entrypoint: 'sdk-cli', code: 'fail', judge: 'pass', usd: 2 },
    { id: 'on-print-contam', arm: null, entrypoint: 'sdk-cli', contaminated: true, records: ['e1/on', null], code: 'pass', judge: 'pass', usd: 2 },
    // an older store line has no entrypoint: it counts as before
    { id: 'on-old', arm: 'e1/on', code: 'pass', judge: 'pass', usd: 2 },
  ]);
  try {
    const { code, out } = await run(['--json'], w.env);
    assert.equal(code, 0);
    const [off, on] = JSON.parse(out).experiments[0].rows;
    assert.equal(off.n, 3);
    assert.equal(on.n, 2); // on-cli and on-old
    assert.equal(on.rate, 1);
    assert.deepEqual(on.excluded, { contaminated: 0, undecided: 0 });
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a change to taxonomy.json or to the checks after start does not change the scores', async () => {
  const w = world([
    ...mk(6, 'off'), ...mk(5, 'on'), { id: 'on-bad', arm: 'e1/on', code: 'fail', judge: 'pass', usd: 3 },
  ]);
  try {
    const first = await run(['--json'], w.env);
    assert.equal(first.code, 0);
    const before = JSON.parse(first.out);
    assert.equal(before.experiments[0].rows[1].rate, 5 / 6);
    // The owner edits the live taxonomy and the live checks (the checks now judge the opposite way).
    writeFileSync(w.taxonomyFile, JSON.stringify({ judgeExclude: ['/home/x/Client'], categories: [cat('chased-progress', 'code')] }));
    writeFileSync(w.checksFile, LIVE_CHECKS_SRC);
    const second = await run(['--json'], w.env);
    assert.equal(second.code, 0);
    assert.deepEqual(JSON.parse(second.out), before);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('judgeExclude of the snapshot: a session of an excluded project is undecided and counted', async () => {
  const w = world([
    ...mk(5, 'off'), ...mk(4, 'on'), ...mk(2, 'on', { project: '/home/x/Other', id: undefined }).map((s, i) => ({ ...s, id: `on-o${i}`, project: '/home/x/Other' })),
  ], { judgeExclude: ['/home/x/Client'] });
  try {
    const { code, out } = await run(['--json'], w.env);
    assert.equal(code, 0);
    const [off, on] = JSON.parse(out).experiments[0].rows;
    assert.equal(off.n, 0);
    assert.deepEqual(off.excluded, { contaminated: 0, undecided: 5 });
    assert.equal(on.n, 2);
    assert.deepEqual(on.excluded, { contaminated: 0, undecided: 4 });
    assert.deepEqual(Object.keys(on.perProject), ['/home/x/Other']);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a control rate of 1.0 gives required 0 and insufficient data below 30; --json holds no NaN', async () => {
  const w = world([...mk(6, 'off'), ...mk(6, 'on')]);
  try {
    const { code, out } = await run(['--json'], w.env);
    assert.equal(code, 0);
    assert.ok(!out.includes('NaN'));
    const [, on] = JSON.parse(out).experiments[0].rows;
    assert.equal(on.required, 0);
    assert.equal(on.verdict, 'insufficient data');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('without --json the report prints counts, ids, models and projects, never transcript text', async () => {
  const w = world([...mk(6, 'off'), ...mk(6, 'on', { model: 'm2' })]);
  try {
    const { code, out } = await run([], w.env);
    assert.equal(code, 0);
    assert.match(out, /e1/);
    assert.match(out, /insufficient data/);
    assert.match(out, /m2/);
    assert.match(out, /\/home\/x\/Client/);
    assert.ok(!out.includes('invented'));
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('--experiment selects one experiment; an unknown id exits 2', async () => {
  const w = world([...mk(6, 'off'), ...mk(6, 'on')]);
  try {
    const one = await run(['--experiment', 'e1', '--json'], w.env);
    assert.equal(one.code, 0);
    assert.equal(JSON.parse(one.out).experiments.length, 1);
    const none = await run(['--experiment', 'nope', '--json'], w.env);
    assert.equal(none.code, 2);
    assert.equal(none.out, '');
    assert.match(none.err, /no experiment nope/);
    assert.equal((await run(['--bogus'], w.env)).code, 2);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('an experiment that was never started, a role experiment and no experiments file report no rows', async () => {
  const w = world([...mk(2, 'off')], { expOver: { status: 'paused', start: undefined, evaluators: undefined } });
  try {
    const paused = JSON.parse((await run(['--json'], w.env)).out).experiments[0];
    assert.deepEqual(paused.rows, []);
    writeFileSync(w.env.TRIQUAL_EXPERIMENTS_FILE, JSON.stringify({ experiments: [{ id: 'r1', kind: 'role', status: 'paused', control: 'a', arms: { a: { role: 'x', model: 'opus', effort: 'low' }, b: { role: 'x', model: 'sonnet', effort: 'low' } } }] }));
    const role = JSON.parse((await run(['--json'], w.env)).out).experiments[0];
    assert.deepEqual([role.id, role.kind, role.margin, role.rows], ['r1', 'role', 0.1, []]);
    rmSync(w.env.TRIQUAL_EXPERIMENTS_FILE);
    const empty = await run(['--json'], w.env);
    assert.equal(empty.code, 0);
    assert.deepEqual(JSON.parse(empty.out), { experiments: [] });
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a missing snapshot directory is reported by experiment id and exits 1', async () => {
  const w = world([...mk(2, 'off')], { expOver: { evaluators: 'f'.repeat(64) } });
  try {
    const r = await run(['--json'], w.env);
    assert.equal(r.code, 1);
    assert.match(r.err, /e1: snapshot/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a snapshot whose taxonomy has no categories list is unreadable, not "no evaluators"', async () => {
  for (const doc of [{}, { categories: 'x' }, { categories: null }, { categories: {} }]) {
    const w = world([...mk(6, 'off'), ...mk(6, 'on')]);
    try {
      writeFileSync(join(w.evals, 'snapshots', w.hash, 'taxonomy.json'), JSON.stringify(doc));
      const r = await run(['--json'], w.env);
      assert.equal(r.code, 1, JSON.stringify(doc));
      assert.match(r.err, /e1: snapshot/);
      assert.equal(r.out, '', 'no rows of healthy sessions are printed');
    } finally { rmSync(w.base, { recursive: true, force: true }); }
  }
});

test('a check of the snapshot that throws ends the report with exit 1 and one stderr line', async () => {
  const w = world([...mk(6, 'off'), ...mk(6, 'on')]);
  try {
    writeFileSync(join(w.evals, 'snapshots', w.hash, 'eval-checks.mjs'), [
      "export const CHECKS = { 'chased-progress': () => 'pass' };",
      "export function runCheck() { throw new TypeError('invented failure with transcript text'); }",
      "export const checkVersion = () => 'v-snapshot';",
      '',
    ].join('\n'));
    const r = await run(['--json'], w.env);
    assert.equal(r.code, 1);
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
    assert.match(r.err, /triqual eval report: e1: .*check/);
    assert.ok(!r.err.includes('transcript text'), 'the message of the error is not printed');
    assert.equal(r.out, '');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('eval.mjs dispatches the report command', async () => {
  const w = world([...mk(6, 'off'), ...mk(6, 'on')]);
  try {
    let out = '';
    const code = await evalMain(['report', '--json'], { env: w.env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).experiments[0].id, 'e1');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('the report is written to stdout only, and the data it reads stays unchanged', async () => {
  const w = world([...mk(6, 'off'), ...mk(6, 'on')]);
  try {
    const before = readFileSync(join(w.evals, 'sessions.jsonl'), 'utf8');
    await run(['--json'], w.env);
    assert.equal(readFileSync(join(w.evals, 'sessions.jsonl'), 'utf8'), before);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});
