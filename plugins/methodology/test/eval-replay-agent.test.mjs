import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentsJson, methodologyPluginDir, claudeArgs, fillPrompt, writeShim, modelOk,
} from '../cli/lib/eval-replay-agent.mjs';

// Invented checkout and home only: no test reads the real ~/.claude or ~/.config.
let tmp;
let checkout;

const ROLE_FILE = `---
name: tdd-implementer
description: "Implements one plan task from a brief."
model: sonnet
effort: high
disallowedTools: Agent
---

You implement exactly one task.
`;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'eval-replay-agent-'));
  checkout = join(tmp, 'checkout');
  mkdirSync(join(checkout, 'plugins', 'roles', 'agents'), { recursive: true });
  writeFileSync(join(checkout, 'plugins', 'roles', 'agents', 'tdd-implementer.md'), ROLE_FILE);
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('agentsJson sets the arm model and effort in the definition', () => {
  const a = JSON.parse(agentsJson(checkout, 'tdd-implementer', { model: 'haiku', effort: 'high' }))['tdd-implementer'];
  assert.equal(a.model, 'haiku');
  assert.equal(a.effort, 'high');
  assert.deepEqual(a.disallowedTools, ['Agent']);
  assert.ok(!a.prompt.startsWith('---'));
});

test('claudeArgs carries the isolation flags and the model', () => {
  const args = claudeArgs({ role: 'r', agents: '{}', model: 'haiku', effort: 'high', pluginDir: '/p' });
  for (const flag of ['--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
});

test('fillPrompt', () => {
  assert.equal(fillPrompt('{{WORK}}/a {{CASE}}/files/b {{WORK}}', { work: '/w', caseDir: '/c' }), '/w/a /c/files/b /w');
});

test('the shim answers every triqual subcommand and writes nothing', () => {
  const dir = join(tmp, 'shim');
  const r = spawnSync(join(writeShim(dir), 'triqual'), ['tracking', 'add', 'x'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'replay: triqual disabled');
});

test('modelOk', () => {
  assert.equal(modelOk({ 'claude-sonnet-5-5': {}, 'claude-haiku-5-5': {} }, 'sonnet'), true);
  assert.equal(modelOk({ 'claude-sonnet-5-5': {} }, 'haiku'), false);
  assert.equal(modelOk({ 'claude-haiku-5-5': {} }, 'sonnet'), false);
  assert.equal(modelOk({ 'claude-haiku-5-5': {} }, 'haiku'), true);
});

test('methodologyPluginDir reads the user-scope install path and is null without one', () => {
  const home = join(tmp, 'home');
  assert.equal(methodologyPluginDir(home), null);
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  const installPath = join(tmp, 'cache', 'methodology', '1.16.1');
  const installed = { plugins: { 'methodology@triqual': [{ scope: 'user', installPath, version: '1.16.1' }] } };
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  assert.equal(methodologyPluginDir(home), installPath);
});
