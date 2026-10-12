// Harness registry for Codex and Grok: ids, the hook events each one runs, their timeouts, the files under the home,
// detection, and the translation between a harness's hook payloads and outputs and the Claude shape. Pure apart from
// `detect` (a stat plus the injected `run`), `expectedRules` (reads the plugin's rules files) and `bridgeId` with what
// builds on it (reads ~/.codex/config.toml, never logs it). Every caller passes explicit paths; nothing here resolves
// the real home.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.mjs';
import { hasTable } from './toml-edit.mjs';

export const HARNESS_IDS = ['codex', 'grok'];

// Grok has no `stop`: its progress gate is Claude's own progress-tracking Stop hook, run by Grok's Claude
// compatibility (spec F.3, F.11).
export const EVENTS = {
  codex: ['session-start', 'stop'],
  grok: ['pre-tool-use', 'post-tool-use', 'post-compact'],
};

// Seconds, per spec F.2: the bridge plugin's and the Grok hooks file's timeouts.
export const HOOK_TIMEOUTS = {
  codex: { 'session-start': 30, stop: 60 },
  grok: { 'pre-tool-use': 10, 'post-tool-use': 10, 'post-compact': 10 },
};

// The Codex bridge plugin `methodology-codex` (spec F.2): its version, which equals its `.codex-plugin/plugin.json`
// and moves only on a breaking release.
export const BRIDGE_VERSION = '0.2.0';

const BRIDGE_NAME = 'methodology-codex';

const readOrNull = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// The bridge's id as installed in Codex, `methodology-codex@<marketplace>`: triqual when ~/.codex/config.toml has
// its `[plugins."methodology-codex@triqual"]` table, else the legacy marketplace when that table exists under the
// legacy id, else triqual. Here so harness-sync and doctor share it without an import cycle.
export function bridgeId(home) {
  const text = readOrNull(harnessPaths(home, 'codex').config) ?? '';
  const id = (marketplace) => `${BRIDGE_NAME}@${marketplace}`;
  const installed = (marketplace) => hasTable(text, `plugins."${id(marketplace)}"`);
  if (installed(BRAND.marketplace)) return id(BRAND.marketplace);
  if (installed(BRAND.legacy.marketplace)) return id(BRAND.legacy.marketplace);
  return id(BRAND.marketplace);
}

// The trust keys Codex records for the bridge's two handlers, in the F.11 P5a form
// `<plugin>@<marketplace>:hooks/hooks.json:<event>:<group>:<handler>`.
export function codexTrustKeys(home) {
  const id = bridgeId(home);
  return [`${id}:hooks/hooks.json:session_start:0:0`, `${id}:hooks/hooks.json:stop:0:0`];
}

// Where Codex installs the bridge under `home` (F.11 P5a), under the marketplace of bridgeId.
export function codexBridgeDir(home, version = BRIDGE_VERSION) {
  const marketplace = bridgeId(home).slice(BRIDGE_NAME.length + 1);
  return join(home, '.codex', 'plugins', 'cache', marketplace, BRIDGE_NAME, version);
}

// The Claude clone of the marketplace bridgeId names, which the Codex marketplace of the same name points at. Missing
// before migration (the bridge id is triqual's, Claude Code still has only the legacy clone).
export function codexCloneDir(home) {
  return join(home, '.claude', 'plugins', 'marketplaces', bridgeId(home).slice(BRIDGE_NAME.length + 1));
}

export const GROK_RULES_HEAD = 'Before responding, load and follow the methodology:using-methodology skill '
  + '(skill using-methodology). The global rules are in ~/.claude/CLAUDE.md.';

const DETECT_TIMEOUT_MS = 10000;

const isEvent = (id, event) => Object.hasOwn(EVENTS, id) && EVENTS[id].includes(event);

