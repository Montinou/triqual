// A plan laid out by the Parallel layout rules of writing-plans (lane B) passes `triqual plan lanes` (lane A): the milestone test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = dirname(fileURLToPath(import.meta.url));
const CLI = join(TEST, '..', '..', 'progress-tracking', 'cli', 'plan.mjs');

// P1 Parent trunk: T1 lane A src/a.mjs, T2 lane B src/b.mjs, T3 lane C src/c.mjs on T1, T2;
// P2 Parent trunk: T4 src/d.mjs; P3 Parent P1, P2: T5 src/e.mjs on T3, T4.
// `p2Parent` is the Parent line of P2.
function planText(p2Parent) {
  const task = (n, { lane, deps, file }) => [
    `### Task ${n}: t${n}`,
    '',
    ...(lane ? [`**Lane:** ${lane}`] : []),
    ...(deps ? [`**Depends on:** ${deps}`] : []),
    '**Role:** roles:tdd-implementer',
    '**Files:**',
    `- Modify: \`${file}\``,
    `- Test: \`test/${file.split('/')[1]}\``,
    '',
  ];
  return [
    '# Layout Implementation Plan',
    '',
    '**Branch prefix:** layout',
    '',
    '## Phase 1: slice one',
    '**Branch:** layout/01-one',
    '**PR title:** feat: layout one',
    '**Parent:** trunk',
    '',
    ...task(1, { lane: 'A', file: 'src/a.mjs' }),
    ...task(2, { lane: 'B', file: 'src/b.mjs' }),
    ...task(3, { lane: 'C', deps: 'T1, T2', file: 'src/c.mjs' }),
    '## Phase 2: slice two',
    '**Branch:** layout/02-two',
    '**PR title:** feat: layout two',
    `**Parent:** ${p2Parent}`,
    '',
    ...task(4, { file: 'src/d.mjs' }),
    '## Phase 3: join',
    '**Branch:** layout/03-join',
    '**PR title:** feat: layout join',
    '**Parent:** P1, P2',
    '',
    ...task(5, { deps: 'T3, T4', file: 'src/e.mjs' }),
  ].join('\n') + '\n';
}

function lanes(p2Parent) {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-layout-'));
  try {
    const file = join(dir, 'layout-plan.md');
    writeFileSync(file, planText(p2Parent));
    return spawnSync(process.execPath, [CLI, 'lanes', file, '--json'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a plan of two independent slices laid out by Parallel layout passes triqual plan lanes', () => {
  const res = lanes('trunk');
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.phaseRows.map((r) => [r.parents, r.frontier]), [[[], []], [[], []], [[1, 2], [1, 2]]]);
  assert.deepEqual([out.violations, out.criticalPath, out.tasks], [[], 3, 5]);
});
