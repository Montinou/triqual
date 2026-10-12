// Role-agent generator (spec Addendum F.7, F.11 P5d/P6d): the Codex agent files built from the roles plugin's
// agents/*.md, their TOML string encoding, and the roles install's sha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_MARK, CODEX_XHIGH, CODEX_READONLY_REVIEWERS, CODEX_TOOL_NAMES,
  parseRole, tomlString, codexAgentToml, rolesSha, isGenerated,
} from '../bin/lib/agents.mjs';
import { applyAgents, codexAgentText } from '../bin/lib/harness-links.mjs';
import { sha256 } from '../bin/lib/fsx.mjs';
import { BRAND } from '../bin/lib/brand.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROLES_AGENTS = join(TEST_DIR, '..', '..', 'roles', 'agents');
// Role `n` (description d, body "Body.") as the pre-rename code generated it at roles 0.1.0, captured from HEAD a3223d4.
const LEGACY_AGENT = readFileSync(join(TEST_DIR, 'fixtures', 'legacy', 'codex-agent.toml'), 'utf8');

const ROLE_NAMES = [
  'brief-writer',
  'complex-implementer',
  'final-adversarial-reviewer',
  'hunter',
  'review-fixer',
  'safety-reviewer',
  'spec-reviewer',
  'tdd-implementer',
];
const READ_ONLY_ROLES = ['final-adversarial-reviewer', 'safety-reviewer', 'spec-reviewer'];

const shippedRoles = () =>
  readdirSync(ROLES_AGENTS)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => parseRole(readFileSync(join(ROLES_AGENTS, name), 'utf8')));

// A minimal TOML basic-string reader: the value between the quotes, with only `\\ \" \n \t \uXXXX` unescaped.
// Anything else (a raw control character, another escape, an unescaped quote) is an error.
const readBasicString = (literal) => {
  assert.ok(literal.startsWith('"') && literal.endsWith('"') && literal.length >= 2, `not a basic string: ${literal}`);
  const inner = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '"') throw new Error(`unescaped quote at ${i}`);
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(c)) throw new Error(`raw control character at ${i}`);
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = inner[i + 1];
    i += 1;
    if (e === '\\') out += '\\';
    else if (e === '"') out += '"';
    else if (e === 'n') out += '\n';
    else if (e === 't') out += '\t';
    else if (e === 'u') {
      const hex = inner.slice(i + 1, i + 5);
      assert.match(hex, /^[0-9a-fA-F]{4}$/, `bad \\u escape at ${i}`);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else throw new Error(`unsupported escape \\${e} at ${i}`);
  }
  return out;
};

// `key = "value"` lines → { key: value }; comments and blank lines are skipped.
const readToml = (text) => {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = /^([A-Za-z_]+) = (".*")$/.exec(line);
    assert.ok(m, `not a key = "string" line: ${line}`);
    out[m[1]] = readBasicString(m[2]);
  }
  return out;
};

const ROLE_TEXT = (front, body = 'Body.\n') => `---\n${front}\n---\n\n${body}`;

test('parses the eight shipped roles', () => {
  const roles = shippedRoles();
  assert.deepEqual(roles.map((role) => role.name), ROLE_NAMES);
  const byName = Object.fromEntries(roles.map((role) => [role.name, role]));
  assert.equal(byName['final-adversarial-reviewer'].effort, 'xhigh');
  assert.equal(byName['brief-writer'].effort, 'medium');
  assert.deepEqual(byName['safety-reviewer'].disallowedTools, ['Agent', 'Edit', 'Write', 'NotebookEdit']);
  assert.deepEqual(byName['tdd-implementer'].disallowedTools, ['Agent']);
  for (const role of roles) {
    assert.ok(role.description.length > 0, `${role.name} has no description`);
    assert.ok(role.body.startsWith('You '), `${role.name}: the body does not start after the frontmatter`);
    assert.ok(!role.body.includes('\n---\n') && !role.body.includes('disallowedTools:'), `${role.name}: frontmatter in body`);
    assert.equal(role.body, role.body.trim(), `${role.name}: the body is not trimmed`);
  }
});

