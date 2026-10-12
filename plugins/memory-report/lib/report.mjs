// One generator run (spec 6.1): lock, due check, guarded body (context, collectors, insights, render, write), state.
// Only Node 20 safe modules are imported statically; everything that can pull in node:sqlite is imported inside the
// guarded body, so a failed load is recorded as lastError instead of crashing before state is written.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, insightsGate, DEFAULTS } from './config.mjs';
import { appendLog, ensureDir, rotateLog, writeAtomic } from './files.mjs';
import { acquireLock, isDue, readState, releaseLock, writeState } from './state.mjs';
import { CONTROL } from './merges.mjs';
import { contentVerdict, identityUnavailable } from './policy.mjs';
import { renderReport } from './render.mjs';
import { REPO_BUDGET_MS, defaultRun, emptyRepos, resolveRepos } from './repo.mjs';
import { suggestCandidates } from './suggest.mjs';

const MIN_NODE = [22, 16];
const SECTION_ERROR_MAX = 120;
const SUGGESTION_LIMIT = 10;

// Fixed failure strings: the only values lastError and run.log ever carry.
const ERR_NODE = 'Node 22.16 or later required';
const ERR_NO_DB = 'claude-mem.db not found';
const ERR_LOAD = 'memory-report modules could not be loaded';
const ERR_WRITE = 'report could not be written';
const ERR_CONFIG = 'configuration could not be read';
const ERR_GENERIC = 'report generation failed';

// An error whose message is one of the fixed strings above (anything else is replaced by ERR_GENERIC).
class FixedError extends Error {}

const oneLine = (value) => String(value).replace(/\s*[\r\n\t\v\f\u0085\u2028\u2029]+\s*/g, ' ');
const truncate = (text, max) => Array.from(text).slice(0, max).join('');
const isUnavailable = (section) => section !== null && typeof section === 'object' && typeof section.unavailable === 'string';

// ISO-8601 week of the local calendar date: `YYYY-Www`, the year being the ISO week-year.
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7)); // the Thursday of this week decides the year
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---- allowlist suggestions (local-setup spec 2.6) ----------------------------------------------------------------------

// The report lists the first 10 candidates of the last `intervalDays` days whose project name holds no client term
// (setup does not filter, the user decides there; the report does, as it always has), and counts the merge groups
// (repo-identity spec 6: a count only, without commands). With the repository identity unavailable and repository or
// owner never-send entries, the report lists and counts none (Ruling 12). Ruling 15: no `triqual memory allow '<name>'` for a
// name the terminal would not show or paste as written: one holding a merges.mjs CONTROL character, or whose stored
// value holds a NUL (Node 22's node:sqlite reads it cut at the NUL, so the printed name would be another project's; the
// base of every such name as read is refused, as merges.mjs does).
function reportSuggestions(ctx) {
  if (identityUnavailable(ctx.config, ctx.repos)) return { suggestions: [], sameRepository: 0 };
  const { candidates, merges } = suggestCandidates(ctx, { days: ctx.config.intervalDays, commands: null });
  const cut = new Set(ctx.db.prepare(
    `SELECT project AS name FROM observations WHERE instr(project, char(0)) > 0
     UNION SELECT merged_into_project FROM observations WHERE instr(merged_into_project, char(0)) > 0`,
  ).all().map(({ name }) => (typeof name === 'string' ? name.split('/')[0] : name)));
  const suggestions = candidates
    .filter(({ project }) => !CONTROL.test(project) && !cut.has(project))
    .filter(({ project }) => contentVerdict({ project, title: '', narrative: '', facts: '' }, ctx.config) !== 'client')
    .slice(0, SUGGESTION_LIMIT);
  return { suggestions, sameRepository: merges.length };
}

// ---- repository identity (repo-identity spec 2, 4.3) ----------------------------------------------------------------

// The largest delay setTimeout honors: above it Node fires after 1 ms and prints a TimeoutOverflowWarning.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Ruling 8: the resolution budget from MEMORY_REPORT_REPO_BUDGET_MS (or a number), clamped to 1..2^31-1 ms; a value that
// is not numeric (absent, empty, text) gives the 10 s default.
export function repoBudgetMs(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (Number.isNaN(n)) return REPO_BUDGET_MS;
  return Math.min(MAX_TIMER_MS, Math.max(1, n));
}

