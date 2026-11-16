// Text pins for the improving-evals skill: the lines that keep a judge rewrite measured, test-split-blind and
// owner-free, the order of its steps, and the one-line `node` command it gives for reading the train-split notes, run
// here against an invented evals directory (no real data, no model call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(PLUGIN, '..', '..');
const { splitOf } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lib', 'eval-validate.mjs')).href);
const SKILL_FILE = join(PLUGIN, 'skills', 'improving-evals', 'SKILL.md');
const text = existsSync(SKILL_FILE) ? readFileSync(SKILL_FILE, 'utf8') : '';
const flat = text.replace(/\s*\n\s*/g, ' ');
const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
const body = text.slice(text.indexOf('\n---\n', 4) + 5);

test('the skill file exists', () => {
  assert.ok(existsSync(SKILL_FILE), 'plugins/methodology/skills/improving-evals/SKILL.md');
});

test('the front matter names the skill and its description starts "Use when"', () => {
  assert.match(frontMatter, /^name: improving-evals$/m);
  assert.match(frontMatter, /^description: Use when /m);
});

test('the body carries each required string', () => {
  for (const needle of [
    'triqual eval improve', 'triqual eval score --category', 'better', 'revisions.jsonl', 'train',
    'never open a test-split session', 'never ask the owner', 'one attempt per category per round', 'invented',
    'triqual eval rates',
  ]) assert.ok(body.includes(needle), `the body lacks: ${needle}`);
});

test('using-methodology names improving-evals and counts twelve skills', () => {
  const entry = readFileSync(join(PLUGIN, 'skills', 'using-methodology', 'SKILL.md'), 'utf8');
  assert.ok(entry.includes('`improving-evals`'));
  assert.ok(entry.includes('## The twelve skills'));
});

test('the using-methodology entry gives its trigger, the evals: line', () => {
  const entry = readFileSync(join(PLUGIN, 'skills', 'using-methodology', 'SKILL.md'), 'utf8');
  const line = entry.split('\n').find((l) => l.startsWith('- `improving-evals`'));
  assert.ok(line, 'an entry line for improving-evals');
  assert.match(line, /when an `evals:` line asks/);
});

test('the steps come in the specified order', () => {
  const order = [
    'run methodology:improving-evals',
    '`triqual eval improve`',
    '`failed`',
    '`revise`',
    '`misleading`',
    'plugins/methodology/evals/judges/<id>.md',
    'node --test plugins/methodology/test/eval-checks.test.mjs',
    'triqual eval judge --category <id> --sessions',
    'triqual eval score --category <id>',
    'git checkout -- ',
    'revisions.jsonl',
    'dev: previous',
    'never open a test-split session',
    'triqual eval rates',
    'at most 20 lines',
  ];
  let at = -1;
  for (const needle of order) {
    const next = flat.indexOf(needle, at + 1);
    assert.ok(next > at, `"${needle}" is missing or out of order`);
    at = next;
  }
});

test('the skill keeps a file only on a dev line that ends better, and reverts otherwise', () => {
  assert.match(flat, /ends in `better`|ends `better`|ends with `better`/);
  assert.match(flat, /git checkout -- plugins\/methodology\/evals\/judges\/<id>\.md/);
  assert.match(flat, /a rewrite is a candidate, never an improvement until measured/);
});

test('the report names the failed steps, and a failed round still has a usable revise', () => {
  assert.match(flat, /`failed` is not empty, name those steps in the final report/);
  assert.match(flat, /still has a usable `revise`/);
});

test('rulings.jsonl is read only through the train-split command, never opened another way', () => {
  assert.match(flat, /never open `rulings\.jsonl` (any other way|in any other way)/);
  assert.ok(text.includes('splitOf'));
});

test('the revisions line has its nine keys and takes n, previous and current from the score', () => {
  for (const key of ['at', 'round', 'category', 'from', 'to', 'kept', 'n', 'previous', 'current']) {
    assert.ok(text.includes(key), `revisions line lacks ${key}`);
  }
  assert.match(flat, /`\{ at, round, category, from, to, kept, n, previous, current \}`/);
});

test('the owner never rules, and the rules stand each on its own line', () => {
  const lines = text.split('\n');
  for (const needle of [
    'never open a test-split session or a ruling about one', 'never ask the owner to rule on a case',
    'one attempt per category per round', 'a rewrite is a candidate, never an improvement until measured',
    'a change to a skill, role or rule is released and measured by the next rounds\' `triqual eval rates`',
  ]) assert.ok(lines.some((line) => line.includes(needle)), `no single line holds: ${needle}`);
});

test('a paid credential entry is used only when the owner asked for --paid', () => {
  assert.match(flat, /`--paid`/);
  assert.match(flat, /paidOnly/);
});

