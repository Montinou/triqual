import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCases, casesOf, problems, ROLE_NAMES, CASES_DIR } from './lib/case-files.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'case-files-'));

const put = (root, rel, text) => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

const promptCase = (root, name, { role = 'planner', extra = '' } = {}) => {
  put(root, `${name}/prompt.md`, `---\nmax_turns: 6\nallowed_tools: [Agent, Read]\n${extra}---\nDispatch the agent \`roles:${role}\` with the exercise.\n`);
  put(root, `${name}/graders/one.md`, '---\ntype: llm\nweight: 3\n---\nIt names the lanes.\n');
  put(root, `${name}/graders/two.md`, '---\ntype: llm\nweight: 1\n---\nIt is short.\n');
};

const yamlCase = (root, name, { role = 'tdd-implementer', maxTurns = 12, indent = '  ', scaffold = 'scaffold.sh', tools = 'Agent, Bash, Read, Write, Edit' } = {}) => {
  const ctx = scaffold ? `context:\n${indent}scaffold_script: ${scaffold}\n` : '';
  put(root, `${name}/case.yaml`, [
    'schema_version: "1.0"',
    `name: ${name}`,
    ctx.trimEnd(),
    'execution:',
    `${indent}max_turns: ${maxTurns}`,
    `${indent}allowed_tools: [${tools}]`,
    `${indent}timeout_seconds: 600`,
    `${indent}prompt: |`,
    `${indent}${indent}Dispatch the agent \`roles:${role}\` with the Agent tool.`,
    'runs: 3',
    'graders:',
    '  - type: llm',
    '    name: first',
    '    weight: 3',
    '    criteria: >-',
    '      The report shows a failing run first.',
    '  - type: llm',
    '    name: second',
    '    weight: 1',
    '    criteria: >-',
    '      The work is committed.',
    '',
  ].filter((l) => l !== '').join('\n') + '\n');
  if (scaffold) put(root, `${name}/${scaffold}`, '#!/bin/sh\nset -e\ngit init -q .\n');
};

const only = (root, name) => readCases(root).find((c) => c.name === name);