test('parseRole throws on a missing name or description, and reads no disallowedTools as []', () => {
  assert.throws(() => parseRole(ROLE_TEXT('description: d')), /name/);
  assert.throws(() => parseRole(ROLE_TEXT('name: n')), /description/);
  assert.throws(() => parseRole('no frontmatter\n'), /name/);
  const role = parseRole(ROLE_TEXT('name: n\ndescription: a: b'));
  assert.deepEqual(role, { name: 'n', description: 'a: b', effort: undefined, disallowedTools: [], body: 'Body.' });
});

test('parseRole unwraps one pair of matching quotes so a colon-safe description stays plain', () => {
  const quoted = parseRole(ROLE_TEXT('name: n\ndescription: "has: a colon"'));
  assert.equal(quoted.description, 'has: a colon');
  const single = parseRole(ROLE_TEXT("name: n\ndescription: 'has: a colon'"));
  assert.equal(single.description, 'has: a colon');
  for (const role of shippedRoles()) {
    assert.equal(role.description.startsWith('"'), false, `${role.name} keeps the YAML quotes`);
    assert.equal(role.description.endsWith('"'), false, `${role.name} keeps the YAML quotes`);
  }
});

test('tomlString round-trips', () => {
  const bodies = [
    'back\\slash and \\n literal',
    'triple """ quotes',
    'a "quoted" word',
    'line one\nline two\n\nline four',
    'tab\there',
    'control \u0001 and \u001f and \u007f and \r',
    'non-ASCII ñ, é, 日本',
    '',
    '\\"\\\\"""\n\t\u0001ñ',
  ];
  for (const body of bodies) {
    const encoded = tomlString(body);
    assert.ok(!encoded.includes('\n'), `not one line: ${encoded}`);
    assert.ok(!encoded.slice(1, -1).includes('"""'), `holds """: ${encoded}`);
    assert.equal(readBasicString(encoded), body);
  }
  assert.equal(tomlString('ñ'), '"ñ"', 'non-ASCII is kept as is');
  assert.equal(tomlString('\u0001'), '"\\u0001"');
});

test('codexAgentToml assigns a model and effort by task difficulty for each shipped role', () => {
  const expected = {
    'brief-writer': { model: 'gpt-6-luna', effort: 'medium' },
    'safety-reviewer': { model: 'gpt-6-luna', effort: 'medium' },
    hunter: { model: 'gpt-6-luna', effort: 'medium' },
    'tdd-implementer': { model: 'gpt-6.1-sol', effort: 'low' },
    'review-fixer': { model: 'gpt-6.1-sol', effort: 'low' },
    'spec-reviewer': { model: 'gpt-6.1-sol', effort: 'high' },
    'complex-implementer': { model: 'gpt-6.1-sol', effort: 'high' },
    'final-adversarial-reviewer': { model: 'gpt-6-astra', effort: 'medium' },
  };
  assert.deepEqual(shippedRoles().map((role) => role.name).sort(), Object.keys(expected).sort());
  for (const role of shippedRoles()) {
    const toml = codexAgentToml(role, { rolesVersion: '0.1.0', xhigh: true, readOnly: true });
    assert.equal(toml.split('\n')[0], `${GENERATED_MARK}0.1.0`);
    assert.equal(GENERATED_MARK, '# generated by triqual from roles ');
    assert.ok(!toml.includes('"""'), `${role.name} holds """`);
    const keys = readToml(toml);
    assert.equal(keys.name, role.name);
    assert.equal(keys.description, role.description);
    assert.ok(keys.developer_instructions.startsWith(role.body), `${role.name}: the body is not the instructions`);
    assert.equal(keys.model, expected[role.name].model, `${role.name}: Codex model`);
    assert.equal(keys.model_reasoning_effort, expected[role.name].effort, `${role.name}: Codex effort`);
  }
});

