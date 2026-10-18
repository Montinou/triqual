// `triqual suggest "<text>" [--json]`: vault skills that fit a request, found by headjack (an external plugin, installed
// separately; it owns skill finding, this only calls it). It runs `headjack suggest "<text>"` and never passes
// --session-id: the session dedupe would hide a skill from every task after the first.
// Text mode prints headjack's own <headjack-suggestions …> block unchanged (headjack already cleans the descriptions,
// filters the slugs and pins HEADJACK_MODE / HEADJACK_URL in its install command) and drops the one
// `no suggestions (<outcome>)` line it prints when there is none, so "no suggestion" is empty output. --json runs
// `headjack suggest "<text>" --json` and drops every suggestion whose slug is not a valid slug. Empty output with exit 0
// (headjack's skipped:no-vault) is "no suggestion" in both modes.
// Exit codes: 0 headjack ran (the output may be empty); 3 headjack is not installed; 1 headjack exited non-zero, did not
// answer in time, or --json printed output that is not valid JSON; 2 usage. Callers (the skills) treat any non-zero exit
// or empty output as "no suggestion", silently.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEADJACK = 'headjack';
const HEADJACK_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// headjack's own slug rule (lib/handlers.mjs SLUG_RE): what may reach a command line or a plan.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
// The one line `headjack suggest` prints for no suggestion, and nothing else.
const NO_SUGGESTIONS = /^no suggestions \([^()\n]*\)$/;
// An argument that is a flag (no space in it); `-rf fix the build` is text.
const FLAG = /^--?[A-Za-z][\w-]*$/;

const USAGE = [
  'usage: triqual suggest "<text>" [--json]',
  '  Vault skills that fit <text>, found by headjack (https://github.com/Montinou/headjack, installed separately).',
  '  Text: headjack\'s <headjack-suggestions> block, or nothing. --json: headjack\'s JSON with only valid slugs in',
  '  suggestions[]. Exits 0 when headjack ran (empty output: no suggestion), 3 when headjack is not installed,',
  '  1 when headjack failed or its --json output is not valid JSON, 2 on a usage error.',
  '',
].join('\n');

// A file the caller may run: a regular file (a symlink is followed) with an execute bit for this process.
function runnable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The headjack launcher: ~/.local/bin/headjack, then the first `headjack` on PATH; null when there is none.
export function findHeadjack(env = process.env, home = homedir()) {
  const candidates = [join(home, '.local', 'bin', HEADJACK)];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir !== '') candidates.push(join(dir, HEADJACK));
  }
  return candidates.find(runnable) ?? null;
}

// { json, text } or { error }. A word that is not a flag is part of the text, as are all words after `--`.
function parse(args) {
  let json = false;
  let help = false;
  const words = [];
  let literal = false;
  for (const arg of args) {
    if (literal) words.push(arg);
    else if (arg === '--') literal = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (FLAG.test(arg)) return { error: `unknown option ${arg}` };
    else words.push(arg);
  }
  if (help) return { help: true };
  const text = words.join(' ').trim();
  if (text === '') return { error: 'missing text' };
  return { json, text };
}

// The argv of the headjack call: `suggest "<text>" [--json]`, with `--` before a text that starts with a dash.
function headjackArgs(text, json) {
  if (text.startsWith('-')) return ['suggest', ...(json ? ['--json'] : []), '--', text];
  return ['suggest', text, ...(json ? ['--json'] : [])];
}

// --json output: the document, without the suggestions whose slug is not valid; null when it is not valid JSON.
function filterJson(output) {
  let doc;
  try {
    doc = JSON.parse(output);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.suggestions)) return output;
  const kept = doc.suggestions.filter((s) => typeof s?.slug === 'string' && SLUG.test(s.slug));
  if (kept.length === doc.suggestions.length) return output;
  return `${JSON.stringify({ ...doc, suggestions: kept }, null, 2)}\n`;
}

// Runs one call and returns its exit code. `argv` excludes node and the script; every dependency is injected so a test
// never touches the real environment, home or streams.
export function main(argv, {
  env = process.env, home = homedir(), stdout = process.stdout, stderr = process.stderr, timeoutMs = HEADJACK_TIMEOUT_MS,
} = {}) {
  const parsed = parse(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`triqual suggest: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const launcher = findHeadjack(env, home);
  if (launcher === null) {
    stderr.write(`triqual suggest: headjack is not installed (looked for ${join(home, '.local', 'bin', HEADJACK)} and on PATH); `
      + 'install it with `claude plugin install headjack@triqual`\n');
    return 3;
  }
  const r = spawnSync(launcher, headjackArgs(parsed.text, parsed.json), {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (r.error) {
    stderr.write(r.error.code === 'ETIMEDOUT'
      ? `triqual suggest: headjack did not answer within ${timeoutMs} ms\n`
      : `triqual suggest: could not run headjack: ${r.error.message}\n`);
    return 1;
  }
  if (r.status !== 0) {
    stderr.write(`triqual suggest: headjack exited ${r.status ?? `on ${r.signal}`}\n${r.stderr}`);
    return 1;
  }
  const output = r.stdout;
  if (output.trim() === '') return 0;
  if (parsed.json) {
    const filtered = filterJson(output);
    if (filtered === null) {
      stderr.write('triqual suggest: headjack --json printed output that is not valid JSON\n');
      return 1;
    }
    stdout.write(filtered);
    return 0;
  }
  if (!NO_SUGGESTIONS.test(output.trim())) stdout.write(output);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
