// `triqual role-eval record --plan <plan file> <json-file>` and `triqual role-eval summary [--since YYYY-MM-DD] [--json]`: the
// command line of the role-eval store (lib/role-eval.mjs; spec 5). `record` validates a record, derives its idempotency
// key and appends it under the store lock; `summary` reports the store per provider. A record of a retired kind
// (safety-shadow) is refused; the lines of that kind already stored are still summarized.
// Exit codes: 0 written, already recorded, or a summary (also of an empty or missing store); 2 usage, a retired kind,
// a schema error, a bad JSON file or no git repository (the message names a field, never a value); 1 a write or lock
// failure.
// node: built-ins only. main() is exported for tests and runs only when this file is the entry point.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RETIRED_KINDS, appendRecord, formatSummary, recordKey, storePath, summarize, validateRecord,
} from './lib/role-eval.mjs';

const GIT_TIMEOUT_MS = 10000;
const SINCE = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = [
  'usage:',
  '  triqual role-eval record --plan <plan file> <json-file>',
  '      Validate the hunters record in <json-file> and append it to the store once (the key comes from the repo, the',
  '      plan\'s file name, the task and the kind). The safety-shadow kind is retired: record refuses it. Exits 0 when',
  '      written or already recorded, 2 on a bad or retired record or usage, 1 on a write or lock failure.',
  '  triqual role-eval summary [--since YYYY-MM-DD] [--json]',
  '      Per provider: hunter right and new rates, and the safety-shadow agreement of the records stored before that',
  '      kind was retired, from the records at or after --since.',
  '  triqual role-eval --help',
  '',
].join('\n');

// A YYYY-MM-DD that is a real calendar day (2026-02-30 is not).
function realDay(text) {
  if (!SINCE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

// { flags: { name: value }, bools: Set, positional: [] } or { error }. `valued` and `boolean` list the flags the
// command accepts; `--flag=value` works for the valued ones.
function parseArgs(args, { valued, boolean }) {
  const flags = {};
  const bools = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(arg);
    const name = eq ? eq[1] : arg;
    if (valued.includes(name)) {
      const value = eq ? eq[2] : args[++i];
      if (value === undefined) return { error: `${name} needs a value` };
      flags[name] = value;
    } else if (boolean.includes(name) && !eq) {
      bools.add(name);
    } else if (arg.startsWith('-')) {
      return { error: `unknown argument ${arg.length > 40 ? `${arg.slice(0, 40)}...` : arg}` };
    } else {
      positional.push(arg);
    }
  }
  return { flags, bools, positional };
}

// The realpath of the git common dir of `cwd`, or null outside a repository.
function gitCommonDir(cwd, env) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS,
    }).trim();
    return out === '' ? null : realpathSync(out);
  } catch {
    return null;
  }
}

const errorCode = (err) => (typeof err?.code === 'string' ? err.code : 'error');

function record(args, { env, cwd, stdout, stderr }) {
  const usage = (message) => { stderr.write(`triqual role-eval: ${message}\n${USAGE}`); return 2; };
  const parsed = parseArgs(args, { valued: ['--plan'], boolean: [] });
  if (parsed.error) return usage(parsed.error);
  const plan = parsed.flags['--plan'];
  if (plan === undefined || plan === '') return usage('record needs --plan <plan file>');
  if (parsed.positional.length === 0) return usage('record needs a <json-file>');
  if (parsed.positional.length > 1) return usage('record takes one <json-file>');

  // The file's content is never echoed: JSON.parse messages quote it.
  let obj;
  try {
    obj = JSON.parse(readFileSync(resolve(cwd, parsed.positional[0]), 'utf8'));
  } catch (err) {
    stderr.write(`triqual role-eval: cannot ${err instanceof SyntaxError ? 'parse' : 'read'} the record file as JSON\n`);
    return 2;
  }
  // A fixed kind name, never a value from the file.
  const retired = RETIRED_KINDS.find((kind) => obj !== null && typeof obj === 'object' && obj.kind === kind);
  if (retired !== undefined) {
    stderr.write(`triqual role-eval: the ${retired} kind is retired: record only hunters records\n`);
    return 2;
  }
  const verdict = validateRecord(obj);
  if (!verdict.ok) {
    stderr.write(`triqual role-eval: invalid record: field ${verdict.field}\n`);
    return 2;
  }
  const commonDir = gitCommonDir(cwd, env);
  if (commonDir === null) {
    stderr.write('triqual role-eval: record must run inside a git repository\n');
    return 2;
  }

  const store = storePath(env, env.HOME || homedir());
  const key = recordKey({ commonDir, plan, task: obj.task, kind: obj.kind });
  try {
    const made = mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    const result = appendRecord(store.file, obj, { key, isDefault: store.isDefault, created: made !== undefined });
    stdout.write(result === 'written' ? 'recorded\n' : 'already recorded\n');
    return 0;
  } catch (err) {
    stderr.write(`triqual role-eval: cannot write the store (${errorCode(err)})\n`);
    return 1;
  }
}

function summary(args, { env, stdout, stderr }) {
  const usage = (message) => { stderr.write(`triqual role-eval: ${message}\n${USAGE}`); return 2; };
  const parsed = parseArgs(args, { valued: ['--since'], boolean: ['--json'] });
  if (parsed.error) return usage(parsed.error);
  if (parsed.positional.length > 0) return usage('summary takes no argument');
  const since = parsed.flags['--since'];
  if (since !== undefined && !realDay(since)) return usage('--since needs a calendar date, YYYY-MM-DD');

  let text = '';
  try {
    text = readFileSync(storePath(env, env.HOME || homedir()).file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      stderr.write(`triqual role-eval: cannot read the store (${errorCode(err)})\n`);
      return 1;
    }
  }
  const result = summarize(text, { since });
  stdout.write(parsed.bools.has('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatSummary(result));
  return 0;
}

// Runs one command and returns its exit code. `argv` excludes node and the script; every dependency is injected so a
// test never touches the real environment, streams or working directory.
export function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (command === 'record') return record(rest, { env, cwd, stdout, stderr });
  if (command === 'summary') return summary(rest, { env, stdout, stderr });
  stderr.write(`triqual role-eval: ${command === undefined ? 'missing command' : `unknown command ${command.length > 40 ? `${command.slice(0, 40)}...` : command}`}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
