import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCollisions, diffOutside, nodesFromPlans } from '../lib/plan-collisions.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'plan.mjs');

// A plan: phases = [{ branch, parent?, files: [[path, …] per task] }]
function planText(stem, phases) {
  let task = 0;
  const out = [`# ${stem} Implementation Plan`, '', `**Branch prefix:** ${stem}`, ''];
  phases.forEach((p, i) => {
    out.push(`## Phase ${i + 1}: ${p.title ?? `phase ${i + 1}`}`, `**Branch:** ${stem}/0${i + 1}-x`, `**PR title:** feat: ${stem} ${i + 1}`);
    if (p.parent) out.push(`**Parent:** ${p.parent}`);
    out.push('');
    for (const files of p.files) {
      task += 1;
      out.push(`### Task ${task}: t${task}`, '', '**Files:**', ...files.map((f) => `- Modify: \`${f}\``), '');
    }
  });
  return `${out.join('\n')}\n`;
}

const FOREST = planText('forest', [
  { files: [['src/a.mjs']] },
  { parent: 'P1', files: [['src/shared.mjs', 'src/b.mjs']] },
  { parent: 'P1', files: [['src/shared.mjs'], ['src/c.mjs']] },
]);

test('nodesFromPlans: one node per phase with the union of task files, trunk and phase parents', () => {
  const nodes = nodesFromPlans([{ stem: 'forest', text: FOREST }]);
  assert.deepEqual(nodes.map((n) => n.id), ['forest#P1', 'forest#P2', 'forest#P3']);
  assert.deepEqual(nodes.map((n) => n.parentId), [null, 'forest#P1', 'forest#P1']);
  assert.equal(nodes[0].branch, 'forest/01-x');
  assert.deepEqual([...nodes[2].paths].sort(), ['src/c.mjs', 'src/shared.mjs']);
});

test('checkCollisions: siblings sharing a path collide once; ancestors are never compared', () => {
  const nodes = nodesFromPlans([{ stem: 'forest', text: FOREST }]);
  const r = checkCollisions(nodes);
  assert.equal(r.pairs, 1);
  assert.deepEqual(r.collisions, [{ a: 'forest#P2', b: 'forest#P3', shared: ['src/shared.mjs'] }]);
  const chain = nodesFromPlans([{ stem: 'chain', text: planText('chain', [{ files: [['x.mjs']] }, { files: [['x.mjs']] }, { files: [['x.mjs']] }]) }]);
  assert.deepEqual(checkCollisions(chain), { pairs: 0, collisions: [] });
});

test('two plans linked by a branch parent are comparable; unlinked plans are not', () => {
  const base = planText('base', [{ files: [['x.mjs']] }]);
  const linked = planText('next', [{ parent: 'base/01-x', files: [['x.mjs']] }]);
  const nodes = nodesFromPlans([{ stem: 'base', text: base }, { stem: 'next', text: linked }]);
  assert.equal(nodes[1].parentId, 'base#P1');
  assert.deepEqual(checkCollisions(nodes), { pairs: 0, collisions: [] });
  const apart = nodesFromPlans([{ stem: 'base', text: base }, { stem: 'next', text: planText('next', [{ files: [['x.mjs']] }]) }]);
  assert.equal(checkCollisions(apart).collisions.length, 1);
});

test('a glob in Files is an error naming the path', () => {
  const nodes = nodesFromPlans([{ stem: 'g', text: planText('g', [{ files: [['src/*.mjs']] }]) }]);
  assert.throws(() => checkCollisions(nodes), /^Error: globs are not supported in Files: src\/\*\.mjs$/);
  const braces = nodesFromPlans([{ stem: 'g', text: planText('g', [{ files: [['src/{a,b}.mjs']] }]) }]);
  assert.throws(() => checkCollisions(braces), /globs are not supported in Files: src\/\{a,b\}\.mjs/);
});

test('diffOutside returns the changed paths the node does not declare', () => {
  const [node] = nodesFromPlans([{ stem: 'g', text: planText('g', [{ files: [['a.mjs', 'b.mjs']] }]) }]);
  assert.deepEqual(diffOutside(node, ['a.mjs', 'z.mjs', 'b.mjs', 'y.mjs']), ['z.mjs', 'y.mjs']);
  assert.deepEqual(diffOutside(node, ['a.mjs']), []);
});

// -- the command --

function setup(t, plans) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-collisions-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = Object.entries(plans).map(([name, text]) => {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  });
  const run = (...args) => spawnSync(process.execPath, [CLI, 'check-collisions', ...files, ...args], { encoding: 'utf8', cwd: dir });
  return { dir, files, run };
}

test('a forest plan with sibling overlap: one collision, exit 1', (t) => {
  const s = setup(t, { 'forest.md': FOREST });
  const r = s.run();
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'nodes=3 incomparable pairs=1 collisions=1',
    'COLLISION forest#P2 forest#P3 src/shared.mjs',
  ]);
});

