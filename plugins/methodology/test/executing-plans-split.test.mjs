// The executing-plans skill keeps its core in SKILL.md and holds seven sections as references/<name>.md. Each
// reference is exactly the original section text, heading included; the sha256 constants below were computed from
// SKILL.md as it was before the move. SKILL.md stays under its byte budget and names every reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EP = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'executing-plans');
const SKILL = join(EP, 'SKILL.md');
const MAX_BYTES = 87040;

// name, the heading the section began with in SKILL.md, sha256 of the section text (heading to the line before the
// next heading of the same or a higher level, trailing blank lines dropped, one final newline).
const REFERENCES = [
  ['setup', '## Setup', '1b99234fecba023f0dd0da96d207e8cf8d946f47b37107a33b879cc2194ce7bb'],
  ['records', '## Records', '27382c704d733ccd824c080e81e2ace5ea4f9c701c250a2b4f03914f670ef785'],
  ['ledger-vocabulary', '## Ledger vocabulary', 'd5538fe8ce8760ef93cd6fde96742e2cc5f8f1783ffc4214b14e7f23e4cff746'],
  ['worktrees', '## Worktrees', 'e45e1f51e4aafb1e43441712df14b8c4980a3382fae9c3b3ce201f4d1c416f05'],
  ['final-review', '## Final Review', 'caa9a5fc7b13fb478039fd0cc6b2eec8ce5082e76cca3168d77d0d29deb7dbcd'],
  ['example', '## Example', '2e52d91e910461cc9d0b0af2605b5057fd7d7bed6bb131785b746b79ad031f98'],
  ['parallel-tasks', '### Parallel tasks', '85e3b99c2fdc7d4f5f14e382dd61b35dc53a9304899a176872db4af7019f40f4'],
];

const sha = (text) => createHash('sha256').update(text).digest('hex');
const skill = () => readFileSync(SKILL, 'utf8');
const ref = (name) => readFileSync(join(EP, 'references', `${name}.md`), 'utf8');

// Every heading line of a text, ignoring heading-looking lines inside a code fence.
function headings(text) {
  let fence = false;
  const out = [];
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    else if (!fence && /^#{1,6} /.test(line)) out.push(line);
  }
  return out;
}

test('SKILL.md is under the byte budget', () => {
  const size = statSync(SKILL).size;
  assert.ok(size < MAX_BYTES, `SKILL.md is ${size} bytes, the budget is under ${MAX_BYTES}`);
});

for (const [name, heading, hash] of REFERENCES) {
  test(`references/${name}.md is exactly the original section`, () => {
    const text = ref(name);
    assert.ok(text.startsWith(`${heading}\n`), `${name}.md starts with ${heading}`);
    assert.equal(sha(text), hash);
  });

  test(`SKILL.md no longer holds the ${name} section and points at its reference`, () => {
    const lines = skill().split('\n');
    for (const h of headings(ref(name))) assert.ok(!lines.includes(h), `SKILL.md still has the heading ${h}`);
    assert.ok(skill().includes(`references/${name}.md`), `SKILL.md does not name references/${name}.md`);
  });
}

test('every pointer reads as `Read references/<name>.md when <clause>.`', () => {
  const text = skill();
  for (const [name] of REFERENCES) {
    assert.match(text, new RegExp(`Read references/${name}\\.md when [^.\\n]+\\.`), `no Read pointer for ${name}`);
  }
});

// A single-phase plan never starts a seams review, yet final-review.md also carries the Submit step, so the pointer's
// trigger must not make the seams review a precondition.
test('the final-review pointer triggers on the last phase being submitted, not on a seams review', () => {
  const m = skill().match(/Read references\/final-review\.md when ([^.\n]+)\./);
  assert.ok(m, 'no Read pointer for final-review');
  assert.doesNotMatch(m[1], /seams/i, `the trigger makes the seams review a precondition: ${m[1]}`);
  assert.match(m[1], /last phase is submitted/);
});
