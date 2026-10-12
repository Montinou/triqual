// SessionStart entry point (spec §9.2, Addendum E.3, E.9). The drift check gives a notice when the managed section of
// ~/.claude/CLAUDE.md differs from the installed rules/global.md, or when a plugin the manifest supersedes is still
// enabled at user scope (not under keepSuperseded). On startup, clear and compact the hook injects those lines followed
// by the wrapped using-methodology skill, or under keepSuperseded by a short note instead; on resume, the lines only, plus
// a one-line note naming using-methodology once superpowers is disabled.
// With `--harness <id>` (Codex, Grok; spec Addendum F.3) the rules line checks that harness's rules target instead of
// ~/.claude/CLAUDE.md, and names `triqual sync --harness <id>`.
// Never throws; the hook always exits 0. A swallowed error (not a missing settings or CLAUDE.md file) is logged as one
// line to ${CLAUDE_PLUGIN_DATA}/log when that is set.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManagedSection, sha256 } from './lib/fsx.mjs';
import { readMethodologyConfig, supersededEnabled } from './lib/settings.mjs';
import { HARNESS_IDS, expectedRules, harnessPaths } from './lib/harnesses.mjs';

const RULES_NOTICE = 'triqual: global rules out of date: run `triqual sync`';
const harnessRulesNotice = (id) => `triqual: ${id} rules out of date: run \`triqual sync --harness ${id}\``;
// Injected instead of using-methodology when the user keeps superpowers as the entry point (spec Addendum E.3).
const KEEP_NOTE = "triqual: superpowers is active by keepSuperseded; methodology's skills stay available as methodology:*";
// Injected on resume when superpowers is disabled (not under keepSuperseded): a session resumed from before the rollout
// holds superpowers' introduction, not using-methodology's, and resume injects no skill (spec Addendum E.3).
const RESUME_NOTE = 'triqual: methodology skills are active (methodology:using-methodology); superpowers is disabled';

// Appends `<ISO time> drift: <message>` to <dataDir>/log. No dataDir: nothing; a failing write is ignored.
function logError(dataDir, err) {
  if (!dataDir) return;
  try {
    const message = String(err?.message ?? err).replace(/\s*\n\s*/g, ' ');
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'log'), `${new Date().toISOString()} drift: ${message}\n`);
  } catch { /* logging never breaks a session */ }
}

// A missing file is an expected state, not an error worth logging.
const logUnexpected = (dataDir, err) => { if (err?.code !== 'ENOENT') logError(dataDir, err); };

// A harness's rules target: Codex's is the managed section of ~/.codex/AGENTS.md, Grok's a whole file sync writes.
function harnessRulesCurrent(home, pluginRoot, harness) {
  const text = readFileSync(harnessPaths(home, harness).rules, 'utf8');
  const body = harness === 'codex' ? readManagedSection(text).body : text.trim();
  if (body === null) return false;
  return sha256(body) === sha256(expectedRules(pluginRoot, harness).trim());
}

