import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { EFFORTS, SUMMARY, main } from '../cli/eval-variant.mjs';
import { main as evalMain } from '../cli/eval.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evvariant-'));

const agent = (name, model, effort) => [
  '---',
  `name: ${name}`,
  `description: "Does the ${name} work. Use when asked."`,
  `model: ${model}`,
  `effort: ${effort}`,
  'disallowedTools: Agent',
  '---',
  '',
  `You are ${name}. Body line one.`,
  'model: not a front matter line',
  '',
].join('\n');

// A temp checkout holding plugins/roles with two agents, a plugin.json and a README.
function checkout() {
  const root = tmp();
  const roles = join(root, 'plugins', 'roles');
  mkdirSync(join(roles, 'agents'), { recursive: true });
  mkdirSync(join(roles, '.claude-plugin'), { recursive: true });
  writeFileSync(join(roles, 'agents', 'alpha.md'), agent('alpha', 'sonnet', 'high'));
  writeFileSync(join(roles, 'agents', 'beta.md'), agent('beta', 'opus', 'medium'));
  writeFileSync(join(roles, '.claude-plugin', 'plugin.json'), '{ "name": "roles", "version": "0.1.0" }\n');
  writeFileSync(join(roles, 'README.md'), '# roles\n');
  return { root, roles };
}

// { relative path: sha256 of the bytes } for every file under dir.
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const treeHash = (dir) => createHash('sha256').update(JSON.stringify(tree(dir))).digest('hex');

const differing = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

function run(cwd, argv) {
  let out = '';
  let err = '';
  return main(argv, { cwd, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } })
    .then((code) => ({ code, out, err }));
}

