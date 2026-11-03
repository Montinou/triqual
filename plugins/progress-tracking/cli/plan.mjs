#!/usr/bin/env node
// `triqual plan generate --template <file.md> --data <file.json> --out <dir> [--replace]` (design S7): writes one plan
// file per entry of the data's `plans` (each entry's values over `defaults`) by rendering the template (lib/plan-template.mjs),
// then reads every file as registration does (readTasks, readPhases, validatePlanForRegistration, and every dependency
// naming a task of the plan). One line per plan: `OK <file> tasks <n> phases <m>` or `ERR <file>: <message>`; a plan
// that fails to render is not written, one that fails to read stays written so it can be looked at. Exit codes: 0 all
// OK (and --help/-h), 1 any ERR (an existing file without --replace is one), 2 bad arguments or unreadable inputs.
// Importing this module runs nothing.
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeAtomic } from '../lib/fsx.mjs';
import { readPhases, readTasks, validatePlanForRegistration } from '../lib/plan.mjs';
import { render } from '../lib/plan-template.mjs';

const USAGE = `usage: triqual plan generate --template <file.md> --data <file.json> --out <dir> [--replace]
  Writes <dir>/<file> for each entry of the data's "plans" ({ "defaults": {…}, "plans": [{ "file": "<name>.md", … }] }),
  rendering the template, and checks each as registration reads it: OK <file> tasks <n> phases <m> or ERR <file>: <message>.
  An existing file is an ERR unless --replace. Exit 1 when any plan is an ERR.`;

class UsageError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readInput(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read the ${what} ${path}: ${err.message}`);
  }
}

function readData(path) {
  let data;
  try {
    data = JSON.parse(readInput(path, 'data file'));
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`${path}: ${err.message}`);
  }
  if (!isObject(data)) throw new UsageError(`${path}: the data must be an object`);
  if (data.defaults !== undefined && !isObject(data.defaults)) throw new UsageError(`${path}: "defaults" must be an object`);
  if (!Array.isArray(data.plans) || data.plans.length === 0) throw new UsageError(`${path}: "plans" must be a non-empty array`);
  if (!data.plans.every(isObject)) throw new UsageError(`${path}: every entry of "plans" must be an object`);
  return data;
}

const plainName = (file) => typeof file === 'string' && file.endsWith('.md') && file.length > '.md'.length && basename(file) === file;

// What registration reads of a written plan: its counts, or the first thing it would refuse.
export function check(text, file) {
  const tasks = readTasks(text);
  const phases = readPhases(text, file.replace(/\.md$/, ''));
  validatePlanForRegistration(tasks);
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    const dep = task.deps.find((d) => !ids.has(d));
    if (dep !== undefined) throw new Error(`${task.id} depends on ${dep}, which is not a task of the plan`);
  }
  return `tasks ${tasks.length} phases ${phases.phases.length}`;
}

function generate(opts) {
  const template = readInput(opts.template, 'template');
  const data = readData(opts.data);
  mkdirSync(opts.out, { recursive: true });
  let failed = false;
  const lines = data.plans.map((entry, i) => {
    const label = typeof entry.file === 'string' ? entry.file : `plan #${i + 1}`;
    try {
      if (!plainName(entry.file)) throw new Error('"file" must be a plain file name ending in .md');
      const target = join(opts.out, entry.file);
      if (existsSync(target) && !opts.replace) throw new Error('already exists (use --replace)');
      const text = render(template, { ...data.defaults, ...entry }, opts.template);
      writeAtomic(target, text);
      return `OK ${label} ${check(text, entry.file)}`;
    } catch (err) {
      failed = true;
      return `ERR ${label}: ${err.message}`;
    }
  });
  process.stdout.write(`${lines.join('\n')}\n`);
  return failed ? 1 : 0;
}

export function main(argv) {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const [sub, ...rest] = argv;
    if (sub !== 'generate') throw new UsageError(sub === undefined ? '' : `unknown subcommand "${sub}"`);
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: { template: { type: 'string' }, data: { type: 'string' }, out: { type: 'string' }, replace: { type: 'boolean' } },
        allowPositionals: false,
      });
    } catch (err) {
      throw new UsageError(err.message);
    }
    const { template, data, out, replace } = parsed.values;
    if (!template || !data || !out) throw new UsageError('--template, --data and --out are required');
    return generate({ template, data, out, replace: Boolean(replace) });
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${err.message ? `${err.message}\n` : ''}${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
