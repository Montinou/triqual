import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalsNotice } from '../cli/lib/eval-notice.mjs';
import { sessionContext } from '../cli/drift.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const R1 = '2026-11-15T100000Z.json';
const R2 = '2026-11-16T100000Z.json';

function withEvals(fn) {
  const base = mkdtempSync(join(tmpdir(), 'cm-notice-'));
  try {
    const evals = join(base, 'evals');
    mkdirSync(join(evals, 'rounds'), { recursive: true });
    return fn(evals, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const report = (evals, name, body) => writeFileSync(join(evals, 'rounds', name), typeof body === 'string' ? body : JSON.stringify(body));
const revisions = (evals, lines) => writeFileSync(join(evals, 'revisions.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

test('a report with two judges to revise gives the line with the count and the ids', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x', 'y'] });
    assert.equal(evalsNotice({ evals }), 'evals: 2 judge(s) below the bar (x, y): run methodology:improving-evals');
  });
});

test('a revision line for x in that round leaves y pending', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x', 'y'] });
    revisions(evals, [{ round: R1, category: 'x', kept: true }]);
    assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (y): run methodology:improving-evals');
  });
});

test('a revision line for a different round does not count', () => {
  withEvals((evals) => {
    report(evals, R2, { revise: ['x'] });
    revisions(evals, [{ round: R1, category: 'x' }]);
    assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (x): run methodology:improving-evals');
  });
});

test('lines for both judges give null', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x', 'y'] });
    revisions(evals, [{ round: R1, category: 'x' }, { round: R1, category: 'y' }]);
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('an empty revise, a missing directory, a file that is not JSON and a revise that is a string give null', () => {
  withEvals((evals, base) => {
    report(evals, R1, { revise: [] });
    assert.equal(evalsNotice({ evals }), null);
    assert.equal(evalsNotice({ evals: join(base, 'missing') }), null);
    report(evals, R2, 'not json');
    assert.equal(evalsNotice({ evals }), null);
    report(evals, R2, { revise: 'x' });
    assert.equal(evalsNotice({ evals }), null);
    report(evals, R2, { revise: ['x', 3] });
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('a rounds directory with no file gives null', () => {
  withEvals((evals) => {
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('with two reports only the one whose name sorts last counts', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['old'] });
    report(evals, R2, { revise: ['new'] });
    assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (new): run methodology:improving-evals');
    report(evals, '2026-11-17T100000Z.json', { revise: [] });
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('failed steps with nothing to revise give the failed-steps line with the report path', () => {
  withEvals((evals) => {
    report(evals, R2, { failed: ['propose'], revise: [] });
    assert.equal(evalsNotice({ evals }), `evals: the last round had failed steps (propose): see ${join(evals, 'rounds', R2)}`);
  });
});

test('failed steps and a pending judge give both lines, the failed-steps line first', () => {
  withEvals((evals) => {
    report(evals, R2, { failed: ['review sample', 'judge x'], revise: ['x'] });
    assert.equal(
      evalsNotice({ evals }),
      `evals: the last round had failed steps (review sample, judge x): see ${join(evals, 'rounds', R2)}\nevals: 1 judge(s) below the bar (x): run methodology:improving-evals`,
    );
  });
});

test('failed steps with a revise that is not an array still announce the failure', () => {
  withEvals((evals) => {
    report(evals, R2, { failed: ['referee'], revise: 'x' });
    assert.match(evalsNotice({ evals }), /^evals: the last round had failed steps \(referee\)/);
  });
});

test('an empty failed, or one that is not an array of strings, adds nothing', () => {
  withEvals((evals) => {
    for (const failed of [[], 'propose', ['propose', 2], { a: 1 }, null]) {
      report(evals, R2, { failed, revise: ['x'] });
      assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (x): run methodology:improving-evals');
      report(evals, R2, { failed, revise: [] });
      assert.equal(evalsNotice({ evals }), null);
    }
  });
});

test('a revisions file that is not JSON on every line does not throw', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x'] });
    writeFileSync(join(evals, 'revisions.jsonl'), 'garbage\n{"round":"' + R1 + '","category":"x"}\n');
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('no argument at all gives null instead of throwing', () => {
  assert.equal(evalsNotice(), null);
  assert.equal(evalsNotice({}), null);
});

function sessionHome() {
  const home = mkdtempSync(join(tmpdir(), 'cm-notice-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'triqual.mjs'), '// The `triqual` shim.\n');
  return home;
}

test('sessionContext contains the notice line once when the fixture report has a judge to revise', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x'] });
    const home = sessionHome();
    try {
      const out = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'resume', harness: null, env: { TRIQUAL_EVALS_DIR: evals } });
      const line = 'evals: 1 judge(s) below the bar (x): run methodology:improving-evals';
      assert.ok(out.includes(line));
      assert.equal(out.split(line).length, 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('sessionContext adds the line for a harness too', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x'] });
    const home = sessionHome();
    try {
      const out = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'resume', harness: 'codex', env: { TRIQUAL_EVALS_DIR: evals } });
      assert.ok(out.includes('evals: 1 judge(s) below the bar (x)'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('sessionContext with nothing to revise has no evals line and equals the output for a missing directory', () => {
  withEvals((evals, base) => {
    report(evals, R1, { revise: [] });
    const home = sessionHome();
    try {
      const call = (dir) => sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: null, env: { TRIQUAL_EVALS_DIR: dir } });
      const withReport = call(evals);
      assert.ok(!/^evals:/m.test(withReport ?? ''));
      assert.equal(withReport, call(join(base, 'does-not-exist')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