test('Codex routing stays independent of Claude model and effort changes', () => {
  for (const model of ['sonnet', 'opus', 'inherit']) {
    const role = parseRole(ROLE_TEXT(`name: brief-writer\ndescription: d\nmodel: ${model}\neffort: low`));
    const keys = readToml(codexAgentToml(role, { rolesVersion: '1', xhigh: true, readOnly: false }));
    assert.equal(keys.model, 'gpt-6-luna');
    assert.equal(keys.model_reasoning_effort, 'medium');
  }
  for (const name of ['safety-reviewer', 'hunter']) {
    const role = parseRole(ROLE_TEXT(`name: ${name}\ndescription: d\nmodel: inherit\neffort: low`));
    const keys = readToml(codexAgentToml(role, { rolesVersion: '1', xhigh: true, readOnly: false }));
    assert.equal(keys.model, 'gpt-6-luna', name);
    assert.equal(keys.model_reasoning_effort, 'medium', name);
  }
  // Claude's frontmatter says xhigh here, so a Codex effort of low or high can only come from the routing table.
  for (const [name, model, effort] of [
    ['tdd-implementer', 'gpt-6.1-sol', 'low'],
    ['review-fixer', 'gpt-6.1-sol', 'low'],
    ['complex-implementer', 'gpt-6.1-sol', 'high'],
  ]) {
    const role = parseRole(ROLE_TEXT(`name: ${name}\ndescription: d\nmodel: haiku\neffort: xhigh`));
    const keys = readToml(codexAgentToml(role, { rolesVersion: '1', xhigh: true, readOnly: false }));
    assert.equal(keys.model, model, name);
    assert.equal(keys.model_reasoning_effort, effort, name);
  }
});

test('codexAgentToml: read-only sandbox only for the four roles that disallow Edit and Write, only with readOnly', () => {
  const withSandbox = (readOnly) =>
    shippedRoles()
      .filter((role) => {
        const keys = readToml(codexAgentToml(role, { rolesVersion: '1', xhigh: true, readOnly }));
        if ('sandbox_mode' in keys) assert.equal(keys.sandbox_mode, 'read-only');
        return 'sandbox_mode' in keys;
      })
      .map((role) => role.name);
  assert.deepEqual(withSandbox(true), READ_ONLY_ROLES);
  assert.deepEqual(withSandbox(false), []);
  const onlyEdit = parseRole(ROLE_TEXT('name: n\ndescription: d\ndisallowedTools: Edit'));
  assert.ok(!('sandbox_mode' in readToml(codexAgentToml(onlyEdit, { rolesVersion: '1', xhigh: true, readOnly: true }))));
});

test('codexAgentToml: effort is the role\'s, and xhigh becomes high when xhigh is false', () => {
  const effortOf = (role, xhigh) =>
    readToml(codexAgentToml(role, { rolesVersion: '1', xhigh, readOnly: false })).model_reasoning_effort;
  const byName = Object.fromEntries(shippedRoles().map((role) => [role.name, role]));
  assert.equal(effortOf(byName['final-adversarial-reviewer'], true), 'medium');
  assert.equal(effortOf(byName['final-adversarial-reviewer'], false), 'medium');
  // No shipped role routes to xhigh now; a role outside the routing table keeps its frontmatter effort, so the
  // downgrade is pinned on one.
  const unrouted = parseRole(ROLE_TEXT('name: unrouted-role\ndescription: d\neffort: xhigh'));
  assert.equal(effortOf(unrouted, true), 'xhigh');
  assert.equal(effortOf(unrouted, false), 'high');
  assert.equal(effortOf(byName['brief-writer'], false), 'medium');
  assert.equal(effortOf(byName['tdd-implementer'], false), 'low');
  assert.equal(effortOf(byName['complex-implementer'], false), 'high');
});

