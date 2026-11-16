import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionSignals } from '../cli/lib/eval-sessions.mjs';
import { inWindow, refreshSessions } from '../cli/lib/eval-store.mjs';
import { moreRandom } from '../cli/lib/eval-sample.mjs';
import { main } from '../cli/eval-review.mjs';

// Invented fixtures only: no real transcript text.
const PRICES = { 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } };
const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evver-'));
const jsonl = (recs) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`;
const path = (v) => `/home/u/.claude/plugins/cache/triqual/methodology/${v}/skills/x/SKILL.md`;
const turn = (id, at, model = 'claude-opus-5-5') => ({
  type: 'assistant', requestId: `r-${id}`, timestamp: at,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'zz' }], usage: { input_tokens: 10, output_tokens: 5 } },
});
const user = (text, at) => ({ type: 'user', cwd: '/work/p', entrypoint: 'cli', timestamp: at, message: { role: 'user', content: text } });

test('methodologyVersion is the first x.y.z of the cache path anywhere in the transcript', () => {
  const dir = tmp();
  const file = join(dir, 's1.jsonl');
  writeFileSync(file, jsonl([
    user('hello', '2026-11-01T10:00:00.000Z'),
    user(`Base directory for this skill: ${path('1.9.3')}`, '2026-11-01T10:00:01.000Z'),
    user(`later ${path('1.10.0')}`, '2026-11-01T10:00:02.000Z'),
  ]));
  assert.equal(sessionSignals(file, { prices: PRICES }).methodologyVersion, '1.9.3');
});

test('methodologyVersion is null when no cache path appears', () => {
  const dir = tmp();
  const file = join(dir, 's2.jsonl');
  writeFileSync(file, jsonl([
    user('see plugins/cache/other/methodology/1.2.3/ and plugins/cache/triqual/methodology/latest/', '2026-11-01T10:00:00.000Z'),
  ]));
  assert.equal(sessionSignals(file, { prices: PRICES }).methodologyVersion, null);
  assert.equal(sessionSignals(join(dir, 'missing.jsonl'), { prices: PRICES }).methodologyVersion, null);
});

test('refreshSessions rewrites a stored line that lacks the key, once', () => {
  const dir = tmp();
  const root = join(dir, 'projects');
  mkdirSync(join(root, '-work-p'), { recursive: true });
  writeFileSync(join(root, '-work-p', 'old.jsonl'), jsonl([
    user(`skill at ${path('1.9.3')}`, '2026-11-01T10:00:00.000Z'),
    turn('m1', '2026-11-01T10:00:05.000Z'),
  ]));
  const file = join(dir, 'evals', 'sessions.jsonl');
  const first = refreshSessions({ root, file, prices: PRICES, now: new Date('2026-11-02T00:00:00.000Z') });
  assert.equal(first.added, 1);
  // The stored line as an older extractor wrote it: no methodologyVersion key.
  const stored = JSON.parse(readFileSync(file, 'utf8').trim());
  delete stored.methodologyVersion;
  // A stored line whose transcript is gone stays as it is.
  const gone = { sessionId: 'gone', entrypoint: 'cli', end: '2026-10-01T00:00:00.000Z', usd: 1 };
  writeFileSync(file, `${JSON.stringify(stored)}\n${JSON.stringify(gone)}\n`);

  const second = refreshSessions({ root, file, prices: PRICES, now: new Date('2026-11-03T00:00:00.000Z') });
  assert.equal(second.updated, 1);
  assert.equal(second.added, 0);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const old = lines.find((l) => l.sessionId === 'old');
  assert.equal(old.methodologyVersion, '1.9.3');
  assert.equal(old.projectDir, '-work-p');
  assert.deepEqual(lines.find((l) => l.sessionId === 'gone'), gone, 'a line whose transcript is gone is untouched');

  const third = refreshSessions({ root, file, prices: PRICES, now: new Date('2026-11-04T00:00:00.000Z') });
  assert.equal(third.updated, 0);
});

test('inWindow keeps a model named __proto__ off the prototype', () => {
  const sig = JSON.parse('{"sessionId":"p","days":{"2026-11-01":{"__proto__":{"messages":2,"usd":0.5},"claude-opus-5-5":{"messages":1,"usd":0.25}}}}');
  const w = inWindow(sig, { since: '2026-11-01' });
  assert.equal({}.messages, undefined, 'Object.prototype was not touched');
  assert.equal(w.turns, 3);
  assert.equal(w.usd, 0.75);
  assert.deepEqual(Object.keys(w.models).sort(), ['__proto__', 'claude-opus-5-5']);
  assert.equal(Object.getOwnPropertyDescriptor(w.models, '__proto__').value.messages, 2);
});

// Every fixture transcript is days older than the tests' clock (2026-11-18), so none may still be running.
const OLD = new Date('2026-11-01T00:00:00Z');
const age = (file, at = OLD) => utimesSync(file, at, at);

const sess = (id, start) => ({ sessionId: id, entrypoint: 'cli', projectDir: '-w', start, usd: 1, turns: 1 });
const ROOT = '/fixture/projects';

test('moreRandom with a day never returns an earlier day, and returns fewer than k when fewer exist', () => {
  const sessions = [
    sess('a1', '2026-11-14T23:59:59.999Z'), sess('a2', '2026-11-15T08:00:00.000Z'),
    sess('b1', '2026-11-16T00:00:00.000Z'), sess('b2', '2026-11-16T09:30:00.000Z'), sess('b3', '2026-11-17T01:00:00.000Z'),
    { ...sess('nostart', null) }, { ...sess('numstart', 5) },
  ];
  const more = moreRandom(sessions, [], 10, 1, { root: ROOT, since: '2026-11-16' });
  assert.deepEqual(more.map((r) => r.sessionId).sort(), ['b1', 'b2', 'b3']);
  assert.equal(moreRandom(sessions, [], 2, 1, { root: ROOT, since: '2026-11-16' }).length, 2);
  assert.equal(moreRandom(sessions, [], 10, 1, { root: ROOT }).length, 7, 'without since every cli session is a candidate');
});

test('moreRandom with a timestamp leaves out a session that started earlier the same day', () => {
  const sessions = [sess('early', '2026-11-16T08:00:00.000Z'), sess('late', '2026-11-16T12:00:00.000Z'), sess('exact', '2026-11-16T10:00:00.000Z')];
  const more = moreRandom(sessions, [], 10, 1, { root: ROOT, since: '2026-11-16T10:00:00.000Z' });
  assert.deepEqual(more.map((r) => r.sessionId).sort(), ['exact', 'late']);
});

function fixture() {
  const home = tmp();
  const evals = join(home, 'evals');
  const root = join(home, 'projects');
  mkdirSync(join(root, '-w'), { recursive: true });
  const ids = ['s1', 's2', 's3'];
  const days = ['2026-11-10', '2026-11-16', '2026-11-17'];
  ids.forEach((id, i) => {
    writeFileSync(join(root, '-w', `${id}.jsonl`), jsonl([user('hi', `${days[i]}T10:00:00.000Z`), turn(`m-${id}`, `${days[i]}T10:00:05.000Z`)]));
    age(join(root, '-w', `${id}.jsonl`));
  });
  mkdirSync(join(evals, 'review'), { recursive: true });
  writeFileSync(join(evals, 'review', 'sample.jsonl'), `${JSON.stringify({ sessionId: 'seed0', project: null, file: null, stratum: 'random', usd: 0, turns: 0 })}\n`);
  return { env: { HOME: home, TRIQUAL_EVALS_DIR: evals, TRIQUAL_TRANSCRIPTS_DIR: root }, evals };
}
const run = async (f, argv) => {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: f.env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, now: () => new Date('2026-11-18T00:00:00.000Z'),
  });
  return { code, out, err };
};

test('review sample --more --since draws only sessions from that day on', async () => {
  const f = fixture();
  const r = await run(f, ['sample', '--more', '5', '--seed', '1', '--since', '2026-11-16']);
  assert.equal(r.code, 0, r.err);
  const rows = readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.sessionId).sort(), ['s2', 's3', 'seed0']);
  assert.match(r.out, /Added 2 of 5/);
  // a full timestamp with an offset is accepted and compared as the UTC instant
  const f2 = fixture();
  const r2 = await run(f2, ['sample', '--more', '5', '--seed', '1', '--since', '2026-11-16T13:00:00+02:00']);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /Added 1 of 5/, '11:00Z is after the 10:00Z session of the 16th');
});

test('review sample rejects a malformed --since, and --since without --more, with exit 2', async () => {
  const f = fixture();
  const before = readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8');
  for (const argv of [['sample', '--more', '3', '--since', '16-11-2026'], ['sample', '--more', '3', '--since', '2026-13-45'],
    ['sample', '--more', '3', '--since', '2026-11-16T10:00']]) {
    const r = await run(f, argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /--since needs a day/);
  }
  for (const argv of [['sample', '--since', '2026-11-16'], ['sample', '--n', '5', '--since', '2026-11-16']]) {
    const r = await run(f, argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, /--since needs --more/);
  }
  assert.equal(readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8'), before, 'nothing was written');
});

// Sessions whose transcript holds no user or assistant text are still cli sessions with a start.
const textless = (at) => jsonl([{ type: 'user', cwd: '/work/p', entrypoint: 'cli', timestamp: at, message: { role: 'user', content: [] } }]);

function mixedFixture() {
  const home = tmp();
  const evals = join(home, 'evals');
  const root = join(home, 'projects');
  mkdirSync(join(root, '-w'), { recursive: true });
  const good = ['g1', 'g2', 'g3', 'g4', 'g5'];
  const bad = ['t1', 't2', 't3', 't4'];
  good.forEach((id, i) => writeFileSync(join(root, '-w', `${id}.jsonl`), jsonl([user(`invented task ${id}`, `2026-11-1${i}T10:00:00.000Z`), turn(`m-${id}`, `2026-11-1${i}T10:00:05.000Z`)])));
  bad.forEach((id, i) => writeFileSync(join(root, '-w', `${id}.jsonl`), textless(`2026-11-1${i}T11:00:00.000Z`)));
  for (const id of [...good, ...bad]) age(join(root, '-w', `${id}.jsonl`));
  mkdirSync(join(evals, 'review'), { recursive: true });
  const first = `${JSON.stringify({ sessionId: 'seed0', project: null, file: null, stratum: 'cost', usd: 1.5, turns: 3, note: 'kept as is' })}\n`;
  const second = `${JSON.stringify({ sessionId: 'seed1', project: '/work/q', file: '/gone/x.jsonl', stratum: 'random', usd: 0, turns: 0 })}\n`;
  writeFileSync(join(evals, 'review', 'sample.jsonl'), first + second);
  return { env: { HOME: home, TRIQUAL_EVALS_DIR: evals, TRIQUAL_TRANSCRIPTS_DIR: root }, root, evals, existing: first + second, good, bad };
}

test('review sample --more never adds a session with nothing to judge, still adds k rows, and leaves the existing rows as they were', async () => {
  for (const seed of ['1', '2', '3', '4', '5', '6']) {
    const f = mixedFixture();
    const r = await run(f, ['sample', '--more', '4', '--seed', seed]);
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8');
    assert.ok(text.startsWith(f.existing), 'the existing rows are byte for byte unchanged');
    const added = text.slice(f.existing.length).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(added.length, 4, `seed ${seed}: k rows`);
    assert.ok(added.every((x) => f.good.includes(x.sessionId) && x.stratum === 'random'), `seed ${seed}: ${added.map((x) => x.sessionId)}`);
    assert.match(r.out, /Added 4 of 4/);
    // the same seed over the same population gives the same rows
    const g = mixedFixture();
    await run(g, ['sample', '--more', '4', '--seed', seed]);
    const again = readFileSync(join(g.evals, 'review', 'sample.jsonl'), 'utf8').slice(g.existing.length).trim().split('\n').map((l) => JSON.parse(l).sessionId);
    assert.deepEqual(again, added.map((x) => x.sessionId));
  }
});

test('review sample --more adds fewer than k when fewer sessions with text exist', async () => {
  const f = mixedFixture();
  const r = await run(f, ['sample', '--more', '20', '--seed', '1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Added 5 of 20/);
  const added = readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8').slice(f.existing.length).trim().split('\n').map((l) => JSON.parse(l).sessionId);
  assert.deepEqual(added.sort(), f.good);
});

test('review sample --more passes over a candidate whose transcript changed 10 minutes before now, adds k rows from the others, and a later run can take it', async () => {
  const sampleIds = (f) => readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8').slice(f.existing.length).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).sessionId);
  for (const seed of ['1', '2', '3', '4']) {
    const f = mixedFixture();
    age(join(f.root, '-w', 'g1.jsonl'), new Date('2026-11-17T23:50:00Z')); // `now` of run() is 2026-11-18T00:00Z
    const r = await run(f, ['sample', '--more', '4', '--seed', seed]);
    assert.equal(r.code, 0, r.err);
    const added = sampleIds(f);
    assert.equal(added.length, 4, `seed ${seed}: k rows`);
    assert.ok(!added.includes('g1'), `seed ${seed}: ${added}`);
    assert.ok(added.every((id) => f.good.includes(id)));
    const g = mixedFixture();
    age(join(g.root, '-w', 'g1.jsonl'), new Date('2026-11-17T23:50:00Z'));
    await run(g, ['sample', '--more', '4', '--seed', seed]);
    assert.deepEqual(sampleIds(g), added, 'deterministic');
  }
  const f = mixedFixture();
  age(join(f.root, '-w', 'g1.jsonl'), new Date('2026-11-17T23:50:00Z'));
  assert.match((await run(f, ['sample', '--more', '20', '--seed', '1'])).out, /Added 4 of 20/);
  age(join(f.root, '-w', 'g1.jsonl'));
  assert.match((await run(f, ['sample', '--more', '20', '--seed', '1'])).out, /Added 1 of 20/);
});

test('moreRandom with since compares the last activity: end when there is one, else start', () => {
  const at = (id, start, end) => ({ ...sess(id, start), ...(end === undefined ? {} : { end }) });
  const sessions = [
    at('long', '2026-11-10T08:00:00.000Z', '2026-11-16T09:00:00.000Z'), // started before, ended after: a candidate
    at('over', '2026-11-10T08:00:00.000Z', '2026-11-12T09:00:00.000Z'), // ended before: not
    at('noend', '2026-11-17T08:00:00.000Z'),                            // no end: its start
    at('noend-early', '2026-11-12T08:00:00.000Z'),
    at('nullend', '2026-11-17T08:00:00.000Z', null),                    // a null end is no end
    at('later', '2026-11-17T08:00:00.000Z', '2026-11-17T09:00:00.000Z'),
  ];
  const ids = (since) => moreRandom(sessions, [], 10, 1, { root: ROOT, since }).map((r) => r.sessionId).sort();
  assert.deepEqual(ids('2026-11-16'), ['later', 'long', 'noend', 'nullend']);
  assert.deepEqual(ids('2026-11-16T09:00:00.000Z'), ['later', 'long', 'noend', 'nullend']);
  assert.deepEqual(ids('2026-11-16T09:00:00.001Z'), ['later', 'noend', 'nullend']);
});

test('moreRandom stamps `at` on each added row when given, and on none otherwise', () => {
  const sessions = [sess('a', '2026-11-16T08:00:00.000Z'), sess('b', '2026-11-16T09:00:00.000Z')];
  const stamped = moreRandom(sessions, [], 10, 1, { root: ROOT, at: '2026-11-18T00:00:00.000Z' });
  assert.deepEqual(stamped.map((r) => r.at), ['2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z']);
  assert.ok(moreRandom(sessions, [], 10, 1, { root: ROOT }).every((r) => !('at' in r)));
});

test('review sample --more stamps every added row with the command\'s now and leaves the existing rows as they were', async () => {
  const f = mixedFixture();
  const r = await run(f, ['sample', '--more', '3', '--seed', '2']);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(join(f.evals, 'review', 'sample.jsonl'), 'utf8');
  assert.ok(text.startsWith(f.existing), 'the existing rows are byte for byte unchanged');
  const added = text.slice(f.existing.length).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(added.length, 3);
  assert.ok(added.every((x) => x.at === '2026-11-18T00:00:00.000Z'), JSON.stringify(added.map((x) => x.at)));
  assert.ok(f.existing.trim().split('\n').every((l) => !('at' in JSON.parse(l))));
  // the first stratified draw stays without it
  const g = mixedFixture();
  rmSync(join(g.evals, 'review', 'sample.jsonl'));
  assert.equal((await run(g, ['sample', '--n', '4', '--seed', '2'])).code, 0);
  assert.ok(readFileSync(join(g.evals, 'review', 'sample.jsonl'), 'utf8').trim().split('\n').every((l) => !('at' in JSON.parse(l))));
});