test('readCases reads a prompt case', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    const [c] = readCases(root);
    assert.equal(c.name, 'planner-lanes');
    assert.equal(c.dir, join(root, 'planner-lanes'));
    assert.equal(c.format, 'prompt');
    assert.equal(c.maxTurns, 6);
    assert.deepEqual(c.allowedTools, ['Agent', 'Read']);
    assert.equal(c.scaffold, null);
    assert.match(c.text, /^Dispatch the agent `roles:planner`/);
    assert.deepEqual(c.graders.map((g) => [g.name, g.weight]), [['one', 3], ['two', 1]]);
    assert.equal(c.graders[0].text, 'It names the lanes.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readCases reports the scaffold_script line of a prompt case', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes', { extra: 'scaffold_script: scaffold.sh\n' });
    assert.equal(readCases(root)[0].scaffold, 'scaffold.sh');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readCases reads a nested yaml case', () => {
  const root = tmp();
  try {
    yamlCase(root, 'tdd-implementer-red-then-green');
    const [c] = readCases(root);
    assert.equal(c.format, 'yaml');
    assert.equal(c.name, 'tdd-implementer-red-then-green');
    assert.equal(c.maxTurns, 12);
    assert.deepEqual(c.allowedTools, ['Agent', 'Bash', 'Read', 'Write', 'Edit']);
    assert.equal(c.scaffold, 'scaffold.sh');
    assert.match(c.text, /^schema_version:/);
    assert.deepEqual(c.graders.map((g) => [g.name, g.weight]), [['first', 3], ['second', 1]]);
    assert.match(c.graders[0].text, /failing run first/);
    assert.doesNotMatch(c.graders[0].text, /work is committed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readCases reads a case with the keys at top level too', () => {
  const root = tmp();
  try {
    put(root, 'planner-flat/case.yaml', [
      'schema_version: "1.0"',
      'name: planner-flat',
      'scaffold_script: scaffold.sh',
      'max_turns: 9',
      'allowed_tools: [Agent]',
      'prompt: Dispatch `roles:planner`.',
      'graders:',
      '- type: llm',
      '  weight: 2',
      '  criteria: a',
      '- type: llm',
      '  weight: 1',
      '  criteria: b',
      '',
    ].join('\n'));
    const [c] = readCases(root);
    assert.equal(c.maxTurns, 9);
    assert.deepEqual(c.allowedTools, ['Agent']);
    assert.equal(c.scaffold, 'scaffold.sh');
    assert.deepEqual(c.graders.map((g) => g.weight), [2, 1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readCases of a missing directory is []', () => {
  assert.deepEqual(readCases(join(tmpdir(), 'case-files-does-not-exist')), []);
});

test('readCases sorts by name and casesOf returns only the cases of the role', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-b');
    promptCase(root, 'planner-a');
    promptCase(root, 'hunter-x', { role: 'hunter' });
    assert.deepEqual(readCases(root).map((c) => c.name), ['hunter-x', 'planner-a', 'planner-b']);
    assert.deepEqual(casesOf('planner', root).map((c) => c.name), ['planner-a', 'planner-b']);
    assert.deepEqual(casesOf('spec-reviewer', root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ROLE_NAMES lists the ten agent files', () => {
  assert.deepEqual(ROLE_NAMES, [
    'brief-writer', 'complex-implementer', 'final-adversarial-reviewer', 'hunter', 'phase-orchestrator',
    'planner', 'review-fixer', 'safety-reviewer', 'spec-reviewer', 'tdd-implementer',
  ]);
  assert.match(CASES_DIR, /plugins\/roles\/evals\/cases$/);
});

test('problems is empty for a valid prompt case and a valid nested yaml case, and for a copy of the execution-port plan case shape', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    yamlCase(root, 'tdd-implementer-red-then-green');
    yamlCase(root, 'tdd-implementer-escalates-oversize', { maxTurns: 12 });
    yamlCase(root, 'planner-no-scaffold', { role: 'planner', scaffold: null, tools: 'Agent, Read' });
    for (const c of readCases(root)) assert.deepEqual(problems(c), [], c.name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const one = (c, pattern) => {
  const got = problems(c);
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.ok(got[0].includes(c.name), `names the case: ${got[0]}`);
  assert.match(got[0], pattern);
};

test('rule 1: the name is lowercase words, equals its directory and starts with a role', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    const c = only(root, 'planner-lanes');
    one({ ...c, name: 'Planner_Lanes' }, /name/);
    one({ ...c, name: 'planner-other' }, /name/);
    one({ ...c, name: 'unknown-role-case', dir: join(root, 'unknown-role-case') }, /name/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 2: the text names the role as roles:<role>', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes', { role: 'hunter' });
    one(only(root, 'planner-lanes'), /roles:planner/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 3: max turns is an integer from 1 to 200 and the tools are not empty', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    const c = only(root, 'planner-lanes');
    one({ ...c, maxTurns: 0 }, /max_turns/);
    one({ ...c, maxTurns: 201 }, /max_turns/);
    one({ ...c, maxTurns: 2.5 }, /max_turns/);
    one({ ...c, maxTurns: null }, /max_turns/);
    one({ ...c, allowedTools: [] }, /allowed_tools/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 4: at least two graders, each with a weight above 0 and a text', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    const c = only(root, 'planner-lanes');
    one({ ...c, graders: c.graders.slice(0, 1) }, /grader/);
    one({ ...c, graders: [c.graders[0], { ...c.graders[1], weight: 0 }] }, /grader/);
    one({ ...c, graders: [c.graders[0], { ...c.graders[1], weight: null }] }, /grader/);
    one({ ...c, graders: [c.graders[0], { ...c.graders[1], text: '' }] }, /grader/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 5: a prompt case has no scaffold_script', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes', { extra: 'scaffold_script: scaffold.sh\n' });
    one(only(root, 'planner-lanes'), /scaffold_script/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 6: a yaml case has schema_version, a name line equal to its directory, and a scaffold that exists and starts with #!', () => {
  const root = tmp();
  try {
    yamlCase(root, 'tdd-implementer-red-then-green');
    const c = only(root, 'tdd-implementer-red-then-green');
    one({ ...c, text: c.text.replace(/^schema_version:.*\n/m, '') }, /schema_version/);
    one({ ...c, text: c.text.replace(/^name: .*$/m, 'name: tdd-implementer-other') }, /name line/);
    one({ ...c, text: c.text.replace(/^name: .*\n/m, '') }, /name line/);
    one({ ...c, scaffold: 'missing.sh' }, /missing\.sh/);
    put(root, 'tdd-implementer-red-then-green/plain.sh', 'git init -q .\n');
    one({ ...c, scaffold: 'plain.sh' }, /#!/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 7: Bash, Write or Edit only in a yaml case that has a scaffold', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    const p = only(root, 'planner-lanes');
    for (const tool of ['Bash', 'Write', 'Edit']) one({ ...p, allowedTools: ['Agent', tool] }, /Bash, Write or Edit/);
    yamlCase(root, 'planner-no-scaffold', { role: 'planner', scaffold: null, tools: 'Agent, Bash' });
    one(only(root, 'planner-no-scaffold'), /Bash, Write or Edit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rule 8: no TODO in the text or the graders', () => {
  const root = tmp();
  try {
    promptCase(root, 'planner-lanes');
    const c = only(root, 'planner-lanes');
    one({ ...c, text: `${c.text}\nTODO: finish` }, /TODO/);
    one({ ...c, graders: [c.graders[0], { ...c.graders[1], text: 'TODO write this' }] }, /TODO/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
