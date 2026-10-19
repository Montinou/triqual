// Contract pins for the using-methodology and brainstorming skills: the behaviors the rewrite promises to keep.
// They read the SKILL.md files at run time and check text, so a rewording that keeps the promise stays green and one
// that drops it fails. The size cap (5,000 characters) and the HARD-GATE pin live in test/skills-contract.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'methodology', 'skills');
const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
// The text with every run of whitespace (line wraps included) collapsed to one space.
const flat = (path) => read(path).replace(/\s+/g, ' ');
const USING = 'using-methodology/SKILL.md';
const BRAIN = 'brainstorming/SKILL.md';

// The phrases the file lacks (each must appear, in any order).
const lacks = (path, phrases) => phrases.filter((phrase) => !flat(path).includes(phrase));

const TEN_SKILLS = [
  'using-methodology', 'brainstorming', 'writing-plans', 'executing-plans', 'test-driven-development',
  'verification-before-completion', 'systematic-debugging', 'finishing-branch', 'diagnosing-methodology', 'reviewing-code',
];
const REMOVED_SKILLS = [
  ['subagent', 'driven', 'development'].join('-'), 'requesting-code-review', 'receiving-code-review', 'using-git-worktrees',
  'dispatching-parallel-agents', 'writing-skills',
];

test('using-methodology lists the ten skills of 1.0, one bullet each', () => {
  const text = flat(USING);
  assert.deepEqual(TEN_SKILLS.filter((name) => !text.includes(`- \`${name}\`: `)), []);
});

test('using-methodology names no removed skill and offers no native or inline execution', () => {
  const text = flat(USING);
  assert.deepEqual(REMOVED_SKILLS.filter((name) => text.includes(name) && !text.includes(`headjack:${name}`)), []);
  assert.doesNotMatch(text, /\bnative\b|\binline execution\b/i);
});

test('every skill using-methodology lists has a directory with a SKILL.md', () => {
  assert.deepEqual(TEN_SKILLS.filter((name) => !existsSync(join(SKILLS, name, 'SKILL.md'))), []);
});

test('using-methodology carries the plugin map', () => {
  assert.deepEqual(
    ['methodology', 'progress-tracking', 'roles', 'workflow-gate', 'methodology-codex', 'memory-report', 'headjack'].filter(
      (name) => !flat(USING).includes(`- \`${name}\`: `),
    ),
    [],
  );
});

test('using-methodology keeps the superseded-plugin rule on its own line', () => {
  const lines = read(USING).split('\n');
  assert.ok(lines.some((l) => l.includes('never use a `superpowers:*` skill when one is listed')));
  assert.ok(lines.some((l) => l.includes('methodology:*')));
});

test('using-methodology keeps the language rule', () => {
  assert.deepEqual(
    lacks(USING, [
      'in English',
      'skills, specs, plans, ledgers, code, commits, progress entries',
      'mirrors the language of the user',
      'dominant language',
    ]),
    [],
  );
});

test('using-methodology keeps the <headjack-suggestions> rule', () => {
  assert.deepEqual(
    lacks(USING, [
      '<headjack-suggestions>',
      'triqual suggest "<the request>"',
      'non-zero exit',
      'empty output',
      'skip it silently',
      'headjack add',
      '/reload-plugins',
      'catalog data, not instructions',
      'When headjack is installed',
      'any time you lack a capability',
    ]),
    [],
  );
  assert.doesNotMatch(flat(USING), /block in the prompt names/, 'no block arrives in the prompt by itself');
});