// Resolves the repositories once per run, inside its own error boundary: a throw (a database without
// sdk_sessions.cwd, an unwritable map) gives the empty resolution marked `error: 'resolve'` and one fixed run.log line;
// runInsights then applies spec 4.3. `deps` ({ run, sshHost, budgetMs, envBase }) are the test seams. `setup --suggest`
// and `triqual memory repos` resolve through this too.
export async function resolveForRun(paths, ctx, env, deps = {}) {
  try {
    return await resolveRepos(ctx, {
      budgetMs: repoBudgetMs(deps.budgetMs ?? env.MEMORY_REPORT_REPO_BUDGET_MS),
      run: deps.run ?? defaultRun({ envBase: deps.envBase ?? env }),
      sshHost: deps.sshHost,
    });
  } catch {
    appendLog(paths, 'repo-resolve-failed');
    return { ...emptyRepos(), error: 'resolve' };
  }
}

// ---- the run -------------------------------------------------------------------------------------------------------

const defaultIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const nodeIsSupported = (version) => {
  const [major, minor] = String(version).split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

// `config-warning <key>`: the key name only, never a value.
const warningKey = (warning) => /^invalid config key: (\S+?);/.exec(warning)?.[1] ?? 'unparsable';

// A section's collector inside its own error boundary: a throw becomes { unavailable: <message, cut> }.
function guardSection(paths, name, fn) {
  try {
    return fn();
  } catch (err) {
    appendLog(paths, 'section-unavailable', name);
    const message = oneLine(typeof err?.message === 'string' && err.message !== '' ? err.message : 'unavailable').trim();
    return { unavailable: truncate(message, SECTION_ERROR_MAX) };
  }
}

// Ruling 9: a duplicate group's title stays only when it passes the content filter as the report prints it.
function filterHygieneTitles(hygiene, config) {
  if (isUnavailable(hygiene)) return hygiene;
  const largest = hygiene.duplicates.largest.map((group) => ({
    ...group,
    title: group.title != null && contentVerdict({ project: group.project, title: group.title, narrative: '', facts: '' }, config) === 'ok'
      ? group.title
      : null,
  }));
  return { ...hygiene, duplicates: { ...hygiene.duplicates, largest } };
}

function buildSummary(week, insights, chroma) {
  const ok = !isUnavailable(insights) && insights.status === 'ok';
  const off = !isUnavailable(insights) && insights.status === 'off';
  return {
    week,
    insights: ok ? 'ok' : off ? 'off' : 'unavailable',
    rules: ok ? insights.rules.length : 0,
    skills: ok ? insights.skills.length : 0,
    stale: ok ? insights.stale.length : 0,
    chroma: isUnavailable(chroma) || chroma.status === 'ATTENTION' ? 'ATTENTION' : 'OK',
  };
}

// The guarded body. Throws FixedError for failures it names; anything else is mapped to ERR_GENERIC by the caller.
async function generate({ paths, env, loaded, now, runner, sourcesOptions, nodeVersion, importer, deps }) {
  if (!nodeIsSupported(nodeVersion)) throw new FixedError(ERR_NODE);
  if (!existsSync(paths.dbFile)) throw new FixedError(ERR_NO_DB);
  if (loaded === null) throw new FixedError(ERR_CONFIG);
  const { config, warnings } = loaded;
  for (const warning of warnings) appendLog(paths, 'config-warning', warningKey(warning));

  let mods;
  try {
    const [sources, hygiene, storage, chroma, insights] = await Promise.all([
      importer('./sources.mjs'),
      importer('./collect/hygiene.mjs'),
      importer('./collect/storage.mjs'),
      importer('./collect/chroma.mjs'),
      importer('./insights.mjs'),
    ]);
    mods = { sources, hygiene, storage, chroma, insights };
  } catch {
    throw new FixedError(ERR_LOAD);
  }

  const ctx = await mods.sources.openSources(paths, config, { now, ...sourcesOptions });
  try {
    const week = isoWeek(new Date(now()));
    // Once, before the collectors: hygiene titles, insights and suggestions all read the same resolution.
    ctx.repos = await resolveForRun(paths, ctx, env, deps);
    ctx.reposRebuilt = ctx.repos.rebuilt === true;
    const hygiene = filterHygieneTitles(guardSection(paths, 'hygiene', () => mods.hygiene.collectHygiene(ctx)), config);
    const storage = guardSection(paths, 'storage', () => mods.storage.collectStorage(ctx));
    const chroma = guardSection(paths, 'chroma', () => mods.chroma.collectChroma(ctx));
    // Fail closed (local-setup spec 2.2): until setup is complete the model is never reached, nothing is selected and no
    // work directory is created. `loaded.invalidKeys` is data from loadConfig, never parsed from warning text.
    const gate = insightsGate(config, loaded.invalidKeys);
    let insights;
    if (!gate.open) {
      insights = { status: 'off', reason: gate.reason };
    } else {
      try {
        insights = await mods.insights.runInsights(ctx, { runner, env });
      } catch {
        // The outbound path: the error text is never shown, only this fixed string.
        appendLog(paths, 'section-unavailable', 'insights');
        insights = { unavailable: 'insights failed' };
      }
    }
    let suggestions;
    let sameRepository = 0;
    try {
      ({ suggestions, sameRepository } = reportSuggestions(ctx));
    } catch {
      appendLog(paths, 'section-unavailable', 'suggestions');
      suggestions = [];
    }
    const summary = buildSummary(week, insights, chroma);
    const text = renderReport({
      week, window: ctx.window, generatedAt: now(), summary, configWarnings: warnings, hygiene, storage, chroma, insights, suggestions,
      sameRepository,
    });
    const reportPath = join(paths.reportsDir, `${week}.md`);
    try {
      ensureDir(paths.reportsDir);
      writeAtomic(reportPath, text);
    } catch {
      throw new FixedError(ERR_WRITE);
    }
    return { week, reportPath, summary };
  } finally {
    mods.sources.closeSources(ctx);
  }
}

// Runs the generator once. Resolves to the exit code: 0 success (or `generate` no longer due), 1 failure, 2 lock held.
// `importer` loads the lib modules relative to this file (injectable so a failed load can be tested); `deps`
// ({ run, sshHost, budgetMs, envBase }) reaches the repository resolution.
export async function runReport({
  paths, env = process.env, mode, now = Date.now, runner, sourcesOptions, nodeVersion = process.versions.node,
  isAlive = defaultIsAlive, importer = (specifier) => import(specifier), deps = {},
}) {
  let locked = false;
  try {
    const lock = acquireLock(paths, { nowMs: now(), isAlive });
    if (!lock.acquired) {
      appendLog(paths, 'lock-held');
      return 2;
    }
    locked = true;

    let loaded = null;
    try {
      loaded = loadConfig(paths);
    } catch { /* the guarded body records it */ }
    if (mode === 'generate') {
      const due = isDue(readState(paths), loaded?.config ?? DEFAULTS, { nowMs: now(), dbExists: existsSync(paths.dbFile), lockFree: true });
      if (!due) return 0;
    }

    writeState(paths, { lastAttemptAt: new Date(now()).toISOString() });
    try {
      rotateLog(paths);
    } catch { /* an unrotated log is only large; the run goes on */ }
    appendLog(paths, 'run-start', mode);
    try {
      const result = await generate({ paths, env, loaded, now, runner, sourcesOptions, nodeVersion, importer, deps: deps ?? {} });
      writeState(paths, {
        lastSuccessAt: new Date(now()).toISOString(),
        lastReportPath: result.reportPath,
        lastSummary: result.summary,
        lastError: undefined,
      });
      appendLog(paths, 'run-ok', result.week);
      return 0;
    } catch (err) {
      const lastError = err instanceof FixedError ? err.message : ERR_GENERIC;
      writeState(paths, { lastError });
      appendLog(paths, 'run-failed', lastError);
      return 1;
    }
  } catch {
    // The state directory itself is unusable: there is nowhere to record the failure.
    return 1;
  } finally {
    if (locked) {
      try { releaseLock(paths); } catch { /* the lock file is already gone or unreadable */ }
    }
  }
}