test('the ship step is one round branch, one commit per kept category, then one bump, one pull request, one merge, one plugin update', () => {
  assert.match(flat, /one round branch/);
  assert.match(flat, /one commit per kept category/);
  assert.match(flat, /one bump commit of `methodology`'s `version`/);
  assert.match(flat, /one pull request/);
  assert.match(flat, /one merge under the repository's own merge rule/);
  assert.match(flat, /one plugin update/);
  assert.doesNotMatch(flat, /on its own branch/);
  assert.doesNotMatch(flat, /evals\/<id>-<round id>/);
});

test('the owner\'s --paid reaches the step 3e re-judge as well as the improve command', () => {
  const step = /\*\*Judge the sample\.\*\*([\s\S]*?)\n\s+f\. /.exec(text)?.[1] ?? '';
  assert.match(step, /--paid/);
});

test('the merge is this skill\'s job under the pre-authorisation, and no other stops are named', () => {
  assert.match(flat, /the merge, under the repository's own merge rule, is part of this skill's job/);
  assert.match(flat, /your human partner pre-authorised merges in this repository/);
});

test('the node command resolves the evals directory with evalsDir, not a hard-coded path', () => {
  const line = text.split('\n').find((l) => l.startsWith('node -e '));
  assert.ok(line.includes('eval-paths.mjs'));
  assert.ok(line.includes('evalsDir(process.env,os.homedir())'));
  assert.ok(!line.includes('.local/share'), 'no hard-coded data directory');
});

test('the node command follows XDG_DATA_HOME when TRIQUAL_EVALS_DIR is unset', () => {
  const line = text.split('\n').find((l) => l.startsWith('node -e '));
  const home = mkdtempSync(join(tmpdir(), 'improving-evals-xdg-'));
  try {
    const run = spawnSync(line.replace(/<id>/g, 'cat-a'), { shell: true, cwd: ROOT, encoding: 'utf8', env: { ...process.env, TRIQUAL_EVALS_DIR: '', XDG_DATA_HOME: home } });
    // Nothing is there, so it fails reading the sample under the XDG directory, never under ~/.local/share.
    assert.notEqual(run.status, 0);
    assert.ok(run.stderr.includes(home), run.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('no model alias and no text copied from a session', () => {
  assert.doesNotMatch(text, /\b(sonnet|haiku|opus)\b(?!-\d)/i);
  for (const alias of text.match(/\bclaude-[a-z]+(-[a-z0-9.]+)*\b/g) ?? []) {
    assert.match(alias, /-\d/, `${alias} is an alias, not a full model id`);
  }
});

test('the node command lists the train-split misleading notes of one category, and only those', () => {
  const line = text.split('\n').find((l) => l.startsWith('node -e '));
  assert.ok(line, 'the skill gives a one-line node command');
  const dir = mkdtempSync(join(tmpdir(), 'improving-evals-'));
  try {
    mkdirSync(join(dir, 'review'), { recursive: true });
    // Invented ids; the split of each follows splitOf, so the sample is built from the real function.
    const ids = Array.from({ length: 12 }, (_, i) => `invented-session-${i}`);
    const sample = [
      ...ids.map((sessionId) => ({ sessionId, stratum: 'random' })),
      { sessionId: 'invented-cost-1', stratum: 'cost' },
    ];
    const split = (r) => splitOf(r.sessionId, r.stratum);
    const dev = sample.find((r) => split(r) === 'dev');
    const test_ = sample.find((r) => split(r) === 'test');
    const train = sample.find((r) => split(r) === 'train');
    assert.ok(dev && test_ && train, 'the invented sample covers the three splits');
    writeFileSync(join(dir, 'review', 'sample.jsonl'), sample.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rulings = [
      { sessionId: train.sessionId, category: 'cat-a', misleading: 'invented note train a' },
      { sessionId: train.sessionId, category: 'cat-b', misleading: 'invented note train b' },
      { sessionId: dev.sessionId, category: 'cat-a', misleading: 'invented note dev a' },
      { sessionId: test_.sessionId, category: 'cat-a', misleading: 'invented note test a' },
      { sessionId: train.sessionId, category: 'cat-a', misleading: '' },
    ];
    writeFileSync(join(dir, 'rulings.jsonl'), rulings.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const run = spawnSync(line.replace(/<id>/g, 'cat-a'), { shell: true, cwd: ROOT, encoding: 'utf8', env: { ...process.env, TRIQUAL_EVALS_DIR: dir } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'invented note train a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it ends with a report format of at most 20 lines, one per category', () => {
  const tail = flat.slice(flat.lastIndexOf('at most 20 lines'));
  assert.match(tail, /one per category/);
  assert.match(tail, /kept or reverted/);
});
