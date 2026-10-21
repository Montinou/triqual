// `triqual sync [--yes] [--harness <id>]…` and `triqual sync [--yes] --remove-harness <id> [--restore-agents-md]`. The Claude
// steps write the installed plugin's rules/global.md into the managed section of ~/.claude/CLAUDE.md, after a gate
// that refuses while legacy (pre-split) headings sit outside that section, and disable at user scope every enabled
// plugin the manifest supersedes (`<name>@*` matches any marketplace) unless keepSuperseded is set in
// ~/.config/triqual/config.json (or under the legacy dir until migration).
// With no --harness, the Claude steps run, then the steps of every harness config.json records as enabled
// (lib/harness-sync.mjs); with --harness, only the named harnesses run, with no Claude steps. --remove-harness replays
// that harness's harnesses.json entry in reverse (removeHarness) and sets harnesses.<id>.enabled false in config.json.
// Every step reports done, already, skipped or failed; nothing throws out of sync(), syncHarness() or removeHarness().
// Exit codes: 0 ok (and for --help/-h, which writes nothing), 1 a step failed, 2 an unknown argument or harness id, or
// a bad flag combination (nothing written).
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  backupDirFor, backupFile, outsideManagedSection, upsertManagedSection, writeAtomic,
} from './lib/fsx.mjs';
import {
  configPath, editSettings, readMethodologyConfig, setHarnessEnabled, supersededEnabled,
} from './lib/settings.mjs';
import { HARNESS_IDS } from './lib/harnesses.mjs';
import { removeHarness, syncHarness } from './lib/harness-sync.mjs';
import { realRun } from './lib/run.mjs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Legacy heading lines found outside the managed section: exact, case-sensitive whole lines, trailing whitespace
// ignored. Throws when the managed section is malformed. Doctor reuses it for its unsplit check.
export function legacyHeadingsOutside(text, headings) {
  const wanted = new Set(headings);
  const found = [];
  for (const line of outsideManagedSection(text).split('\n')) {
    const l = line.trimEnd();
    if (wanted.has(l) && !found.includes(l)) found.push(l);
  }
  return found;
}

function rulesSteps({ home, pluginRoot, backupDir }) {
  const claudeMd = join(home, '.claude', 'CLAUDE.md');
  let text;
  let gateDetail;
  try {
    text = readIfExists(claudeMd) ?? '';
    const legacy = legacyHeadingsOutside(text, readJson(join(pluginRoot, 'rules', 'legacy-headings.json')));
    if (legacy.length > 0) {
      gateDetail = `legacy headings outside the managed section, split CLAUDE.md first: ${legacy.join(', ')}`;
    }
  } catch (err) {
    gateDetail = err.message;
  }
  if (gateDetail) {
    return [
      { id: 'rules-gate', status: 'failed', detail: gateDetail },
      { id: 'rules', status: 'failed', detail: `not written: ${gateDetail}` },
    ];
  }
  const gate = { id: 'rules-gate', status: 'done', detail: 'no legacy headings outside the managed section' };
  try {
    const body = readFileSync(join(pluginRoot, 'rules', 'global.md'), 'utf8');
    const { text: next, action } = upsertManagedSection(text, body);
    if (action === 'unchanged') return [gate, { id: 'rules', status: 'already', detail: 'managed section is current' }];
    mkdirSync(dirname(claudeMd), { recursive: true });
    backupFile(claudeMd, backupDir);
    writeAtomic(claudeMd, next);
    return [gate, { id: 'rules', status: 'done', detail: `managed section ${action} in ${claudeMd}` }];
  } catch (err) {
    return [gate, { id: 'rules', status: 'failed', detail: err.message }];
  }
}

