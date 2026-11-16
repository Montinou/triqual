import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderForJudge } from '../cli/lib/eval-judge.mjs';
import { QUIET_MS, keepRenders, renderPath, sessionRender, transcriptQuiet, transcriptReadable } from '../cli/lib/eval-renders.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evrender-'));
const mode = (f) => statSync(f).mode & 0o777;
// The fixed clock of these tests: a transcript is by default two days old at NOW, so it is quiet; `ageMs` sets another age.
const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const keep = (f, over = {}) => keepRenders({ evals: f.evals, sessions: f.sessions, now: () => NOW, ...over });
const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });

// A temp evals directory and a transcripts directory with the named sessions: `text` is the transcript's user text, null
// writes a transcript with no text at all, and `missing` writes no file.
function fixture(specs) {
  const base = tmp();
  const evals = join(base, 'evals');
  const root = join(base, 'projects');
  mkdirSync(root, { recursive: true });
  const sessions = specs.map(({ id, text, missing = false, excluded = false, raw, ageMs = 2 * DAY }) => {
    const file = join(root, `${id}.jsonl`);
    if (!missing) {
      if (raw !== undefined) writeFileSync(file, raw);
      const lines = text === null ? [JSON.stringify({ type: 'summary', summary: 'no turns' })] : [turn('user', text), turn('assistant', 'invented reply')];
      if (raw === undefined) writeFileSync(file, `${lines.join('\n')}\n`);
      utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
    }
    return { sessionId: id, file, excluded };
  });
  return { base, evals, root, sessions };
}

test('renderPath is <evals>/review/renders/<id>.txt and refuses an id that is not a plain file name', () => {
  assert.equal(renderPath('/e', 's1'), join('/e', 'review', 'renders', 's1.txt'));
  assert.equal(renderPath('/e', '0a1b2c3d-1111-2222-3333-444455556666'), join('/e', 'review', 'renders', '0a1b2c3d-1111-2222-3333-444455556666.txt'));
  for (const bad of ['../x', 'a/b', 'a\\b', '..', 'a..b', '', '.hidden', undefined, null, 7, 'x'.repeat(200)]) {
    assert.throws(() => renderPath('/e', bad), /session id/, String(bad));
  }
});

