// Isolated `claude -p` invocation of one role for a transcript replay. The replayed agent runs with bypassPermissions,
// so it is kept away from the user's settings and hooks (--setting-sources project,local, --strict-mcp-config), from
// the tracking store (a `triqual` shim on PATH that answers and writes nothing) and from session history
// (--no-session-persistence). Every function here is pure apart from the files it is given paths to read or write.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRole } from './agents.mjs';
import { userInstalls } from './harness-sync.mjs';

// The alias words a model key can carry (`claude-haiku-5-5` -> haiku); a key with none is its own family.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];
const familyOf = (key) => key.split('-').find((part) => FAMILIES.includes(part)) ?? key;

// The agents JSON for `claude --agents`: the role's body and description from `<checkout>/plugins/roles/agents/<role>.md`,
// with the arm's model and effort in place of the file's. Its disallowed tools are kept.
export function agentsJson(checkout, role, { model, effort }) {
  const parsed = parseRole(readFileSync(join(checkout, 'plugins', 'roles', 'agents', `${role}.md`), 'utf8'));
  return JSON.stringify({
    [role]: {
      description: parsed.description,
      prompt: parsed.body,
      model,
      effort,
      disallowedTools: parsed.disallowedTools,
    },
  });
}

// The installed methodology plugin's directory for the user, or null when the plugin is not installed there.
export function methodologyPluginDir(home) {
  return userInstalls(home).methodology?.installPath ?? null;
}

// The argv of one isolated `claude` run; the caller passes it to spawn with no shell.
export function claudeArgs({ role, agents, model, effort, pluginDir }) {
  return [
    '-p', '--output-format', 'json',
    '--agents', agents,
    '--agent', role,
    '--model', model,
    '--effort', effort,
    '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config',
    '--setting-sources', 'project,local',
    '--no-session-persistence',
    '--plugin-dir', pluginDir,
  ];
}

// Every `{{WORK}}` becomes the work directory and every `{{CASE}}` the case directory, in one pass so that a value
// containing a placeholder is never substituted again.
export function fillPrompt(text, { work, caseDir }) {
  return text.replace(/\{\{(WORK|CASE)\}\}/g, (_, key) => (key === 'WORK' ? work : caseDir));
}

// Writes an executable `triqual` that answers every subcommand with a fixed line and exit 0, and returns `dir`.
// The caller prepends `dir` to PATH so no replayed run reaches the real tracking store.
export function writeShim(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'triqual');
  writeFileSync(file, '#!/bin/sh\necho "replay: triqual disabled"\nexit 0\n');
  chmodSync(file, 0o755);
  return dir;
}

// Whether the models a run used (`modelUsage` keys, as `claude -p --output-format json` reports them) match the arm.
// The arm's own family must be present, and every other key must be the haiku background model. A haiku arm therefore
// accepts only haiku keys.
export function modelOk(modelUsage, armModel) {
  const want = familyOf(armModel);
  const families = Object.keys(modelUsage).map(familyOf);
  return families.includes(want) && families.every((family) => family === want || family === 'haiku');
}