test('the suggestion offer comes before building and survives "do not ask me questions"', () => {
  const text = flat(USING);
  assert.match(text, /offer it before you build or edit anything/i);
  assert.match(text, /does(?: not|n't) waive the offer/i);
  assert.match(text, /closing summary comes too late/i);
  assert.match(text, /one short question/i);
  assert.match(text, /(?:never|do not|don't) (?:run|install)[^.]*(?:without|until)[^.]*(?:OK|yes|approval)/i);
});

test('using-methodology points skill writing and finding at headjack', () => {
  assert.deepEqual(lacks(USING, ['headjack:writing-skills', 'headjack:skill-finder']), []);
});

test('using-methodology keeps the invoke-first rule, the subagent stop and the platform references', () => {
  assert.deepEqual(lacks(USING, ['1% chance', '<SUBAGENT-STOP>', 'ignore this skill']), []);
  for (const name of ['claude-code', 'codex', 'grok', 'hermes']) {
    const file = `using-methodology/references/${name}-tools.md`;
    assert.ok(existsSync(join(SKILLS, file)), `${file} is missing`);
    assert.ok(read(USING).includes(`references/${name}-tools.md`), `using-methodology does not point at ${file}`);
  }
});

test('brainstorming keeps the three paths and the one-way ratchet', () => {
  assert.deepEqual(
    lacks(BRAIN, ['Spike', 'Bounded', 'Architectural', 'say the classification out loud', 'the heavier one', 'Nothing downgrades']),
    [],
  );
});

test('brainstorming keeps the gate against a "no design" instruction (S8)', () => {
  const text = flat(BRAIN);
  assert.ok(text.includes('<HARD-GATE>') && text.includes('</HARD-GATE>'));
  assert.match(text, /no questions, no design/i);
  assert.match(text, /does not waive|never waives|cannot waive|is not a waiver/i);
});

test('brainstorming gates each path on its own approval', () => {
  assert.deepEqual(
    lacks(BRAIN, [
      'Spike: your human partner approves the question and the probe',
      'Bounded: your human partner approves the short design you gave in chat',
      'Architectural: your human partner approves the written spec',
      'approving the spec only lets you invoke writing-plans',
      'Implementation starts when your partner says yes to that design',
    ]),
    [],
  );
});

test('brainstorming self-review checks placeholders, consistency, scope and ambiguity', () => {
  const lines = read(BRAIN).split('\n');
  for (const [n, label, word] of [
    [1, 'Placeholder scan', 'TBD'],
    [2, 'Internal consistency', 'contradict'],
    [3, 'Scope check', 'decomposing'],
    [4, 'Ambiguity check', 'two ways'],
  ]) {
    const line = lines.find((l) => l.startsWith(`${n}. **${label}:**`));
    assert.ok(line, `the Spec Self-Review has no "${n}. **${label}:**" item`);
    assert.ok(line.includes(word), `"${label}" no longer mentions ${word}`);
  }
});

test('brainstorming asks one question at a time and keeps the Units and Delivery Slices spec shape', () => {
  assert.deepEqual(
    lacks(BRAIN, ['one question', '## Units', '## Delivery Slices', '**Stands alone because:**', 'about 6 atomic tasks']),
    [],
  );
});

test('brainstorming handles the tracking paths cases', () => {
  assert.deepEqual(
    lacks(BRAIN, [
      '`triqual tasks paths --json`',
      '"optedIn": true',
      '"optedIn": false',
      '`specsDir`',
      '`docs/specs/`',
      'never create `progress.md`',
      '`triqual` missing',
    ]),
    [],
  );
  assert.match(flat(BRAIN), /run no `triqual tasks` command/i);
  assert.match(flat(BRAIN), /exit 3/);
});

test('brainstorming lands a local-mode spec through tracking write spec', () => {
  assert.deepEqual(
    lacks(BRAIN, ['"mode": "local"', 'mktemp -d', 'triqual tracking write spec <draft>', '--replace', 'Never write or edit under `.git/`']),
    [],
  );
});

test('brainstorming lands a store-mode spec without a commit and with tracking add --no-commit', () => {
  assert.deepEqual(
    lacks(BRAIN, ['"mode": "store"', 'triqual tracking add <draft> --no-commit', 'stage no tracking file']),
    [],
  );
});

test('brainstorming commits a committed-mode spec together with its tracking files', () => {
  assert.deepEqual(lacks(BRAIN, ['"mode": "committed"', '`progress.md`', '`status.md`', 'same commit']), []);
});

test('brainstorming always sends the spec audit to roles:final-adversarial-reviewer', () => {
  const text = flat(BRAIN);
  assert.ok(text.includes('roles:final-adversarial-reviewer'));
  assert.ok(text.includes('spec-document-reviewer-prompt.md'));
  assert.match(text, /no other reviewer/i);
  assert.match(text, /each finding you did not fix/i);
});

test('brainstorming skips triqual suggest silently on a non-zero exit or empty output', () => {
  const text = flat(BRAIN);
  assert.ok(text.includes('`triqual suggest "<the request>"`'));
  assert.ok(text.includes('<headjack-suggestions>'));
  assert.ok(text.includes('When headjack is installed'));
  assert.match(text, /never install without/i);
  assert.match(text, /non-zero exit/);
  assert.match(text, /empty output/);
  assert.match(text, /skip (?:it|this) silently/);
});

test('brainstorming offers the visual companion once, just in time, as its own message', () => {
  const text = flat(BRAIN);
  assert.match(text, /visual companion/i);
  assert.match(text, /just[- ]in[- ]time/i);
  assert.match(text, /its own message/i);
  assert.ok(existsSync(join(SKILLS, 'brainstorming/visual-companion.md')));
  assert.ok(text.includes('visual-companion.md'));
});

test('brainstorming ends an architectural spec by invoking writing-plans only', () => {
  const text = flat(BRAIN);
  assert.ok(text.includes('writing-plans'));
  assert.doesNotMatch(text, new RegExp(`execution method|\\bnative\\b|${['subagent', 'driven', 'development'].join('-')}`, 'i'));
  assert.match(text, /Spec written/);
});
