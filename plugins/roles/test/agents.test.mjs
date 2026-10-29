import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');

// The role table: agent types `roles:<name>` that later tasks dispatch by these exact names.
const ROLES = {
  'brief-writer': { model: 'sonnet', effort: 'medium', disallowedTools: 'Agent, Edit, NotebookEdit' },
  'tdd-implementer': { model: 'sonnet', effort: 'high', disallowedTools: 'Agent' },
  'complex-implementer': { model: 'opus', effort: 'medium', disallowedTools: 'Agent' },
  'safety-reviewer': { model: 'sonnet', effort: 'medium', disallowedTools: 'Agent, Edit, Write, NotebookEdit' },
  'spec-reviewer': { model: 'opus', effort: 'medium', disallowedTools: 'Agent, Edit, Write, NotebookEdit' },
  'review-fixer': { model: 'sonnet', effort: 'high', disallowedTools: 'Agent' },
  'final-adversarial-reviewer': { model: 'opus', effort: 'low', disallowedTools: 'Agent, Edit, Write, NotebookEdit' },
  hunter: { model: 'claude-haiku-5-5', effort: 'medium', disallowedTools: 'Agent, Edit, NotebookEdit' },
  'phase-orchestrator': { model: 'sonnet', effort: 'medium', disallowedTools: 'Edit, NotebookEdit' },
};

// Minimal frontmatter parser: `key: value` lines between the first two `---` fences.
function parseAgent(file) {
  const text = readFileSync(join(AGENTS, file), 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[0], '---', `${file}: frontmatter must open on line 1`);
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, `${file}: frontmatter has no closing fence`);
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

const listTools = (s) => (s ?? '').split(',').map((t) => t.trim());

test('every role has the model, effort and tools of the role table', () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(ROLES).map((n) => `${n}.md`).sort());
  for (const [name, want] of Object.entries(ROLES)) {
    const { meta } = parseAgent(`${name}.md`);
    assert.equal(meta.name, name, `${name}: name must equal the file stem`);
    assert.ok(meta.description, `${name}: description must be non-empty`);
    assert.equal(meta.model, want.model, `${name}: model`);
    assert.equal(meta.effort, want.effort, `${name}: effort`);
    assert.deepEqual(listTools(meta.disallowedTools), listTools(want.disallowedTools), `${name}: disallowedTools`);
  }
});

test('safety-reviewer treats tracking files as expected', () => {
  const { body } = parseAgent('safety-reviewer.md');
  const line = body
    .split('\n')
    .find((l) => l.includes('`progress.md`') && l.includes('`status.md`') && l.includes('`docs/plans/*.tasks.json`'));
  assert.ok(line, 'safety-reviewer body must name progress.md, status.md and docs/plans/*.tasks.json in one line');
  assert.match(line, /expected in every task diff/);
  assert.match(line, /do not flag them as unexpected files/);
});

test('complex-implementer is tdd-implementer apart from its name and description', () => {
  const complex = parseAgent('complex-implementer.md');
  const tdd = parseAgent('tdd-implementer.md');
  assert.equal(complex.body, tdd.body);
  assert.equal(complex.meta.disallowedTools, tdd.meta.disallowedTools);
  assert.notEqual(complex.meta.description, tdd.meta.description);
  assert.ok(complex.meta.description.includes('**Role:** roles:complex-implementer'), 'description names the plan marker');
  assert.match(complex.meta.description, /^".*"$/, 'description is quoted like the other roles (Grok\'s YAML loader)');
});

test('tdd-implementer takes every implementation task except those a plan marks roles:complex-implementer', () => {
  const { description } = parseAgent('tdd-implementer.md').meta;
  assert.match(description, /^".*"$/, 'description is quoted like the other roles (Grok\'s YAML loader)');
  assert.match(description, /every implementation task/);
  assert.match(description, /except .*`roles:complex-implementer`/);
});

test('hunter can write only its candidates file', () => {
  const { meta, body } = parseAgent('hunter.md');
  assert.ok(body.includes('candidates-<category>.md'), 'hunter body must name candidates-<category>.md');
  assert.match(body, /never edit(s)? the repository/i);
  assert.ok(!listTools(meta.disallowedTools).includes('Write'), 'hunter must keep Write');
});