test('codexAgentToml: disallowed tools become one sentence in Codex tool names', () => {
  const instructions = (front) =>
    readToml(codexAgentToml(parseRole(ROLE_TEXT(`name: n\ndescription: d\n${front}`, 'Do the work.\n')), {
      rolesVersion: '1', xhigh: true, readOnly: true,
    })).developer_instructions;
  assert.equal(
    instructions('disallowedTools: Edit, Write, Agent'),
    'Do the work.\n\nTools you must not use: apply_patch, spawn_agent.',
  );
  // apply_patch is forbidden outright only when both Edit and Write are; one alone forbids that use of it.
  assert.equal(instructions('disallowedTools: Agent, NotebookEdit, Edit'),
    'Do the work.\n\nTools you must not use: spawn_agent, apply_patch on existing files.');
  assert.equal(instructions('disallowedTools: Write'), 'Do the work.\n\nTools you must not use: apply_patch to create files.');
  assert.equal(instructions('disallowedTools: Write, Agent, Edit'), 'Do the work.\n\nTools you must not use: apply_patch, spawn_agent.');
  // A Claude-only tool with no Codex equivalent is left out; a name the table does not know passes through.
  assert.equal(instructions('disallowedTools: NotebookEdit'), 'Do the work.');
  assert.equal(instructions('disallowedTools: NotebookEdit, Bash'), 'Do the work.\n\nTools you must not use: Bash.');
  assert.equal(instructions(''), 'Do the work.');
  for (const role of shippedRoles()) {
    const keys = readToml(codexAgentToml(role, { rolesVersion: '1', xhigh: true, readOnly: true }));
    assert.match(keys.developer_instructions, /\n\nTools you must not use: [^\n]+\.$/, `${role.name} lacks the sentence`);
    assert.doesNotMatch(keys.developer_instructions, /NotebookEdit/, `${role.name} names NotebookEdit`);
  }
});

test('codexAgentToml: the shipped brief-writer and the hunter keep apply_patch, the four read-only roles forbid it', () => {
  const forbidden = (role) => {
    const text = readToml(codexAgentToml(role, { rolesVersion: '1', xhigh: true, readOnly: true })).developer_instructions;
    const m = /\n\nTools you must not use: ([^\n]+)\.$/.exec(text);
    assert.ok(m, `${role.name} lacks the sentence`);
    return m[1].split(', ');
  };
  const byName = Object.fromEntries(shippedRoles().map((role) => [role.name, role]));
  // brief-writer disallows Edit but writes its brief file, so plain apply_patch must stay usable.
  assert.deepEqual(byName['brief-writer'].disallowedTools, ['Agent', 'Edit', 'NotebookEdit']);
  assert.deepEqual(forbidden(byName['brief-writer']), ['spawn_agent', 'apply_patch on existing files']);
  // hunter writes its candidates file, so it is asserted like brief-writer.
  assert.deepEqual(byName.hunter.disallowedTools, ['Agent', 'Edit', 'NotebookEdit']);
  assert.deepEqual(forbidden(byName.hunter), ['spawn_agent', 'apply_patch on existing files']);
  for (const name of READ_ONLY_ROLES) assert.deepEqual(forbidden(byName[name]), ['spawn_agent', 'apply_patch'], name);
});

test('codexAgentToml: rolesVersion must be a non-empty string and cannot inject a line', () => {
  const role = parseRole(ROLE_TEXT('name: n\ndescription: d'));
  for (const rolesVersion of [undefined, null, '', 1]) {
    assert.throws(() => codexAgentToml(role, { rolesVersion, xhigh: true, readOnly: true }), /rolesVersion/);
  }
  const toml = codexAgentToml(role, { rolesVersion: '1.0\nmodel = "evil"\r\u0000', xhigh: true, readOnly: true });
  const lines = toml.split('\n');
  assert.equal(lines[0], `${GENERATED_MARK}1.0model = "evil"`);
  assert.equal(lines[1], 'name = "n"');
  assert.doesNotMatch(toml, /^model\s*=/m);
  assert.deepEqual(Object.keys(readToml(toml)), ['name', 'description', 'developer_instructions']);
});

