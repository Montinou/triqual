import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, TemplateError } from '../lib/plan-template.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'plan.mjs');

const failure = (template, data = {}) => {
  try {
    render(template, data, 'tpl.md');
  } catch (err) {
    assert.ok(err instanceof TemplateError, `not a TemplateError: ${err}`);
    return err.message;
  }
  assert.fail('render did not throw');
};

test('render substitutes {{key}} from the data, numbers and booleans included', () => {
  assert.equal(render('# {{title}} v{{n}} {{ok}}\n', { title: 'Plan', n: 2, ok: false }, 'tpl.md'), '# Plan v2 false\n');
});

test('render repeats an #each block with the 1-based {{@n}}, reading the item and then the plan', () => {
  const template = 'A {{name}}\n{{#each tasks}}\n### Task {{@n}}: {{title}} ({{name}})\n{{/each}}\nZ\n';
  const data = { name: 'plan', tasks: [{ title: 'one' }, { title: 'two', name: 'item' }] };
  assert.equal(
    render(template, data, 'tpl.md'),
    'A plan\n### Task 1: one (plan)\n### Task 2: two (item)\nZ\n',
  );
});

test('render keeps the text of an inline block and renders an empty array as nothing', () => {
  assert.equal(render('[{{#each xs}}{{@n}}:{{v}} {{/each}}]', { xs: [{ v: 'a' }, { v: 'b' }] }, 'tpl.md'), '[1:a 2:b ]');
  assert.equal(render('a\n{{#each xs}}\nx\n{{/each}}\nb\n', { xs: [] }, 'tpl.md'), 'a\nb\n');
});

test('render names the template, line and key of a missing key, in and out of a block', () => {
  assert.equal(failure('a\n\n{{gone}}\n'), 'tpl.md:3: missing key "gone"');
  assert.equal(failure('{{#each xs}}\n{{nope}}\n{{/each}}\n', { xs: [{ v: 1 }] }), 'tpl.md:2: missing key "nope"');
  assert.equal(failure('{{x}}', { x: null }), 'tpl.md:1: missing key "x"');
  assert.equal(failure('{{#each xs}}\n{{/each}}\n'), 'tpl.md:1: missing key "xs"');
});

test('render refuses a value that is not text, a number or a boolean', () => {
  assert.equal(failure('\n{{x}}', { x: { a: 1 } }), 'tpl.md:2: not a string, number or boolean "x"');
  assert.equal(failure('{{x}}', { x: [1] }), 'tpl.md:1: not a string, number or boolean "x"');
});

test('render refuses an #each over a non-array and over items that are not objects', () => {
  assert.equal(failure('{{#each xs}}\n{{/each}}', { xs: 'no' }), 'tpl.md:1: not an array "xs"');
  assert.equal(failure('x\n{{#each xs}}\n{{/each}}', { xs: ['a'] }), 'tpl.md:2: item 1 is not an object "xs"');
});

test('render refuses a nested, unclosed or stray block, naming the line of the offending tag', () => {
  const data = { xs: [{}], ys: [{}] };
  assert.equal(failure('{{#each xs}}\n{{#each ys}}\n{{/each}}\n{{/each}}\n', data), 'tpl.md:2: nested #each "ys"');
  assert.equal(failure('a\n{{#each xs}}\nbody\n', data), 'tpl.md:2: unclosed #each "xs"');
  assert.equal(failure('a\n{{/each}}\n', data), 'tpl.md:2: {{/each}} without #each "each"');
});

test('render refuses {{@n}} outside a block, dotted paths and tags it does not know', () => {
  assert.equal(failure('{{@n}}'), 'tpl.md:1: {{@n}} outside #each "@n"');
  assert.equal(failure('{{a.b}}', { a: { b: 1 } }), 'tpl.md:1: not a plain key "a.b"');
  assert.equal(failure('{{}}'), 'tpl.md:1: not a plain key ""');
  assert.equal(failure('{{#if x}}'), 'tpl.md:1: unknown tag "#if x"');
});

// -- the command --

const TEMPLATE = `# {{name}} Implementation Plan

**Branch prefix:** initiative

## Phase 1: Only
**Branch:** initiative/01-{{name}}
**PR title:** feat: {{name}}

{{#each tasks}}
### Task {{@n}}: {{title}}

**Tier:** standard
**Depends on:** {{dep}}

{{/each}}
`;

const plan = (name, dep, titles = ['first', 'second']) => ({
  file: `2026-11-03-${name}.md`,
  name,
  tasks: titles.map((title, i) => (i === titles.length - 1 && dep ? { title, dep } : { title })),
});