// Plan Store-2 T3 (Review Focus 5): in store mode an added root progress.md is a defect, not an expected tracking file.
test('safety-reviewer rule 7 splits by mode: store mode flags an added tracking path, not a deletion or templates/', () => {
  const { body } = parseAgent('safety-reviewer.md');
  const rule = body.split('\n').find((l) => l.startsWith('7. '));
  assert.ok(rule, 'safety-reviewer has no rule 7');
  // Committed and local mode keep the old meaning.
  assert.match(rule, /expected in every task diff/);
  assert.match(rule, /do not flag them as unexpected files/);
  for (const needle of ['store mode', 'added or modified', '`progress.md`', '`status.md`', '`*.tasks.json`', 'is a finding']) {
    assert.ok(rule.includes(needle), `rule 7 does not say ${needle}: ${rule}`);
  }
  assert.match(rule, /root `progress\.md`/, 'rule 7 does not flag an added root progress.md');
  assert.match(rule, /deletions? (?:is|are) not/i, 'rule 7 does not exempt deletions');
  assert.ok(rule.includes('`templates/progress.md`') || rule.includes('`templates/`'), 'rule 7 does not exempt templates/');
});

// Plan thin-controller T4: the phase orchestrator is the one role that dispatches the others.
test('only phase-orchestrator may use Agent', () => {
  for (const file of readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort()) {
    const { meta } = parseAgent(file);
    const disallowsAgent = listTools(meta.disallowedTools).includes('Agent');
    if (meta.name === 'phase-orchestrator') assert.ok(!disallowsAgent, 'phase-orchestrator must be able to dispatch agents');
    else assert.ok(disallowsAgent, `${meta.name}: must disallow Agent`);
  }
});

test('phase-orchestrator runs one phase through executing-plans and returns the summary contract', () => {
  const { meta, body } = parseAgent('phase-orchestrator.md');
  assert.match(meta.description, /^".*"$/, 'description is quoted like the other roles (Grok\'s YAML loader)');
  assert.ok(body.includes('`methodology:executing-plans`'), 'body names methodology:executing-plans');
  assert.match(body, /that phase only/);
  assert.match(body, /never edits? product code/i);
  assert.ok(body.includes('BLOCKED: <stop> — <details>'), 'body states the BLOCKED line');
  for (const needle of ['Phase: P<n> <done|blocked>', 'Tasks: T<N> <sha>', 'Rulings I made:', 'Open minors:', 'Errors and fallbacks:', 'at most 20 lines']) {
    assert.ok(body.includes(needle), `body lacks the summary contract line ${needle}`);
  }
  assert.ok(body.includes('## Denied by Policy'), 'body carries the denial rule heading');
});

// Plan fast-execution T1: verification is focused; the full suite is never run locally (CI runs it).
test('verification text never tells an agent to run the full suite, and the implementer side says focused', () => {
  const PROMPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'methodology', 'skills', 'executing-plans', 'implementer-prompt.md');
  const files = {
    'tdd-implementer.md': readFileSync(join(AGENTS, 'tdd-implementer.md'), 'utf8'),
    'complex-implementer.md': readFileSync(join(AGENTS, 'complex-implementer.md'), 'utf8'),
    'review-fixer.md': readFileSync(join(AGENTS, 'review-fixer.md'), 'utf8'),
    'safety-reviewer.md': readFileSync(join(AGENTS, 'safety-reviewer.md'), 'utf8'),
    'implementer-prompt.md': readFileSync(PROMPT, 'utf8'),
  };
  for (const [name, text] of Object.entries(files)) {
    // Collapse whitespace so a phrase wrapped over two lines still matches.
    const flat = text.replace(/\s+/g, ' ');
    for (const m of flat.matchAll(/(?:full|whole)[\s-]+(?:test[\s-]+)?suite/gi)) {
      // "never" must sit in the same clause (after the last "." or ";") as the mention.
      const clause = flat.slice(0, m.index).split(/[.;]/).pop();
      assert.match(clause, /\bnever\b/i, `${name}: "${m[0]}" without a "never" in its clause: ...${clause}${m[0]}`);
    }
  }
  // Pin the new rule itself: each file carries a phrase that only the focused-verification text contains.
  const pinned = {
    'tdd-implementer.md': [/`Test:` paths/, /never the full suite/],
    'complex-implementer.md': [/`Test:` paths/, /never the full suite/],
    'implementer-prompt.md': [/`Test:` paths/, /never the full suite/],
    'review-fixer.md': [/focused tests covering the amended code/, /never the full suite/],
    'safety-reviewer.md': [/`Test:` paths/, /never flag a missing full suite run/i],
  };
  for (const [name, patterns] of Object.entries(pinned)) {
    const flat = files[name].replace(/\s+/g, ' ');
    for (const re of patterns) assert.match(flat, re, `${name}: missing the focused-verification phrase ${re}`);
  }
});