test('the P5d constants and the Codex tool names', () => {
  assert.equal(CODEX_XHIGH, true);
  // Final review M2: the key was measured only under a bypassPermissions parent, so no generated role carries it.
  assert.equal(CODEX_READONLY_REVIEWERS, false);
  assert.deepEqual(CODEX_TOOL_NAMES, { Edit: 'apply_patch', Write: 'apply_patch', Agent: 'spawn_agent', NotebookEdit: null });
});

test('rolesSha changes when one agent file changes, not when mtime changes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roles-sha-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'b.md'), 'bee\n');
  writeFileSync(join(dir, 'a.md'), 'ay\n');
  writeFileSync(join(dir, 'notes.txt'), 'not an agent\n');
  const first = rolesSha(dir);
  assert.match(first, /^[0-9a-f]{64}$/);

  const later = new Date(Date.now() + 3600_000);
  utimesSync(join(dir, 'a.md'), later, later);
  assert.equal(rolesSha(dir), first, 'an mtime change moved the sha');
  writeFileSync(join(dir, 'notes.txt'), 'changed\n');
  assert.equal(rolesSha(dir), first, 'a non-.md file moved the sha');

  writeFileSync(join(dir, 'a.md'), 'ay!\n');
  const changed = rolesSha(dir);
  assert.notEqual(changed, first, 'a content change did not move the sha');
  writeFileSync(join(dir, 'a.md'), 'ay\n');
  assert.equal(rolesSha(dir), first, 'the sha does not depend only on names and contents');

  // Names are hashed too: moving the content across names changes the sha.
  writeFileSync(join(dir, 'a.md'), 'bee\n');
  writeFileSync(join(dir, 'b.md'), 'ay\n');
  assert.notEqual(rolesSha(dir), first, 'swapping contents between files did not move the sha');
});

test('a legacy generated agent is ours and is rewritten with the new mark; harness-links does not back it up as a user file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-agents-'));
  try {
    const roles = { enabled: true, version: '0.1.0', installPath: join(dir, 'roles') };
    mkdirSync(join(roles.installPath, 'agents'), { recursive: true });
    writeFileSync(join(roles.installPath, 'agents', 'n.md'), ROLE_TEXT('name: n\ndescription: d'));
    const expected = codexAgentText(parseRole(ROLE_TEXT('name: n\ndescription: d')), roles);
    assert.ok(LEGACY_AGENT.startsWith(BRAND.legacy.generatedMark));
    assert.equal(LEGACY_AGENT.replace(BRAND.legacy.generatedMark, BRAND.generatedMark), expected);
    assert.equal(isGenerated(LEGACY_AGENT), true);
    assert.equal(isGenerated(expected), true);
    assert.equal(isGenerated('# hand-written role\nname = "n"\n'), false);

    const out = join(dir, 'codex-agents');
    const backupDir = join(dir, 'backup');
    mkdirSync(out);
    writeFileSync(join(out, 'n.toml'), LEGACY_AGENT);
    const entry = { files: [] };
    const r = applyAgents({ dir: out, installs: { methodology: { enabled: true }, roles }, backupDir }, entry);
    assert.deepEqual(r, { status: 'done', detail: 'wrote 1 agent from roles 0.1.0' });
    assert.equal(readFileSync(join(out, 'n.toml'), 'utf8'), expected);
    assert.equal(existsSync(backupDir), false, 'the legacy agent was backed up as a user file');
    assert.deepEqual(entry.files, [{ path: join(out, 'n.toml'), sha256: sha256(expected), backup: null }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