function setup(t, { template = TEMPLATE, data }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-generate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { template: join(dir, 'template.md'), data: join(dir, 'data.json'), out: join(dir, 'out') };
  writeFileSync(files.template, template);
  writeFileSync(files.data, typeof data === 'string' ? data : JSON.stringify(data));
  const run = (...extra) =>
    spawnSync(process.execPath, [CLI, 'generate', '--template', files.template, '--data', files.data, '--out', files.out, ...extra], { encoding: 'utf8' });
  return { dir, ...files, run };
}

test('three plans, one with Depends on: T9: two OK, one ERR, exit 1', (t) => {
  const s = setup(t, { data: { defaults: { dep: 'none' }, plans: [plan('alpha'), plan('beta', 'T9'), plan('gamma', null, ['solo'])] } });
  const r = s.run();
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'OK 2026-11-03-alpha.md tasks 2 phases 1',
    'ERR 2026-11-03-beta.md: T2 depends on T9, which is not a task of the plan',
    'OK 2026-11-03-gamma.md tasks 1 phases 1',
  ]);
  const alpha = readFileSync(join(s.out, '2026-11-03-alpha.md'), 'utf8');
  assert.match(alpha, /^# alpha Implementation Plan\n/);
  assert.match(alpha, /### Task 2: second\n\n\*\*Tier:\*\* standard\n\*\*Depends on:\*\* none\n/);
  assert.ok(existsSync(join(s.out, '2026-11-03-beta.md')), 'the invalid plan stays written for the person to read');
});

test('a plan that breaks the registration rules is an ERR with the rule', (t) => {
  const template = '# {{name}} Implementation Plan\n\n### Task 1: a\n\n**Tier:** {{tier}}\n';
  const s = setup(t, { template, data: { plans: [{ file: 'a.md', name: 'a', tier: 'huge' }] } });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'ERR a.md: T1: unknown tier "huge" (expected heavy, standard, light)\n');
});

test('an existing file is an ERR without --replace, and --replace overwrites it', (t) => {
  const s = setup(t, { data: { defaults: { dep: 'none' }, plans: [plan('alpha')] } });
  assert.equal(s.run().status, 0);
  const again = s.run();
  assert.equal(again.status, 1);
  assert.equal(again.stdout, 'ERR 2026-11-03-alpha.md: already exists (use --replace)\n');
  writeFileSync(join(s.out, '2026-11-03-alpha.md'), 'stale\n');
  const replaced = s.run('--replace');
  assert.equal(replaced.status, 0, replaced.stdout);
  assert.equal(replaced.stdout, 'OK 2026-11-03-alpha.md tasks 2 phases 1\n');
  assert.match(readFileSync(join(s.out, '2026-11-03-alpha.md'), 'utf8'), /^# alpha Implementation Plan/);
});

test('a template error is an ERR naming the template, line and key, and writes nothing for that plan', (t) => {
  const template = '# {{name}}\n\n{{missing}}\n';
  const s = setup(t, { template, data: { plans: [{ file: 'a.md', name: 'a' }] } });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `ERR a.md: ${s.template}:3: missing key "missing"\n`);
  assert.equal(existsSync(join(s.out, 'a.md')), false);
});

test('a file that is not a plain .md name is an ERR and never leaves the out directory', (t) => {
  const s = setup(t, { data: { defaults: { dep: 'none' }, plans: [{ ...plan('a'), file: '../escape.md' }, { ...plan('b'), file: 'b.txt' }, { ...plan('c'), file: undefined }] } });
  const r = s.run();
  assert.equal(r.status, 1);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /^ERR .*: "file" must be a plain file name ending in \.md$/);
  assert.equal(existsSync(join(s.dir, 'escape.md')), false);
});

test('bad arguments and unreadable inputs exit 2; --help prints the usage and exits 0', (t) => {
  const s = setup(t, { data: { plans: [] } });
  const noArgs = spawnSync(process.execPath, [CLI, 'generate'], { encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /usage: triqual plan generate/);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, 'frobnicate'], { encoding: 'utf8' }).status, 2);
  const noPlans = s.run();
  assert.equal(noPlans.status, 2);
  assert.match(noPlans.stderr, /"plans" must be a non-empty array/);
  writeFileSync(s.data, '{not json');
  const badJson = s.run();
  assert.equal(badJson.status, 2);
  assert.match(badJson.stderr, /data\.json/);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: triqual plan generate --template/);
});
