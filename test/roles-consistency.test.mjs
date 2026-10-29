import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The role names live in plugins/roles/agents/*.md (the file stems, and the `model:` frontmatter). Every other place
// that lists the roles is a copy of them; this file is the one test that compares each copy with the agent files.
// The readers take their paths as a parameter so a test can point one at a temp copy with a renamed role.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => join(ROOT, ...parts);

const DEFAULT_PATHS = Object.freeze({
  agentsDir: at('plugins', 'roles', 'agents'),
  gate: at('plugins', 'workflow-gate', 'scripts', 'gate.mjs'),
  codexRouting: at('plugins', 'methodology', 'cli', 'lib', 'agents.mjs'),
  doctor: at('plugins', 'methodology', 'cli', 'doctor.mjs'),
  taskRoles: at('plugins', 'progress-tracking', 'lib', 'roles.mjs'),
  globalRules: at('plugins', 'methodology', 'rules', 'global.md'),
  rootReadme: at('README.md'),
  rolesReadme: at('plugins', 'roles', 'README.md'),
  rolesPlugin: at('plugins', 'roles', '.claude-plugin', 'plugin.json'),
});

const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];

const text = (path) => readFileSync(path, 'utf8');
const uniqueSorted = (list) => [...new Set(list)].sort();

// The source of truth: { name -> model family } read from the agent files.
function agentFiles(paths = DEFAULT_PATHS) {
  const agents = {};
  for (const file of readdirSync(paths.agentsDir).filter((f) => f.endsWith('.md')).sort()) {
    const model = text(join(paths.agentsDir, file)).match(/^model:\s*(\S+)/m)?.[1];
    assert.ok(model, `${file} has no model: line`);
    const family = MODEL_FAMILIES.find((f) => model.includes(f));
    assert.ok(family, `${file}: model ${model} is in no known family`);
    agents[file.slice(0, -3)] = family;
  }
  return agents;
}

// The text of a source block: from `open` to the next `close`.
function blockOf(src, open, close, copy) {
  const start = src.indexOf(open);
  assert.ok(start >= 0, `${copy}: could not find \`${open}\``);
  const from = start + open.length;
  const end = src.indexOf(close, from);
  assert.ok(end >= 0, `${copy}: could not find the end of \`${open}\``);
  return src.slice(from, end);
}

// Each reader returns { names } and, when the copy carries models, { models: { name -> family } }.
const READERS = {
  'workflow-gate ROLE_MODELS': (paths) => {
    const body = blockOf(text(paths.gate), 'const ROLE_MODELS = {', '\n};', 'workflow-gate ROLE_MODELS');
    const models = {};
    for (const m of body.matchAll(/^\s*"?([a-z0-9-]+)"?:\s*"([a-z]+)"/gm)) models[m[1]] = m[2];
    return { names: Object.keys(models), models };
  },
  'methodology CODEX_ROLE_ROUTING': (paths) => {
    const body = blockOf(text(paths.codexRouting), 'const CODEX_ROLE_ROUTING = Object.freeze({', '\n});', 'methodology CODEX_ROLE_ROUTING');
    return { names: [...body.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*\{/gm)].map((m) => m[1]) };
  },
  'methodology doctor ROLES': (paths) => {
    const body = blockOf(text(paths.doctor), 'const ROLES = [', '];', 'methodology doctor ROLES');
    return { names: [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]) };
  },
  'progress-tracking TASK_ROLES': (paths) => {
    const body = blockOf(text(paths.taskRoles), 'export const TASK_ROLES = Object.freeze([', '\n]);', 'progress-tracking TASK_ROLES');
    return { names: [...body.matchAll(/['"]roles:([a-z0-9-]+)['"]/g)].map((m) => m[1]), subset: true };
  },
  'rules/global.md role table': (paths) => ({
    names: text(paths.globalRules).split('\n')
      .map((line) => line.match(/^\| [^|]+ \| `roles:([a-z0-9-]+)` \|/)?.[1]).filter(Boolean),
  }),
  'README.md roles row': (paths) => {
    const row = text(paths.rootReadme).split('\n').find((line) => line.startsWith('| `roles` |'));
    assert.ok(row, 'README.md roles row: no line starts with "| `roles` |"');
    const description = row.split('|').slice(3).join('|');
    return { names: [...description.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g)].map((m) => m[1]) };
  },
  'README.md Codex table': (paths) => ({
    names: text(paths.rootReadme).split('\n').map((line) => line.trim())
      .filter((line) => /^\| `[a-z0-9-]+`.*\| `gpt-/.test(line))
      .flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])),
  }),
  'plugins/roles/README.md agents table': (paths) => ({
    names: text(paths.rolesReadme).split('\n')
      .map((line) => line.match(/^\| `roles:([a-z0-9-]+)` \|/)?.[1]).filter(Boolean),
  }),
  'plugins/roles/README.md dispatch table': (paths) => ({
    names: text(paths.rolesReadme).split('\n')
      .map((line) => line.match(/^\| `([a-z0-9-]+)` \|/)?.[1]).filter(Boolean),
  }),
  'plugins/roles plugin.json description': (paths) => {
    const description = JSON.parse(text(paths.rolesPlugin)).description;
    const list = description.split(':')[1];
    assert.ok(list, 'plugins/roles plugin.json description lists no names after a colon');
    return { names: list.split(',').map((n) => n.trim().replace(/\.$/, '')).filter(Boolean) };
  },
};

// The failure message for a copy, or null when it agrees with the agent files.
function compare(copy, paths = DEFAULT_PATHS) {
  const agents = agentFiles(paths);
  const expected = Object.keys(agents);
  const read = READERS[copy](paths);
  const names = uniqueSorted(read.names);
  // A reader that parses nothing would make a subset check pass without checking anything.
  assert.ok(names.length > 0, `${copy}: no role names were read`);
  const missing = read.subset ? [] : expected.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !expected.includes(n));
  const problems = [];
  if (missing.length || extra.length) {
    problems.push(`role names differ in ${copy}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
  if (read.models) {
    const wrong = expected.filter((n) => read.models[n] && read.models[n] !== agents[n])
      .map((n) => `${n} is ${read.models[n]} but the agent file says ${agents[n]}`);
    if (wrong.length) problems.push(`role models differ in ${copy}: ${wrong.join('; ')}`);
  }
  return problems.length ? problems.join('\n') : null;
}

function countWordProblem(paths = DEFAULT_PATHS) {
  const count = Object.keys(agentFiles(paths)).length;
  const description = JSON.parse(text(paths.rolesPlugin)).description;
  const word = COUNT_WORDS[count];
  return description.startsWith(`${word} `) ? null
    : `plugins/roles plugin.json description should start with "${word}" for ${count} agent files: ${description}`;
}

for (const copy of Object.keys(READERS)) {
  test(`role names agree with plugins/roles/agents in ${copy}`, () => {
    const problem = compare(copy);
    assert.equal(problem, null, problem ?? undefined);
  });
}

// Plan roles-calibration-and-lean-review T18 (owner ruling "calibration spec-reviewer", 2026-10-29): sonnet -> opus.
test('spec-reviewer is an Opus role in its agent file and in ROLE_MODELS', () => {
  assert.equal(agentFiles()['spec-reviewer'], 'opus');
  assert.equal(READERS['workflow-gate ROLE_MODELS'](DEFAULT_PATHS).models['spec-reviewer'], 'opus');
});

test('the roles plugin.json description carries the count word for the agent files', () => {
  const problem = countWordProblem();
  assert.equal(problem, null, problem ?? undefined);
});

// Prove it bites: point a reader at a temp copy of the real file with one change.
function withTempCopy(key, file, change, run) {
  const dir = mkdtempSync(join(tmpdir(), 'roles-consistency-'));
  try {
    const original = text(DEFAULT_PATHS[key]);
    const changed = change(original);
    assert.notEqual(changed, original, 'the change did not touch the copy');
    const copy = join(dir, file);
    writeFileSync(copy, changed);
    return run({ ...DEFAULT_PATHS, [key]: copy });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a renamed role in a copy of gate.mjs is reported by name', () => {
  const problem = withTempCopy('gate', 'gate.mjs', (s) => s.replace('"hunter": "haiku"', '"hunter-2": "haiku"'),
    (paths) => compare('workflow-gate ROLE_MODELS', paths));
  assert.equal(problem, 'role names differ in workflow-gate ROLE_MODELS: missing [hunter], extra [hunter-2]');
});

test('a wrong model in a copy of gate.mjs is reported', () => {
  const problem = withTempCopy('gate', 'gate.mjs', (s) => s.replace('"hunter": "haiku"', '"hunter": "opus"'),
    (paths) => compare('workflow-gate ROLE_MODELS', paths));
  assert.equal(problem, 'role models differ in workflow-gate ROLE_MODELS: hunter is opus but the agent file says haiku');
});

test('a renamed role in a copy of the role table is reported by name', () => {
  const problem = withTempCopy('globalRules', 'global.md', (s) => s.replace('`roles:spec-reviewer`', '`roles:spec-checker`'),
    (paths) => compare('rules/global.md role table', paths));
  assert.equal(problem, 'role names differ in rules/global.md role table: missing [spec-reviewer], extra [spec-checker]');
});

test('a role outside the agents in a copy of TASK_ROLES is reported as extra', () => {
  const problem = withTempCopy('taskRoles', 'roles.mjs', (s) => s.replace("'roles:review-fixer'", "'roles:review-fixr'"),
    (paths) => compare('progress-tracking TASK_ROLES', paths));
  assert.equal(problem, 'role names differ in progress-tracking TASK_ROLES: missing [], extra [review-fixr]');
});

test('double-quoted entries in a copy of TASK_ROLES are still read', () => {
  const problem = withTempCopy('taskRoles', 'roles.mjs',
    (s) => s.replace(/'(roles:[a-z0-9-]+|coordinator)'/g, '"$1"').replace('"roles:review-fixer"', '"roles:review-fixr"'),
    (paths) => compare('progress-tracking TASK_ROLES', paths));
  assert.equal(problem, 'role names differ in progress-tracking TASK_ROLES: missing [], extra [review-fixr]');
});

test('a copy that yields no role names fails instead of passing unchecked', () => {
  assert.throws(
    () => withTempCopy('taskRoles', 'roles.mjs', (s) => s.replace(/'roles:([a-z0-9-]+)'/g, "'agent:$1'"),
      (paths) => compare('progress-tracking TASK_ROLES', paths)),
    /progress-tracking TASK_ROLES: no role names were read/);
});

test('a wrong count word in a copy of plugin.json is reported', () => {
  const problem = withTempCopy('rolesPlugin', 'plugin.json', (s) => s.replace('Nine role agents', 'Six role agents'),
    (paths) => countWordProblem(paths));
  assert.match(problem, /should start with "Nine" for 9 agent files/);
});