function supersedesStep({ home, pluginRoot, backupDir }) {
  try {
    const { supersedes = [] } = readJson(join(pluginRoot, 'rules', 'manifest.json'));
    const settingsPath = join(home, '.claude', 'settings.json');
    const none = { id: 'supersedes', status: 'already', detail: 'no superseded plugin enabled' };
    if (supersedes.length === 0) return none;
    const config = readMethodologyConfig(home);
    // Never act on unknown intent: an existing config.json that cannot be read might set keepSuperseded.
    if (config.error) {
      return { id: 'supersedes', status: 'failed', detail: 'config.json unreadable — fix it or remove it' };
    }
    if (config.keepSuperseded) {
      const detail = `keepSuperseded is set in ${configPath(home)}: superseded plugins left as they are`;
      return { id: 'supersedes', status: 'already', detail };
    }
    if (!existsSync(settingsPath)) return none;
    const disabled = [];
    const { changed } = editSettings(settingsPath, (obj) => {
      for (const id of supersededEnabled(supersedes, obj.enabledPlugins)) {
        obj.enabledPlugins[id] = false;
        disabled.push(id);
      }
    }, { backupDir });
    if (!changed) return none;
    return { id: 'supersedes', status: 'done', detail: `disabled ${disabled.join(', ')}` };
  } catch (err) {
    return { id: 'supersedes', status: 'failed', detail: err.message };
  }
}

export function sync({ home, pluginRoot, now = new Date() }) {
  const backupDir = backupDirFor(home, now);
  const steps = [...rulesSteps({ home, pluginRoot, backupDir }), supersedesStep({ home, pluginRoot, backupDir })];
  return { steps, ok: steps.every((s) => s.status !== 'failed') };
}

// The first line stays `usage: triqual sync`: callers match it.
const USAGE = `usage: triqual sync
       triqual sync [--yes] [--harness <id>]...
       triqual sync [--yes] --remove-harness <id> [--restore-agents-md]
  --harness <id>         sync only this harness (${HARNESS_IDS.join(', ')}), no Claude steps, and record it enabled
                         (so a removed harness comes back); repeatable
  --yes                  answer yes where a step would ask (never the AGENTS.md split or a Grok plugin reinstall)
  --remove-harness <id>  undo what triqual sync did in this harness (harnesses.json) and stop syncing it
  --restore-agents-md    with --remove-harness codex: put back the pre-split ~/.codex/AGENTS.md
  -h, --help             print this help`;

// { help } | { error } | { yes, harnesses, remove, restoreAgentsMd }. Checked before anything is read or written.
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const out = { yes: false, harnesses: [], remove: null, restoreAgentsMd: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes') {
      out.yes = true;
    } else if (arg === '--restore-agents-md') {
      out.restoreAgentsMd = true;
    } else if (arg === '--harness' || arg === '--remove-harness') {
      const id = argv[i + 1];
      if (id === undefined || id.startsWith('-')) return { error: `${arg} needs a harness id` };
      if (!HARNESS_IDS.includes(id)) return { error: `unknown harness ${id}` };
      i += 1;
      if (arg === '--harness') {
        if (!out.harnesses.includes(id)) out.harnesses.push(id);
      } else if (out.remove !== null && out.remove !== id) {
        return { error: '--remove-harness takes one harness' };
      } else {
        out.remove = id;
      }
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  if (out.remove !== null && out.harnesses.length > 0) {
    return { error: '--remove-harness cannot be combined with --harness' };
  }
  if (out.restoreAgentsMd && out.remove === null) {
    return { error: '--restore-agents-md is only valid with --remove-harness' };
  }
  if (out.restoreAgentsMd && out.remove !== 'codex') {
    return { error: '--restore-agents-md is only valid with --remove-harness codex' };
  }
  return out;
}

const lines = (steps) => steps.map((s) => `${s.id}: ${s.status} — ${s.detail}\n`).join('');

// Codex reads its agents and config.toml when a session starts. The rules gate reports `done` on every run (it only
// checks), so it does not count as a change.
const RESTART_CODEX = 'Restart open Codex sessions to load the new agents and settings.';
const changedCodexFile = (steps) => steps.some((s) => s.id.startsWith('codex-') && s.id !== 'codex-enabled'
  && s.id !== 'codex-rules-gate' && s.status === 'done');

// `<id>-enabled`: harnesses.<id>.enabled set false in config.json, so triqual sync no longer syncs the removed harness.
function disableHarnessStep(home, id) {
  const stepId = `${id}-enabled`;
  const path = configPath(home);
  const config = readMethodologyConfig(home);
  if (!config.error && config.harnesses[id]?.enabled === false) {
    return { id: stepId, status: 'already', detail: `harnesses.${id}.enabled is false in ${path}` };
  }
  try {
    setHarnessEnabled(home, id, false);
    const detail = `set harnesses.${id}.enabled = false in ${path}: triqual sync skips ${id}`;
    return { id: stepId, status: 'done', detail };
  } catch (err) {
    return { id: stepId, status: 'failed', detail: err.message };
  }
}

