import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderForJudge } from '../cli/lib/eval-judge.mjs';
import { keepRenders, renderPath, sessionRender, transcriptReadable } from '../cli/lib/eval-renders.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evrender-'));
const mode = (f) => statSync(f).mode & 0o777;
const turn = (role, text) => JSON.stringify({ type: role, timestamp: '2026-11-10T10:00:00Z', cwd: '/home/x/proj', message: { role, content: text } });

// A temp evals directory and a transcripts directory with the named sessions: `text` is the transcript's user text, null
// writes a transcript with no text at all, and `missing` writes no file.
function fixture(specs) {
  const base = tmp();
  const evals = join(base, 'evals');
  const root = join(base, 'projects');
  mkdirSync(root, { recursive: true });
  const sessions = specs.map(({ id, text, missing = false, excluded = false, raw }) => {
    const file = join(root, `${id}.jsonl`);
    if (!missing) {
      if (raw !== undefined) writeFileSync(file, raw);
      const lines = text === null ? [JSON.stringify({ type: 'summary', summary: 'no turns' })] : [turn('user', text), turn('assistant', 'invented reply')];
      if (raw === undefined) writeFileSync(file, `${lines.join('\n')}\n`);
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
    const first = keepRenders({ evals: f.evals, sessions: f.sessions });
    assert.deepEqual(first, { kept: 2, empty: 0, unreadable: 0 });
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
    assert.deepEqual(keepRenders({ evals: f.evals, sessions: f.sessions }), { kept: 0, empty: 0, unreadable: 0 });
    assert.equal(readFileSync(renderPath(f.evals, 's1'), 'utf8'), before, 'a kept render is not rendered again');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders: a readable transcript with no text counts empty and writes no file; a missing one counts unreadable', () => {
  const f = fixture([{ id: 'e1', text: null }, { id: 'e2', raw: '' }, { id: 'm1', missing: true }, { id: 'ok', text: 'invented task' }]);
  f.sessions.push({ sessionId: 'nofile', file: null, excluded: false });
  try {
    assert.deepEqual(keepRenders({ evals: f.evals, sessions: f.sessions }), { kept: 1, empty: 2, unreadable: 2 });
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')), ['ok.txt']);
    // the same again: empty and unreadable ones are counted every time, nothing is written
    assert.deepEqual(keepRenders({ evals: f.evals, sessions: f.sessions }), { kept: 0, empty: 2, unreadable: 2 });
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders writes no directory when there is nothing to keep', () => {
  const f = fixture([{ id: 'e1', text: null }]);
  try {
    assert.deepEqual(keepRenders({ evals: f.evals, sessions: f.sessions }), { kept: 0, empty: 1, unreadable: 0 });
    assert.equal(existsSync(join(f.evals, 'review', 'renders')), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders never renders or keeps an excluded session', () => {
  const f = fixture([{ id: 'x1', text: 'invented client text', excluded: true }, { id: 'x2', text: 'invented task' }]);
  try {
    assert.deepEqual(keepRenders({ evals: f.evals, sessions: f.sessions }), { kept: 1, empty: 0, unreadable: 0 });
    assert.equal(existsSync(renderPath(f.evals, 'x1')), false);
    assert.equal(existsSync(renderPath(f.evals, 'x2')), true);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders refuses an id with a path separator and writes nothing outside the renders directory', () => {
  const f = fixture([{ id: 'ok', text: 'invented task' }]);
  try {
    const sneaky = { sessionId: '../../escape', file: f.sessions[0].file, excluded: false };
    assert.throws(() => keepRenders({ evals: f.evals, sessions: [sneaky] }), /session id/);
    assert.throws(() => keepRenders({ evals: f.evals, sessions: [{ ...sneaky, sessionId: 'a/b' }] }), /session id/);
    assert.equal(existsSync(join(f.evals, 'review', 'escape.txt')), false);
    assert.equal(existsSync(join(f.base, 'escape.txt')), false);
    assert.equal(existsSync(join(f.evals, 'review', 'renders')), false);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('keepRenders leaves no temp file and rethrows when the write fails', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }]);
  try {
    mkdirSync(join(f.evals, 'review', 'renders', 's1.txt'), { recursive: true }); // the rename onto a directory fails
    assert.throws(() => keepRenders({ evals: f.evals, sessions: f.sessions }));
    assert.deepEqual(readdirSync(join(f.evals, 'review', 'renders')), ['s1.txt']);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('sessionRender returns the kept text when the transcript is gone, and the kept text, not a fresh render, when both exist', () => {
  const f = fixture([{ id: 's1', text: 'invented task' }]);
  try {
    const s = f.sessions[0];
    assert.equal(sessionRender(f.evals, s), renderForJudge(s.file), 'no kept render: the live one');
    keepRenders({ evals: f.evals, sessions: f.sessions });
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