test('a clean plan exits 0 and a glob in Files exits 1', (t) => {
  const clean = setup(t, { 'clean.md': planText('clean', [{ files: [['a.mjs']] }, { parent: 'P1', files: [['b.mjs']] }]) });
  const r = clean.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'nodes=2 incomparable pairs=0 collisions=0\n');
  const glob = setup(t, { 'glob.md': planText('glob', [{ files: [['src/*.mjs']] }]) });
  const g = glob.run();
  assert.equal(g.status, 1);
  assert.match(g.stderr, /globs are not supported in Files: src\/\*\.mjs/);
});

test('two plan files linked by a branch parent are comparable on the command line', (t) => {
  const s = setup(t, {
    'a.md': planText('base', [{ files: [['x.mjs']] }]),
    'b.md': planText('next', [{ parent: 'base/01-x', files: [['x.mjs']] }]),
  });
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'nodes=2 incomparable pairs=0 collisions=0\n');
});

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('--diff: a change outside the node Files is an OUTSIDE line and exit 1; inside only is exit 0', (t) => {
  const s = setup(t, { 'solo.md': planText('solo', [{ files: [['src/a.mjs']] }]) });
  git(s.dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(s.dir, 'src'));
  writeFileSync(join(s.dir, 'README'), 'x\n');
  git(s.dir, 'add', 'README');
  git(s.dir, 'commit', '-q', '-m', 'base');
  git(s.dir, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(s.dir, 'src', 'a.mjs'), 'a\n');
  git(s.dir, 'add', 'src');
  git(s.dir, 'commit', '-q', '-m', 'inside');
  const ok = s.run('--diff', 'solo#P1', 'work');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout, 'nodes=1 incomparable pairs=0 collisions=0\n');
  writeFileSync(join(s.dir, 'stray.mjs'), 's\n');
  git(s.dir, 'add', 'stray.mjs');
  git(s.dir, 'commit', '-q', '-m', 'outside');
  const bad = s.run('--diff', 'solo#P1', 'work');
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.stdout.trimEnd().split('\n'), ['nodes=1 incomparable pairs=0 collisions=0', 'OUTSIDE solo#P1 stray.mjs']);
});

test('--diff: a parent branch that no given plan holds is the base, not main', (t) => {
  const s = setup(t, { 'next.md': planText('next', [{ parent: 'feat/base', files: [['src/a.mjs']] }]) });
  git(s.dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(s.dir, 'src'));
  writeFileSync(join(s.dir, 'README'), 'x\n');
  git(s.dir, 'add', 'README');
  git(s.dir, 'commit', '-q', '-m', 'base');
  git(s.dir, 'checkout', '-q', '-b', 'feat/base');
  writeFileSync(join(s.dir, 'parent.mjs'), 'p\n');
  git(s.dir, 'add', 'parent.mjs');
  git(s.dir, 'commit', '-q', '-m', 'parent work');
  git(s.dir, 'checkout', '-q', '-b', 'work');
  writeFileSync(join(s.dir, 'src', 'a.mjs'), 'a\n');
  git(s.dir, 'add', 'src');
  git(s.dir, 'commit', '-q', '-m', 'inside');
  const r = s.run('--diff', 'next#P1', 'work');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'nodes=1 incomparable pairs=0 collisions=0\n');
});

test('two plan files with the same stem exit 1 naming the stem', (t) => {
  const s = setup(t, { 'a.md': planText('dup', [{ files: [['a.mjs']] }]) });
  const other = setup(t, { 'a.md': planText('dup', [{ files: [['b.mjs']] }]) });
  const r = spawnSync(process.execPath, [CLI, 'check-collisions', ...s.files, ...other.files], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate plan stem "a"/);
});

test('bad arguments exit 2: no plan, unknown node, unreadable plan', (t) => {
  const s = setup(t, { 'solo.md': planText('solo', [{ files: [['a.mjs']] }]) });
  assert.equal(spawnSync(process.execPath, [CLI, 'check-collisions'], { encoding: 'utf8' }).status, 2);
  const unknown = s.run('--diff', 'nope#P9', 'HEAD');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown node "nope#P9"/);
  const missing = spawnSync(process.execPath, [CLI, 'check-collisions', join(s.dir, 'absent.md')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});

test('--diff: a rename whose old path is not in the node Files is an OUTSIDE line for the old path', (t) => {
  const s = setup(t, { 'solo.md': planText('solo', [{ files: [['src/new.mjs']] }]) });
  git(s.dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(s.dir, 'src'));
  writeFileSync(join(s.dir, 'src', 'old.mjs'), 'export const same = 1;\nexport const content = 2;\n');
  git(s.dir, 'add', 'src');
  git(s.dir, 'commit', '-q', '-m', 'base');
  git(s.dir, 'checkout', '-q', '-b', 'work');
  git(s.dir, 'mv', 'src/old.mjs', 'src/new.mjs');
  git(s.dir, 'commit', '-q', '-m', 'rename');
  const r = s.run('--diff', 'solo#P1', 'work');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), ['nodes=1 incomparable pairs=0 collisions=0', 'OUTSIDE solo#P1 src/old.mjs']);
});