// `<id>-enabled` for an explicit `triqual sync --harness <id>` of an installed harness: harnesses.<id>.enabled set true in
// config.json, since naming the harness is the request to sync it, so one removed with --remove-harness comes back
// (spec F.4). An absent harness is never recorded (see isAbsent).
function enableHarnessStep(home, id) {
  const stepId = `${id}-enabled`;
  const path = configPath(home);
  const config = readMethodologyConfig(home);
  if (!config.error && config.harnesses[id]?.enabled === true) {
    return { id: stepId, status: 'already', detail: `harnesses.${id}.enabled is true in ${path}` };
  }
  try {
    setHarnessEnabled(home, id, true);
    return { id: stepId, status: 'done', detail: `set harnesses.${id}.enabled = true in ${path}: triqual sync syncs ${id}` };
  } catch (err) {
    return { id: stepId, status: 'failed', detail: err.message };
  }
}

// syncHarness's result for a harness `detect` finds absent: its single `<id>: skipped — not installed` step.
const isAbsent = (id, steps) => steps.length === 1 && steps[0].id === id && steps[0].status === 'skipped'
  && steps[0].detail === 'not installed';

// The CLI with its dependencies injected: resolves { code, stdout, stderr }. `pluginRoot` is the plugin whose rules
// the Claude steps write; the harness steps use the user-scope methodology install. `log` takes the lines a step
// prints before it asks (`confirm`), such as the AGENTS.md split preview: the entry writes them straight to the
// terminal, ahead of the collected step lines.
export async function syncCli(argv, {
  home, pluginRoot, run, now = new Date(), isTTY = false, confirm, log = () => {},
}) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (args.error) return { code: 2, stdout: '', stderr: `triqual sync: ${args.error}\n${USAGE}\n` };
  const steps = [];
  const ask = { yes: args.yes, isTTY, confirm, log };
  if (args.remove !== null) {
    const id = args.remove;
    steps.push(...(await removeHarness({ home, id, run, now, restoreAgentsMd: args.restoreAgentsMd, ...ask })).steps);
    steps.push(disableHarnessStep(home, id));
    return { code: steps.some((s) => s.status === 'failed') ? 1 : 0, stdout: lines(steps), stderr: '' };
  }
  let ids = args.harnesses;
  const explicit = ids.length > 0;
  if (!explicit) {
    steps.push(...sync({ home, pluginRoot, now }).steps);
    const { harnesses } = readMethodologyConfig(home);
    ids = HARNESS_IDS.filter((id) => harnesses[id]?.enabled === true);
  }
  for (const id of ids) {
    const done = (await syncHarness({ home, id, run, now, ...ask })).steps;
    // Recorded after the presence check, reported ahead of the harness's steps; an absent harness gets only its skip.
    if (explicit && !isAbsent(id, done)) steps.push(enableHarnessStep(home, id));
    steps.push(...done);
  }
  const restart = changedCodexFile(steps) ? `${RESTART_CODEX}\n` : '';
  return { code: steps.some((s) => s.status === 'failed') ? 1 : 0, stdout: `${lines(steps)}${restart}`, stderr: '' };
}

// A y/N question on the terminal; only yes or y (any case) is yes.
async function ttyConfirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

// The CLI entry: runs `cli` (syncCli) and writes its output; an error thrown out of it prints one `triqual sync: <message>`
// line and exits 1. `io` is injectable for tests.
export function runCli(argv, deps, {
  cli = syncCli, stdout = process.stdout, stderr = process.stderr, exit = (code) => { process.exitCode = code; },
} = {}) {
  return Promise.resolve().then(() => cli(argv, deps)).then(({ code, stdout: out, stderr: err }) => {
    stdout.write(out);
    stderr.write(err);
    exit(code);
  }).catch((error) => {
    stderr.write(`triqual sync: ${error?.message ?? error}\n`);
    exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // No top-level await: harness-sync imports this module back (legacyHeadingsOutside).
  runCli(process.argv.slice(2), {
    home: homedir(),
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    run: realRun,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: ttyConfirm,
    log: (line) => process.stdout.write(`${line}\n`),
  });
}