function rulesCurrent(home, pluginRoot, dataDir, harness) {
  try {
    if (harness !== null) return harnessRulesCurrent(home, pluginRoot, harness);
    const { body } = readManagedSection(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'));
    if (body === null) return false;
    return sha256(body) === sha256(readFileSync(join(pluginRoot, 'rules', 'global.md'), 'utf8').trim());
  } catch (err) {
    logUnexpected(dataDir, err);
    return false;
  }
}

// The manifest's supersedes patterns and the superseded plugins enabled at user scope, or null (logged unless a file is
// missing) when the manifest or settings.json cannot be read.
function supersededState(home, pluginRoot, dataDir) {
  try {
    const { supersedes = [] } = JSON.parse(readFileSync(join(pluginRoot, 'rules', 'manifest.json'), 'utf8'));
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    return { supersedes, enabled: supersededEnabled(supersedes, settings?.enabledPlugins) };
  } catch (err) {
    logUnexpected(dataDir, err);
    return null;
  }
}

// The machine config; an invalid one is logged and read as the defaults.
function methodologyConfig(home, dataDir) {
  const config = readMethodologyConfig(home);
  if (config.error) logError(dataDir, config.error);
  return config;
}

// The drift lines for an already read config and superseded state (supersededState; null reads as none enabled).
function driftLines({ home, pluginRoot, dataDir, config, state, harness = null }) {
  try {
    const lines = [];
    if (!rulesCurrent(home, pluginRoot, dataDir, harness)) lines.push(harness === null ? RULES_NOTICE : harnessRulesNotice(harness));
    const superseded = config.keepSuperseded ? [] : state?.enabled ?? [];
    for (const id of superseded) {
      lines.push(`triqual: superseded plugin still enabled: ${id} — run \`triqual sync\``);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (err) {
    logError(dataDir, err);
    return null;
  }
}

// dataDir: where swallowed errors are logged (the hook passes ${CLAUDE_PLUGIN_DATA}); null logs nothing.
export function drift({ home, pluginRoot, dataDir = null }) {
  const config = methodologyConfig(home, dataDir);
  const state = config.keepSuperseded ? null : supersededState(home, pluginRoot, dataDir);
  return driftLines({ home, pluginRoot, dataDir, config, state });
}

const wrapSkill = (skillText) => `<EXTREMELY_IMPORTANT>\nYou have the methodology skills.\n\n**Below is the full content of your 'methodology:using-methodology' skill - your introduction to using skills. For all other skills, use the 'Skill' tool:**\n\n${skillText}\n</EXTREMELY_IMPORTANT>`;

// The wrapped using-methodology skill, or null (logged) when its SKILL.md is missing or unreadable.
function wrappedSkill(pluginRoot, dataDir) {
  try {
    const skillText = readFileSync(join(pluginRoot, 'skills', 'using-methodology', 'SKILL.md'), 'utf8');
    return wrapSkill(skillText.replace(/\n+$/, ''));
  } catch (err) {
    logError(dataDir, err);
    return null;
  }
}

// source: the SessionStart `source` (startup, resume, clear, compact). Every source but resume gets the skill (the
// keepSuperseded note instead when that is set): the resumed conversation already holds it. A resume gets RESUME_NOTE
// instead when the manifest supersedes something, none of it is enabled and keepSuperseded is off: the resumed
// conversation may predate the rollout. harness: a HARNESS_IDS id whose rules target the rules line checks, or null
// for Claude's ~/.claude/CLAUDE.md. Returns null when there is nothing to inject.
export function sessionContext({ home, pluginRoot, dataDir = null, source, harness = null }) {
  const config = methodologyConfig(home, dataDir); // read once for the drift lines and the introduction
  const state = config.keepSuperseded ? null : supersededState(home, pluginRoot, dataDir);
  const lines = driftLines({ home, pluginRoot, dataDir, config, state, harness });
  let skill = null;
  if (source !== 'resume') skill = config.keepSuperseded ? KEEP_NOTE : wrappedSkill(pluginRoot, dataDir);
  else if (state && state.supersedes.length > 0 && state.enabled.length === 0) skill = RESUME_NOTE;
  const parts = [lines, skill].filter((part) => part !== null);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// The hook's `source`, from its stdin JSON; undefined when the input is empty or not JSON.
async function readSource() {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return JSON.parse(input)?.source;
  } catch {
    return undefined;
  }
}

// The `--harness <id>` argument when it names a known harness, else null.
function harnessArg(argv) {
  const i = argv.indexOf('--harness');
  const id = i === -1 ? null : argv[i + 1];
  return HARNESS_IDS.includes(id) ? id : null;
}

async function main() {
  const context = sessionContext({
    home: homedir(),
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    dataDir: process.env.CLAUDE_PLUGIN_DATA || null,
    source: await readSource(),
    harness: harnessArg(process.argv.slice(2)),
  });
  if (context !== null) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (err) {
    logError(process.env.CLAUDE_PLUGIN_DATA || null, err); // the entry point never blocks a session
  }
  process.exitCode = 0;
}
