// `triqual eval sessions [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <text>] [--json]`: refreshes
// <evals>/sessions.jsonl from the main Claude Code transcripts of this machine (see lib/eval-store.mjs) and lists the
// sessions with a turn in the window, with their cost. Read-only on the transcripts; it prints counts, session ids,
// model names and project directory names, never message content. Exit codes: 0 a listing, 1 the store could not be
// updated, 2 usage. node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evalsDir, transcriptsRoot } from './lib/eval-paths.mjs';
import { inWindow, refreshSessions } from './lib/eval-store.mjs';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'prices.json'), 'utf8')).models;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The line `triqual eval` lists this subcommand under.
export const SUMMARY = 'refresh the sessions store from the transcripts and list sessions with their cost';

const USAGE = [
  'usage:',
  '  triqual eval sessions [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <text>] [--json]',
  '      Refreshes the sessions store (<evals>/sessions.jsonl; the evals directory is TRIQUAL_EVALS_DIR, else',
  '      ~/.local/share/triqual/evals) from the main session transcripts in ~/.claude/projects (or',
  '      TRIQUAL_TRANSCRIPTS_DIR), then lists the sessions that have a turn between --since and --until (UTC days, both',
  '      included) in the project directories whose name contains --project (default: all). With a window, a session\'s',
  '      usd and turns count only the turns in it. The total equals `triqual cost`\'s controller total for the same',
  '      window, less the -claude-mem* projects (left out here), when no message is repeated across transcripts (a',
  '      resumed session that copies history is counted once by cost, once per transcript here). The USD is an',
  '      ESTIMATE at the list prices in cli/lib/prices.json; a model not listed there is named and left out of the',
  '      USD. Subagent transcripts are not',
  '      sessions. Prints counts, ids, model and project directory names, never message content.',
  '  triqual eval sessions --help',
  '',
].join('\n');

// A real calendar date (an out-of-range month makes an invalid Date, whose toISOString throws).
const realDay = (t) => {
  if (!DAY.test(t)) return false;
  const d = new Date(`${t}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
};

const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '?');

function format({ since, until, sessions, totalUsd, unpriced }) {
  const out = [`Window: ${since ?? 'start'} .. ${until ?? 'now'} (UTC days), ${sessions.length} session(s)`, ''];
  if (sessions.length === 0) out.push('  (none)');
  for (const s of sessions) {
    out.push(`  ${s.sessionId}  ${s.projectDir ?? '?'}  ${day(s.start)} .. ${day(s.end)}  ${s.turns} turns, ~$${s.usd.toFixed(2)}`);
  }
  out.push('', `Total: ~$${totalUsd.toFixed(2)}, an estimate at list prices (cli/lib/prices.json)`
    + `${unpriced.length > 0 ? `; models with no price are left out of it: ${unpriced.join(', ')}` : ''}.`);
  return `${out.join('\n')}\n`;
}

// Runs the command and returns its exit code; every dependency is injected so a test never reads the real home.
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, now = new Date() } = {}) {
  const usage = (m) => { stderr.write(`triqual eval sessions: ${m}\n${USAGE}`); return 2; };
  const opts = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { stdout.write(USAGE); return 0; }
    if (arg === '--json') { json = true; continue; }
    const m = /^--(since|until|project)(?:=(.*))?$/s.exec(arg);
    if (!m) return usage(`unknown argument ${arg.length > 40 ? `${arg.slice(0, 40)}...` : arg}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined || value === '' || (m[2] === undefined && value.startsWith('--'))) return usage(`--${m[1]} needs a value`);
    if (m[1] !== 'project' && !realDay(value)) return usage(`--${m[1]} needs a calendar date, YYYY-MM-DD`);
    opts[m[1]] = value;
  }
  if (opts.since && opts.until && opts.since > opts.until) return usage(`--since ${opts.since} is after --until ${opts.until}`);
  const home = env.HOME || homedir();
  let refreshed;
  try {
    refreshed = refreshSessions({ root: transcriptsRoot(env, home), file: join(evalsDir(env, home), 'sessions.jsonl'), prices: PRICES, now });
  } catch (err) {
    stderr.write(`triqual eval sessions: the sessions store could not be updated: ${err?.code ?? err?.message ?? 'error'}\n`);
    return 1;
  }
  const windowed = Boolean(opts.since || opts.until);
  const sessions = [];
  for (const stored of refreshed.sessions) {
    if (opts.project && !(stored.projectDir ?? '').includes(opts.project)) continue;
    const s = windowed ? inWindow(stored, opts) : stored;
    if (s !== null) sessions.push(s);
  }
  sessions.sort((a, b) => (a.start ?? '￿').localeCompare(b.start ?? '￿') || a.sessionId.localeCompare(b.sessionId));
  const totalUsd = sessions.reduce((a, s) => a + s.usd, 0);
  const unpriced = [...new Set(sessions.flatMap((s) => s.unpriced))].sort();
  const result = { since: opts.since ?? null, until: opts.until ?? null, sessions, totalUsd, unpriced, skipped: refreshed.skipped };
  if (refreshed.skipped > 0) stderr.write(`${refreshed.skipped} lines of the sessions store skipped\n`);
  stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : format(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
