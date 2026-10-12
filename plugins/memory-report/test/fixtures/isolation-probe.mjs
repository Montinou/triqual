#!/usr/bin/env node
// Isolation probe (spec 10, live check 1): a hard gate before any real note is sent to the child `claude`.
//
// Default mode calls the production runner (buildArgv, buildChildEnv, runClaude) with a tiny prompt in the work
// directory, validates the envelope, waits 120 s and then looks in claude-mem's database (read-only) for sessions the
// child may have created. `--check-only --since <ms>` only repeats that database check.
// The positive control needs PROBE_CONTROL_CWD (this repository's path).
//
// Prints one JSON object with counts, names and ids only (never note text) and exits 0 only when `passed`.
import { DatabaseSync } from 'node:sqlite';
import { resolvePaths, loadConfig } from '../../lib/config.mjs';
import { ensureDir } from '../../lib/files.mjs';
import {
  REMOVED_ENV_NAMES, REMOVED_ENV_PREFIXES, buildArgv, buildChildEnv, parseEnvelope, runClaude, validateResult,
} from '../../lib/insights.mjs';
import { capturedSessions } from '../../lib/probe.mjs';

const WORK_PROJECT = 'memory-report-work';
const CONTROL_PROJECT = 'triqual';
const PROMPT = 'Return {"rules":[],"skills":[],"stale":[]} exactly.';
const CHILD_TIMEOUT_MS = 120000;
const SETTLE_MS = 120000;

const paths = resolvePaths(process.env);
const args = process.argv.slice(2);

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const openDb = () => new DatabaseSync(paths.dbFile, { readOnly: true });

if (args.includes('--check-only')) {
  const since = Number(args[args.indexOf('--since') + 1]);
  if (!Number.isFinite(since)) {
    process.stderr.write('usage: isolation-probe.mjs --check-only --since <ms>\n');
    process.exit(2);
  }
  const db = openDb();
  try {
    print({ captured: capturedSessions(db, { cwd: paths.workDir, project: WORK_PROJECT, sinceMs: since }) });
  } finally {
    db.close();
  }
  process.exit(0);
}

const controlCwd = process.env.PROBE_CONTROL_CWD;
if (!controlCwd) {
  process.stderr.write('PROBE_CONTROL_CWD is required: set it to this repository\'s path\n');
  process.exit(2);
}

const startedAt = Date.now();
ensureDir(paths.workDir);
const { config } = loadConfig(paths);
const run = await runClaude({
  bin: config.claudeBin,
  argv: buildArgv(config),
  env: buildChildEnv(process.env),
  cwd: paths.workDir,
  input: PROMPT,
  timeoutMs: CHILD_TIMEOUT_MS,
});

const parsed = run.code === 0 && !run.timedOut && !run.spawnError ? parseEnvelope(run.stdout) : { ok: false, reason: 'child did not finish cleanly' };
const validatorError = parsed.ok ? validateResult(parsed.data) : 'no envelope';
const envelopeOk = parsed.ok;
const removedVarsPresent = run.envKeys.filter(
  (key) => REMOVED_ENV_NAMES.includes(key) || REMOVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
);

await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const db = openDb();
let captured;
let positiveControl;
try {
  captured = capturedSessions(db, { cwd: paths.workDir, project: WORK_PROJECT, sinceMs: startedAt });
  positiveControl = capturedSessions(db, { cwd: controlCwd, project: CONTROL_PROJECT, sinceMs: 0 }).length;
} finally {
  db.close();
}

const passed = envelopeOk && validatorError === null && removedVarsPresent.length === 0 && captured.length === 0 && positiveControl >= 1;
print({
  envelopeOk,
  validatorError,
  removedVarsPresent,
  captured,
  positiveControl,
  passed,
  startedAt,
  runner: { code: run.code, timedOut: run.timedOut, spawnError: run.spawnError },
  envelopeReason: parsed.ok ? null : parsed.reason,
});
process.exit(passed ? 0 : 1);
