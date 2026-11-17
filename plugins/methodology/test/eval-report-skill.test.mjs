import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/eval-report.mjs';
import { buildRows, skillUnits } from '../cli/lib/eval-report.mjs';

const EXPERIMENT = {
  id: 's1',
  kind: 'skill',
  status: 'active',
  start: '2026-11-17',
  control: 'off',
  arms: {
    off: { pluginDir: '/work/example/plugin-off' },
    on: { pluginDir: '/work/example/plugin-on' },
  },
  margin: 0.1,
  objective: 'cost',
  evaluators: 'objective',
};

// The file `triqual eval skills` writes: { experiment, arm, at, auth, units: [{ caseId, pass, usd }] }.
function suiteRun(arm, passCount, total, usdOf, extraUnits = []) {
  const units = Array.from({ length: total }, (_, i) => ({ caseId: `case-${i}`, pass: i < passCount, usd: usdOf(i) })).concat(extraUnits);
  return { experiment: EXPERIMENT.id, arm, at: '2026-11-17T12:00:00Z', auth: 'work', units };
}

async function runReport(argv, env) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    platform: 'linux',
  });
  return { code, out, err };
}

test('a two-arm fixture experiment produces one row per arm from two suite runs', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cm-t38-'));
  try {
    const evals = join(base, 'evals');
    const runsDir = join(evals, 'skill-runs', EXPERIMENT.id);
    mkdirSync(runsDir, { recursive: true });

    const offRun = suiteRun('off', 180, 200, (i) => 0.20 + (i % 5) * 0.01);
    const onRun = suiteRun('on', 180, 200, (i) => 0.10 + (i % 5) * 0.01, [{ caseId: 'case-undecided', pass: null, usd: 0.10 }]);
    writeFileSync(join(runsDir, 'off.json'), JSON.stringify(offRun, null, 2));
    writeFileSync(join(runsDir, 'on.json'), JSON.stringify(onRun, null, 2));

    const experimentsFile = join(base, 'experiments.json');
    writeFileSync(experimentsFile, JSON.stringify({ experiments: [EXPERIMENT] }, null, 2));
    const env = {
      HOME: join(base, 'home'),
      TRIQUAL_EVALS_DIR: evals,
      TRIQUAL_EXPERIMENTS_FILE: experimentsFile,
      TRIQUAL_TRANSCRIPTS_DIR: join(base, 'transcripts'),
    };

    const units = skillUnits({ evalsDir: evals, experiment: EXPERIMENT });
    assert.equal(Array.isArray(units), true);
    const directRows = buildRows(units, EXPERIMENT);
    assert.equal(directRows.length, 2);

    const { code, out, err } = await runReport(['--json'], env);
    assert.equal(code, 0, err);
    const parsed = JSON.parse(out);
    assert.equal(parsed.experiments.length, 1);
    const exp = parsed.experiments[0];
    assert.equal(exp.id, 's1');
    assert.equal(exp.kind, 'skill');
    assert.equal(exp.rows.length, 2);
    assert.deepEqual(exp.rows, directRows);

    const [control, arm] = exp.rows;
    assert.equal(control.experiment, 's1');
    assert.equal(control.kind, 'skill');
    assert.equal(control.arm, 'off');
    assert.equal(control.control, true);
    assert.equal(control.n, 200);
    assert.equal(control.rate, 0.9);
    assert.ok(Math.abs(control.costMedian - 0.22) < 1e-9);
    assert.deepEqual(control.excluded, { contaminated: 0, undecided: 0 });
    assert.deepEqual(control.models, []);
    for (const k of ['d', 'dCI', 'c', 'cCI', 'required', 'verdict']) {
      assert.equal(control[k], null, `control.${k}`);
    }

    assert.equal(arm.experiment, 's1');
    assert.equal(arm.kind, 'skill');
    assert.equal(arm.arm, 'on');
    assert.equal(arm.control, false);
    assert.equal(arm.n, 200);
    assert.equal(arm.rate, 0.9);
    assert.ok(Math.abs(arm.costMedian - 0.12) < 1e-9);
    assert.deepEqual(arm.excluded, { contaminated: 0, undecided: 1 });
    assert.deepEqual(arm.models, []);
    assert.equal(arm.d, 0);
    assert.ok(arm.dCI[0] >= -0.1);
    assert.ok(Math.abs(arm.c - (-0.1)) < 1e-9);
    assert.ok(arm.cCI[1] < 0);
    assert.equal(arm.required, 112);
    assert.equal(arm.verdict, 'propose');

    // When the candidate arm is more expensive, the verdict is non-inferior, not cheaper.
    writeFileSync(
      join(runsDir, 'on.json'),
      JSON.stringify(suiteRun('on', 180, 200, (i) => 0.30 + (i % 5) * 0.01), null, 2),
    );
    const pricier = JSON.parse((await runReport(['--json'], env)).out).experiments[0].rows[1];
    assert.equal(pricier.verdict, 'non-inferior, not cheaper');

    // When the candidate arm's pass rate drops below the control, the verdict is worse.
    writeFileSync(
      join(runsDir, 'on.json'),
      JSON.stringify(suiteRun('on', 120, 200, (i) => 0.10 + (i % 5) * 0.01), null, 2),
    );
    const worse = JSON.parse((await runReport(['--json'], env)).out).experiments[0].rows[1];
    assert.equal(worse.verdict, 'worse');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an arm with no suite run file has no units, and a skill experiment with no runs has no rows', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cm-t38-'));
  try {
    const evals = join(base, 'evals');
    assert.deepEqual(skillUnits({ evalsDir: evals, experiment: EXPERIMENT }), []);
    const experimentsFile = join(base, 'experiments.json');
    writeFileSync(experimentsFile, JSON.stringify({ experiments: [EXPERIMENT] }, null, 2));
    const env = { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals, TRIQUAL_EXPERIMENTS_FILE: experimentsFile, TRIQUAL_TRANSCRIPTS_DIR: join(base, 'transcripts') };
    const { code, out, err } = await runReport(['--json'], env);
    assert.equal(code, 0, err);
    assert.deepEqual(JSON.parse(out).experiments[0].rows, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