async function withCheckout(fn) {
  const c = checkout();
  try {
    return await fn(c);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
}

const lines = (s) => s.split('\n');

test('the module exports its summary and the effort list', () => {
  assert.equal(SUMMARY, 'copy the roles plugin with one agent changed (variant)');
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('--model and --effort change only those two lines of agents/<R>.md', () => withCheckout(async ({ root, roles }) => {
  const out = join(root, 'variant');
  const { code } = await run(root, ['--role', 'alpha', '--out', out, '--model', 'opus', '--effort', 'xhigh']);
  assert.equal(code, 0);
  assert.deepEqual(differing(tree(roles), tree(out)), [join('agents', 'alpha.md')]);
  const before = lines(readFileSync(join(roles, 'agents', 'alpha.md'), 'utf8'));
  const after = lines(readFileSync(join(out, 'agents', 'alpha.md'), 'utf8'));
  assert.equal(before.length, after.length);
  const changed = before.map((l, i) => [i, l, after[i]]).filter(([, a, b]) => a !== b);
  assert.deepEqual(changed.map(([, a, b]) => [a, b]), [['model: sonnet', 'model: opus'], ['effort: high', 'effort: xhigh']]);
}));

test('--model alone leaves the effort line alone and --effort alone leaves the model line alone', () => withCheckout(async ({ root, roles }) => {
  const a = join(root, 'a');
  const b = join(root, 'b');
  assert.equal((await run(root, ['--role', 'beta', '--out', a, '--model', 'haiku'])).code, 0);
  assert.equal((await run(root, ['--role', 'beta', '--out', b, '--effort=low'])).code, 0);
  assert.equal(readFileSync(join(a, 'agents', 'beta.md'), 'utf8'), readFileSync(join(roles, 'agents', 'beta.md'), 'utf8').replace('model: opus', 'model: haiku'));
  assert.equal(readFileSync(join(b, 'agents', 'beta.md'), 'utf8'), readFileSync(join(roles, 'agents', 'beta.md'), 'utf8').replace('effort: medium', 'effort: low'));
}));

test('--prompt replaces the body and keeps the front matter byte for byte', () => withCheckout(async ({ root, roles }) => {
  const prompt = join(root, 'prompt.md');
  writeFileSync(prompt, 'A new body.\nSecond line.');
  const out = join(root, 'variant');
  assert.equal((await run(root, ['--role', 'alpha', '--out', out, '--prompt', prompt])).code, 0);
  const src = readFileSync(join(roles, 'agents', 'alpha.md'), 'utf8');
  const got = readFileSync(join(out, 'agents', 'alpha.md'), 'utf8');
  const head = src.slice(0, src.indexOf('---\n', 4) + 4);
  assert.equal(got, `${head}A new body.\nSecond line.`);
  assert.deepEqual(differing(tree(roles), tree(out)), [join('agents', 'alpha.md')]);
}));

test('a prompt file that itself starts with a front matter block is the body verbatim', () => withCheckout(async ({ root, roles }) => {
  const body = '---\nkey: v\n---\nreal text\r\nmodel: keep\n';
  const prompt = join(root, 'prompt.md');
  writeFileSync(prompt, body);
  const out = join(root, 'variant');
  assert.equal((await run(root, ['--role', 'alpha', '--out', out, '--prompt', prompt, '--model', 'opus'])).code, 0);
  const src = readFileSync(join(roles, 'agents', 'alpha.md'), 'utf8');
  const head = src.slice(0, src.indexOf('---\n', 4) + 4).replace('model: sonnet', 'model: opus');
  assert.equal(readFileSync(join(out, 'agents', 'alpha.md'), 'utf8'), head + body);
}));

test('an empty --prompt file leaves a front matter only agent', () => withCheckout(async ({ root, roles }) => {
  const prompt = join(root, 'empty.md');
  writeFileSync(prompt, '');
  const out = join(root, 'variant');
  assert.equal((await run(root, ['--role', 'alpha', '--out', out, '--prompt', prompt])).code, 0);
  const src = readFileSync(join(roles, 'agents', 'alpha.md'), 'utf8');
  assert.equal(readFileSync(join(out, 'agents', 'alpha.md'), 'utf8'), src.slice(0, src.indexOf('---\n', 4) + 4));
}));

test('all three flags together', () => withCheckout(async ({ root, roles }) => {
  const prompt = join(root, 'prompt.md');
  writeFileSync(prompt, 'Only this.\n');
  const out = join(root, 'variant');
  assert.equal((await run(root, ['--role', 'beta', '--out', out, '--model', 'claude-haiku-5-5', '--effort', 'max', '--prompt', prompt])).code, 0);
  const got = lines(readFileSync(join(out, 'agents', 'beta.md'), 'utf8'));
  const src = lines(readFileSync(join(roles, 'agents', 'beta.md'), 'utf8'));
  assert.deepEqual(got.slice(0, 3), src.slice(0, 3));
  assert.equal(got[3], 'model: claude-haiku-5-5');
  assert.equal(got[4], 'effort: max');
  assert.deepEqual(got.slice(5), ['disallowedTools: Agent', '---', 'Only this.', '']);
  assert.deepEqual(differing(tree(roles), tree(out)), [join('agents', 'beta.md')]);
}));

test('CRLF line endings stay as they are', () => withCheckout(async ({ root, roles }) => {
  const file = join(roles, 'agents', 'alpha.md');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  const out = join(root, 'variant');
  assert.equal((await run(root, ['--role', 'alpha', '--out', out, '--model', 'opus', '--effort', 'low'])).code, 0);
  assert.equal(readFileSync(join(out, 'agents', 'alpha.md'), 'utf8'),
    readFileSync(file, 'utf8').replace('model: sonnet', 'model: opus').replace('effort: high', 'effort: low'));
}));

test('the source plugin is untouched', () => withCheckout(async ({ root, roles }) => {
  const prompt = join(root, 'prompt.md');
  writeFileSync(prompt, 'x\n');
  const before = treeHash(roles);
  assert.equal((await run(root, ['--role', 'alpha', '--out', join(root, 'variant'), '--model', 'opus', '--effort', 'low', '--prompt', prompt])).code, 0);
  assert.equal(treeHash(roles), before);
}));

test('it prints the absolute output directory and nothing else', () => withCheckout(async ({ root }) => {
  const r = await run(root, ['--role', 'alpha', '--out', 'rel/variant', '--model', 'opus']);
  assert.equal(r.code, 0);
  assert.equal(r.out, `${join(root, 'rel', 'variant')}\n`);
  assert.equal(r.err, '');
}));

test('it is reachable as triqual eval variant', () => withCheckout(async ({ root }) => {
  let out = '';
  const code = await evalMain(['variant', '--role', 'alpha', '--out', join(root, 'v'), '--effort', 'low'], {
    cwd: root, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  assert.equal(out, `${join(root, 'v')}\n`);
}));

test('every refusal exits 2, names itself on stderr and writes nothing', () => withCheckout(async ({ root, roles }) => {
  const prompt = join(root, 'prompt.md');
  writeFileSync(prompt, 'x\n');
  const out = join(root, 'variant');
  const existing = join(root, 'existing');
  mkdirSync(existing);
  const before = treeHash(roles);
  const cases = [
    ['an effort outside the list', ['--role', 'alpha', '--out', out, '--effort', 'ultra']],
    ['an empty effort', ['--role', 'alpha', '--out', out, '--effort', '']],
    ['a model with whitespace', ['--role', 'alpha', '--out', out, '--model', 'a b']],
    ['a model with a newline', ['--role', 'alpha', '--out', out, '--model', 'a\nb']],
    ['an empty model', ['--role', 'alpha', '--out', out, '--model', '']],
    ['a role that climbs out', ['--role', '../x', '--out', out, '--model', 'opus']],
    ['a role with capitals', ['--role', 'Alpha', '--out', out, '--model', 'opus']],
    ['a role with no agent file', ['--role', 'gamma', '--out', out, '--model', 'opus']],
    ['none of the three flags', ['--role', 'alpha', '--out', out]],
    ['an existing directory', ['--role', 'alpha', '--out', existing, '--model', 'opus']],
    ['an out inside plugins/roles', ['--role', 'alpha', '--out', join(roles, 'agents', 'sub'), '--model', 'opus']],
    ['an out that is plugins/roles', ['--role', 'alpha', '--out', roles, '--model', 'opus']],
    ['a relative out inside plugins/roles', ['--role', 'alpha', '--out', 'plugins/roles/x/../y', '--model', 'opus']],
    ['an unreadable prompt', ['--role', 'alpha', '--out', out, '--prompt', join(root, 'missing.md')]],
    ['a prompt that is a directory', ['--role', 'alpha', '--out', out, '--prompt', root]],
    ['a missing role', ['--out', out, '--model', 'opus']],
    ['a missing out', ['--role', 'alpha', '--model', 'opus']],
    ['a flag without a value', ['--role', 'alpha', '--out', out, '--model']],
    ['an unknown flag', ['--role', 'alpha', '--out', out, '--model', 'opus', '--bogus', '1']],
    ['a stray argument', ['--role', 'alpha', '--out', out, '--model', 'opus', 'extra']],
  ];
  for (const [label, argv] of cases) {
    const r = await run(root, argv);
    assert.equal(r.code, 2, label);
    assert.equal(r.out, '', label);
    assert.match(r.err, /^triqual eval variant: /, label);
    assert.equal(existsSync(out), false, label);
  }
  assert.equal(existsSync(join(roles, 'agents', 'sub')), false);
  assert.equal(existsSync(join(roles, 'x')), false);
  assert.equal(existsSync(join(roles, 'y')), false);
  assert.equal(treeHash(roles), before);
  assert.equal(statSync(existing).isDirectory(), true);
}));

test('no plugins/roles under cwd exits 2 and writes nothing', async () => {
  const root = tmp();
  try {
    const r = await run(root, ['--role', 'alpha', '--out', join(root, 'v'), '--model', 'opus']);
    assert.equal(r.code, 2);
    assert.match(r.err, /plugins\/roles/);
    assert.equal(existsSync(join(root, 'v')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an agent file without a front matter block or without the asked line exits 2 and writes nothing', () => withCheckout(async ({ root, roles }) => {
  writeFileSync(join(roles, 'agents', 'alpha.md'), 'no front matter here\n');
  writeFileSync(join(roles, 'agents', 'beta.md'), '---\nname: beta\n---\nbody\n');
  const out = join(root, 'variant');
  const a = await run(root, ['--role', 'alpha', '--out', out, '--model', 'opus']);
  const b = await run(root, ['--role', 'beta', '--out', out, '--effort', 'low']);
  assert.equal(a.code, 2);
  assert.equal(b.code, 2);
  assert.equal(existsSync(out), false);
}));
