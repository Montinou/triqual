// Contract pins for the role-arm steps of `executing-plans`: the arm lookup runs only for a task's implementer, fixer and
// task reviewer, and the arm of a task role yields a scored unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../cli/eval-arm.mjs';
import { taskUnits } from '../cli/lib/eval-tasks.mjs';
import { readSkillText } from './skill-text.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = join(PLUGIN, 'skills', 'executing-plans');
const flat = (text) => text.replace(/\s*\n\s*/g, ' ');

// The Role arms paragraph with its bullets (to the next paragraph that is neither a bullet nor part of it).
function armsSection() {
  const text = readSkillText(EP);
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.startsWith('**Role arms.**'));
  assert.ok(from >= 0, 'no Role arms paragraph');
  let to = from + 1;
  while (to < lines.length && !lines[to].startsWith('**Turn count')) to += 1;
  return flat(lines.slice(from, to).join('\n'));
}

test('SKILL.md Role arms names the implementer, fixer and task reviewer dispatches', () => {
  const arms = armsSection();
  for (const word of ['tdd-implementer', 'complex-implementer', 'review-fixer', 'safety-reviewer', 'spec-reviewer', 'triqual eval arm --kind role --plan']) {
    assert.ok(arms.includes(word), `Role arms lacks: ${word}`);
  }
});

test('it names no arm for the brief writer, the orchestrator, the phase and seams reviews or hunters', () => {
  const arms = armsSection();
  const sentence = arms.split(/(?<=\.)\s+/).find((s) => s.includes('roles:brief-writer'));
  assert.ok(sentence, 'no sentence names roles:brief-writer');
  assert.match(sentence, /\bno arm\b/i, 'the brief-writer sentence is not a no-arm sentence');
  for (const word of ['phase orchestrator', 'roles:final-adversarial-reviewer', 'roles:hunter']) {
    assert.ok(sentence.includes(word), `the no-arm sentence lacks: ${word}`);
  }
  assert.ok(!arms.includes('--key'), 'Role arms still has a --key form');
});

test('the orchestrator prompt\'s Role Arms paragraph covers implementers, fixers and task reviewers', () => {
  const text = readFileSync(join(EP, 'orchestrator-prompt.md'), 'utf8');
  const heading = text.split('\n').findIndex((l) => l.trim() === '## Role Arms');
  assert.ok(heading >= 0, 'no Role Arms heading');
  const lines = text.split('\n').slice(heading + 1);
  const end = lines.findIndex((l) => l.trim().startsWith('## '));
  const section = flat(lines.slice(0, end).join('\n'));
  assert.ok(!section.includes('Every role agent you dispatch'), 'the paragraph still covers every role agent');
  assert.match(section, /implementer, fixer or task[- ]reviewer/, 'the paragraph does not name implementers, fixers and task reviewers');
  assert.ok(section.includes('`T<N> <role>`'), 'the description rule is gone');
});

test('an experiment on review-fixer yields an arm line and a scored unit', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cm-arms-'));
  try {
    const evals = join(base, 'evals');
    const experimentsFile = join(base, 'config', 'experiments.json');
    mkdirSync(join(base, 'config'), { recursive: true });
    const experiment = {
      id: 'exp-fixer',
      kind: 'role',
      status: 'active',
      start: '2026-11-17',
      control: 'a',
      arms: {
        a: { role: 'review-fixer', model: 'claude-opus-4-6', effort: 'high' },
        b: { role: 'review-fixer', model: 'claude-sonnet-4-6', effort: 'medium' },
      },
      margin: 0.1,
      objective: 'cost',
      evaluators: 'objective',
    };
    writeFileSync(experimentsFile, `${JSON.stringify({ experiments: [experiment] })}\n`);
    const env = { HOME: join(base, 'home'), TRIQUAL_EVALS_DIR: evals, TRIQUAL_EXPERIMENTS_FILE: experimentsFile };
    let out = '';
    let err = '';
    const code = await main(['--kind', 'role', '--role', 'review-fixer', '--plan', 'p.md', '--task', 'T4'], {
      env,
      cwd: join(base, 'main'),
      now: () => new Date('2026-11-17T12:00:00.000Z'),
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
    });
    assert.equal(code, 0, err);
    const m = /^exp-fixer\/(a|b) (\S+) (\S+)\n$/.exec(out);
    assert.ok(m, `unexpected arm line ${JSON.stringify(out)}`);
    const arm = m[1];
    assert.equal(m[2], experiment.arms[arm].model);
    assert.equal(m[3], experiment.arms[arm].effort);

    const assignments = readFileSync(join(evals, 'role-assignments.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].plan, 'p.md');
    assert.equal(assignments[0].task, 'T4');
    assert.equal(assignments[0].arm, arm);

    const records = [{
      v: 2, at: '2026-11-17T13:00:00Z', provider: 'claude', plan: 'p.md', task: 'T4', kind: 'task-review', attempt: 1,
      tier: 'standard', declaredTier: 'standard', raised: false, hunters: [], gate: { findings: 0 },
      spec: { ran: true, confirmed: { critical: 0, important: 0, minor: 0 } }, fixRounds: 0, blocked: false, coordinator: false,
    }];
    const root = join(base, 'transcripts');
    mkdirSync(root);
    const units = taskUnits({ experiment, assignments, records, root });
    assert.equal(units.length, 1);
    assert.equal(units[0].arm, arm);
    assert.equal(units[0].verdict, 'healthy');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