test('keepRenders writes the render of a session with text: file 0600, directory 0700, exactly the judge render; a second call writes nothing', () => {
  const f = fixture([{ id: 's1', text: 'invented task one' }, { id: 's2', text: 'invented task two' }]);
  try {
    const first = keep(f);
    assert.deepEqual(first, { kept: 2, empty: 0, unreadable: 0, failed: 0 });
    const dir = join(f.evals, 'review', 'renders');
    assert.equal(mode(dir), 0o700);
    for (const s of f.sessions) {
      const file = renderPath(f.evals, s.sessionId);
      assert.equal(mode(file), 0o600);
      assert.equal(readFileSync(file, 'utf8'), renderForJudge(s.file));
      assert.ok(readFileSync(file, 'utf8').includes('invented task'));
    }
    assert.deepEqual(readdirSync(dir).sort(), ['s1.txt', 's2.txt'], 'no temp file is left');
    const before = readFileSync(renderPath(f.evals, 's1'), 'utf8');
    writeFileSync(f.sessions[0].file, `${turn('user', 'a rewritten transcript')}\n`);
    assert.deepEqual(keep(f), { kept: 0, empty: 0, unreadable: 0, failed: 0 });
    assert.equal(readFileSync(renderPath(f.evals, 's1'), 'utf8'), before, 'a kept render is not rendered again');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders: a readable transcript with no text counts empty and writes no file; a missing one counts unreadable', () => {
  const f = fixture([{ id: 'e1', text: null }, { id: 'e2', raw: '' }, { id: 'm1', missing: true }, { id: 'ok', text: 'invented task' }]);
  f.sessions.push({ sessionId: 'nofile', file: null, excluded: false });
  try {
    assert.deepEqual(keep(f), { kept: 1, empty: 2, unreadable: 2, failed: 0 });
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')), ['ok.txt']);
    // the same again: empty and unreadable ones are counted every time, nothing is written
    assert.deepEqual(keep(f), { kept: 0, empty: 2, unreadable: 2, failed: 0 });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders writes no directory when there is nothing to keep', () => {
  const f = fixture([{ id: 'e1', text: null }]);
  try {
    assert.deepEqual(keep(f), { kept: 0, empty: 1, unreadable: 0, failed: 0 });
    assert.equal(existsSync(join(f.evals, 'review', 'renders')), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders never renders or keeps an excluded session', () => {
  const f = fixture([{ id: 'x1', text: 'invented client text', excluded: true }, { id: 'x2', text: 'invented task' }]);
  try {
    assert.deepEqual(keep(f), { kept: 1, empty: 0, unreadable: 0, failed: 0 });
    assert.equal(existsSync(renderPath(f.evals, 'x1')), false);
    assert.equal(existsSync(renderPath(f.evals, 'x2')), true);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders counts an id with a path separator as failed, writes nothing outside the renders directory, and still keeps the others', () => {
  const f = fixture([{ id: 'ok', text: 'invented task' }, { id: 'ok2', text: 'invented second task' }]);
  try {
    const file = f.sessions[0].file;
    const sessions = [{ sessionId: '../../escape', file, excluded: false }, f.sessions[0], { sessionId: 'a/b', file, excluded: false }, f.sessions[1]];
    assert.deepEqual(keep(f, { sessions }), { kept: 2, empty: 0, unreadable: 0, failed: 2 });
    assert.equal(existsSync(join(f.evals, 'review', 'escape.txt')), false);
    assert.equal(existsSync(join(f.base, 'escape.txt')), false);
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')).sort(), ['ok.txt', 'ok2.txt']);
    // an excluded session with an invalid id is skipped, not failed
    assert.deepEqual(keep(f, { sessions: [{ sessionId: '../x', file, excluded: true }] }), { kept: 0, empty: 0, unreadable: 0, failed: 0 });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders counts a session whose write fails as failed, leaves no temp file and goes on with the others', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }, { id: 's2', text: 'invented second task' }]);
  try {
    mkdirSync(join(f.evals, 'review', 'renders', 's1.txt'), { recursive: true }); // the rename onto a directory fails
    assert.deepEqual(keep(f), { kept: 1, empty: 0, unreadable: 0, failed: 1 });
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')).sort(), ['s1.txt', 's2.txt']);
    assert.equal(statSync(join(f.evals, 'review', 'renders', 's1.txt')).isDirectory(), true);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('transcriptQuiet: a readable file untouched for QUIET_MS is quiet; a younger one, an absent one and a directory are not', () => {
  assert.equal(QUIET_MS, 60 * 60 * 1000);
  const f = fixture([{ id: 'old', text: 'a', ageMs: QUIET_MS }, { id: 'young', text: 'b', ageMs: QUIET_MS - 1000 }, { id: 'gone', missing: true }]);
  try {
    assert.equal(transcriptQuiet(f.sessions[0].file, NOW), true);
    assert.equal(transcriptQuiet(f.sessions[1].file, NOW), false);
    assert.equal(transcriptQuiet(f.sessions[2].file, NOW), false);
    assert.equal(transcriptQuiet(f.root, NOW), false);
    assert.equal(transcriptQuiet(null, NOW), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders skips a transcript modified 10 minutes before now (all counts 0, nothing written) and keeps it once now is two hours later', () => {
  const f = fixture([{ id: 'live', text: 'invented task', ageMs: 10 * 60 * 1000 }]);
  try {
    assert.deepEqual(keep(f), { kept: 0, empty: 0, unreadable: 0, failed: 0 });
    assert.equal(existsSync(join(f.evals, 'review', 'renders')), false);
    assert.deepEqual(keep(f, { now: () => NOW + 2 * 60 * 60 * 1000 }), { kept: 1, empty: 0, unreadable: 0, failed: 0 });
    assert.ok(readFileSync(renderPath(f.evals, 'live'), 'utf8').includes('invented task'));
    // a text-less live session is not counted either; a missing one is still unreadable
    const g = fixture([{ id: 'e', text: null, ageMs: 60 * 1000 }, { id: 'm', missing: true }]);
    assert.deepEqual(keep(g), { kept: 0, empty: 0, unreadable: 1, failed: 0 });
    rmSync(g.base, { recursive: true, force: true });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders accepts a Date or a number for now', () => {
  const f = fixture([{ id: 'live', text: 'invented task', ageMs: 10 * 60 * 1000 }]);
  try {
    assert.equal(keep(f, { now: NOW }).kept, 0);
    assert.equal(keep(f, { now: new Date(NOW + 2 * 60 * 60 * 1000) }).kept, 1);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders deletes the kept render of a session that is now excluded and leaves the others alone', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }, { id: 's2', text: 'invented second task' }]);
  try {
    keep(f);
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')).sort(), ['s1.txt', 's2.txt']);
    const sessions = [{ ...f.sessions[0], excluded: true }, f.sessions[1]];
    assert.deepEqual(keep(f, { sessions }), { kept: 0, empty: 0, unreadable: 0, failed: 0 });
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')), ['s2.txt']);
    // an excluded session with no kept render is fine
    assert.equal(keep(f, { sessions }).failed, 0);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders sets an existing renders directory to 0700', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }]);
  try {
    const dir = join(f.evals, 'review', 'renders');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    assert.equal(mode(dir), 0o755);
    keep(f);
    assert.equal(mode(dir), 0o700);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a zero-length or blank kept file counts as absent: sessionRender returns the live render and keepRenders writes it again', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }, { id: 's2', text: 'invented second task' }]);
  try {
    mkdirSync(join(f.evals, 'review', 'renders'), { recursive: true });
    writeFileSync(renderPath(f.evals, 's1'), '');
    writeFileSync(renderPath(f.evals, 's2'), '  \n');
    assert.equal(sessionRender(f.evals, f.sessions[0]), renderForJudge(f.sessions[0].file));
    assert.equal(sessionRender(f.evals, f.sessions[1]), renderForJudge(f.sessions[1].file));
    assert.deepEqual(keep(f), { kept: 2, empty: 0, unreadable: 0, failed: 0 });
    assert.equal(readFileSync(renderPath(f.evals, 's1'), 'utf8'), renderForJudge(f.sessions[0].file));
    assert.equal(mode(renderPath(f.evals, 's1')), 0o600);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('sessionRender returns the kept text when the transcript is gone, and the kept text, not a fresh render, when both exist', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }]);
  try {
    const s = f.sessions[0];
    assert.equal(sessionRender(f.evals, s), renderForJudge(s.file), 'no kept render: the live one');
    keep(f);
    const kept = readFileSync(renderPath(f.evals, 's1'), 'utf8');
    writeFileSync(s.file, `${turn('user', 'a different text')}\n`);
    assert.equal(sessionRender(f.evals, s), kept, 'both exist: the kept one');
    rmSync(s.file);
    assert.equal(sessionRender(f.evals, s), kept, 'the transcript deleted: the kept one');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('sessionRender never writes, and is empty for an unreadable or absent transcript with no kept render', () => {
  const f = fixture([{ id: 'm1', missing: true }, { id: 's1', text: 'invented task' }]);
  try {
    assert.equal(sessionRender(f.evals, f.sessions[0]), '');
    assert.equal(sessionRender(f.evals, { sessionId: 'n1', file: null }), '');
    assert.ok(sessionRender(f.evals, f.sessions[1]).includes('invented task'));
    assert.equal(sessionRender(f.evals, { sessionId: '../bad', file: f.sessions[1].file }).includes('invented task'), true, 'a bad id falls back to the live render');
    assert.equal(existsSync(join(f.evals, 'review')), false, 'nothing was created');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('transcriptReadable tells a readable file from an absent one, a directory and a non-string', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }, { id: 'e1', text: null }]);
  try {
    assert.equal(transcriptReadable(f.sessions[0].file), true);
    assert.equal(transcriptReadable(f.sessions[1].file), true);
    assert.equal(transcriptReadable(join(f.root, 'absent.jsonl')), false);
    assert.equal(transcriptReadable(f.root), false);
    assert.equal(transcriptReadable(null), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