// The files a harness uses under `home`. `null` marks a file we never touch: Codex hooks come from the bridge plugin,
// and Grok's config.toml holds plaintext secrets, so it is never read. Grok's `legacyRules` and `legacyHooksFile`
// are the pre-rename names sync backs up and removes.
export function harnessPaths(home, id) {
  if (id === 'codex') {
    const dir = join(home, '.codex');
    return {
      dir,
      skills: join(dir, 'skills'),
      agents: join(dir, 'agents'),
      rules: join(dir, 'AGENTS.md'),
      hooksFile: null,
      config: join(dir, 'config.toml'),
      binary: 'codex',
    };
  }
  if (id === 'grok') {
    const dir = join(home, '.grok');
    return {
      dir,
      skills: join(dir, 'skills'),
      agents: join(dir, 'agents'),
      rules: join(dir, 'rules', `${BRAND.grokName}.md`),
      hooksFile: join(dir, 'hooks', `${BRAND.grokName}.json`),
      legacyRules: join(dir, 'rules', `${BRAND.legacy.grokName}.md`),
      legacyHooksFile: join(dir, 'hooks', `${BRAND.legacy.grokName}.json`),
      config: null,
      binary: 'grok',
    };
  }
  throw new Error(`unknown harness: ${id}`);
}

// A harness is present when its home dir exists, else when `<binary> --version` exits 0. `run` has doctor's realRun
// shape; a run that rejects counts as absent.
export async function detect({ home, run }) {
  const found = [];
  for (const id of HARNESS_IDS) {
    const { dir, binary } = harnessPaths(home, id);
    if (existsSync(dir)) {
      found.push({ id, present: true, via: 'dir' });
      continue;
    }
    let code = null;
    try {
      ({ code } = await run(binary, ['--version'], { timeoutMs: DETECT_TIMEOUT_MS, cwd: home }));
    } catch {
      code = null;
    }
    found.push(code === 0 ? { id, present: true, via: 'binary' } : { id, present: false, via: null });
  }
  return found;
}

const str = (value) => (typeof value === 'string' ? value : null);

// The payload in the Claude shape, or null for a non-object, an unknown harness or event, or a missing `cwd`.
// Codex payloads are snake_case and have no child events (F.11 P5e). Grok payloads are camelCase with snake_case
// twins; `subagentType` marks a child, and no Grok event we run carries a prompt id or a stop state (F.11 P6a).
export function normalize(id, event, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!isEvent(id, event)) return null;
  const cwd = str(payload.cwd);
  if (!cwd) return null;
  if (id === 'codex') {
    return {
      session_id: str(payload.session_id),
      cwd,
      stop_hook_active: payload.stop_hook_active === true,
      source: str(payload.source),
      tool_use_id: str(payload.tool_use_id),
      prompt_id: null,
      subagent: false,
      reason: null,
    };
  }
  return {
    session_id: str(payload.sessionId) ?? str(payload.session_id),
    cwd,
    stop_hook_active: false,
    source: str(payload.source),
    tool_use_id: str(payload.toolUseId) ?? str(payload.tool_use_id),
    prompt_id: str(payload.promptId),
    // Only a non-empty string marks a child: a null or empty value must not silence every event of the main agent.
    subagent: typeof payload.subagentType === 'string' && payload.subagentType !== '',
    reason: null,
  };
}

// 'session-start' -> 'SessionStart', the hook event name the harness expects back.
const hookEventName = (event) => event.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

// The stdout JSON that hands `text` to the model as additional context.
export function formatContext(id, event, text) {
  if (!isEvent(id, event)) throw new Error(`unknown harness event: ${id} ${event}`);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: hookEventName(event), additionalContext: text } });
}

// The stdout JSON that blocks a Stop, the same for both harnesses.
export function formatBlock(id, reason) {
  if (!Object.hasOwn(EVENTS, id)) throw new Error(`unknown harness: ${id}`);
  return JSON.stringify({ decision: 'block', reason });
}

// The rules text sync writes for a harness and drift hashes. Codex: global.md, then its dispatch note. Grok: the head,
// then its note, with no global.md, since ~/.claude/CLAUDE.md loads in Grok (F.11 P6b).
export function expectedRules(pluginRoot, id) {
  const rules = join(pluginRoot, 'rules');
  const note = (name) => readFileSync(join(rules, 'harness', `${name}.md`), 'utf8');
  if (id === 'codex') {
    const global = readFileSync(join(rules, 'global.md'), 'utf8').replace(/\n+$/, '');
    return `${global}\n\n${note('codex')}`;
  }
  if (id === 'grok') return `${GROK_RULES_HEAD}\n\n${note('grok')}`;
  throw new Error(`unknown harness: ${id}`);
}
