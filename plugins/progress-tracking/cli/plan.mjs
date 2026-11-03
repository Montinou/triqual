#!/usr/bin/env node
// `triqual plan generate --template <file.md> --data <file.json> --out <dir> [--replace]` (design S7): writes one plan
// file per entry of the data's `plans` (each entry's values over `defaults`) by rendering the template (lib/plan-template.mjs),
// then reads every file as registration does (readTasks, readPhases, validatePlanForRegistration, and every dependency
// naming a task of the plan). One line per plan: `OK <file> tasks <n> phases <m>` or `ERR <file>: <message>`; a plan
// that fails to render is not written, one that fails to read stays written so it can be looked at. Exit codes: 0 all
// OK (and --help/-h), 1 any ERR (an existing file without --replace is one), 2 bad arguments or unreadable inputs.
// `triqual plan check-collisions <plan.md…> [--diff <node> <head>]` (lib/plan-collisions.mjs): `nodes=<n> incomparable
// pairs=<p> collisions=<c>`, then `COLLISION <a> <b> <paths>` per overlap of two phases that are not ancestor and
// descendant, and with --diff `OUTSIDE <node> <path>` per file the node's commits change beyond its Files (compared as
// `git diff --name-only <base>...<head>` in the cwd's repo, <base> the node's parent branch, else the first of main, master
// that exists). Exit 0 clean, 1 any COLLISION, OUTSIDE, glob or unreadable plan, 2 bad arguments or an unreadable file.
// Importing this module runs nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeAtomic } from '../lib/fsx.mjs';
import { PlanError, readPhases, readTasks, validatePlanForRegistration } from '../lib/plan.mjs';
import { checkCollisions, diffOutside, nodesFromPlans } from '../lib/plan-collisions.mjs';
import { render } from '../lib/plan-template.mjs';

const USAGE = `usage: triqual plan generate --template <file.md> --data <file.json> --out <dir> [--replace]
  Writes <dir>/<file> for each entry of the data's "plans" ({ "defaults": {…}, "plans": [{ "file": "<name>.md", … }] }),
  rendering the template, and checks each as registration reads it: OK <file> tasks <n> phases <m> or ERR <file>: <message>.
  An existing file is an ERR unless --replace. Exit 1 when any plan is an ERR.`;

const COLLISIONS_USAGE = `usage: triqual plan check-collisions <plan.md…> [--diff <node> <head>]
  Compares the Files of the phases that are not ancestor and descendant: nodes=<n> incomparable pairs=<p> collisions=<c>,
  COLLISION <a> <b> <paths>. --diff <node> <head> adds OUTSIDE <node> <path> for each file changed from the node's parent
  branch (else main or master) to <head>, run in the current repository, that the node does not list. Exit 1 on any.`;

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

const gitLines = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);

function changedFiles(node, nodes, head) {
  const parent = nodes.find((n) => n.id === node.parentId);
  let base = parent?.branch ?? node.parentBranch;
  if (!base) {
    base = ['main', 'master'].find((ref) => {
      try {
        gitLines(['rev-parse', '--verify', '--quiet', ref]);
        return true;
      } catch {
        return false;
      }
    });
    if (!base) throw new UsageError('--diff needs the node\'s parent branch, main or master in the current repository');
  }
  try {
    return gitLines(['diff', '--name-only', '--no-renames', `${base}...${head}`]);
  } catch (err) {
    throw new UsageError(`git diff ${base}...${head} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

function checkCollisionsCommand(rest) {
  const args = [...rest];
  let diff = null;
  const at = args.indexOf('--diff');
  if (at !== -1) {
    diff = args.splice(at, 3).slice(1);
    if (diff.length !== 2 || diff.some((a) => a === undefined || a.startsWith('--'))) throw new UsageError('--diff needs <node> and <head>');
  }
  if (args.length === 0 || args.some((a) => a.startsWith('-'))) throw new UsageError(args.length === 0 ? 'give at least one plan file' : `unknown option ${args.find((a) => a.startsWith('-'))}`);
  const plans = args.map((file) => ({ stem: basename(file).replace(/\.md$/, ''), text: readInput(file, 'plan') }));
  const stems = plans.map((p) => p.stem);
  const dup = stems.find((stem, i) => stems.indexOf(stem) !== i);
  if (dup !== undefined) {
    process.stderr.write(`duplicate plan stem "${dup}": plan files need distinct names\n`);
    return 1;
  }
  let nodes;
  let result;
  try {
    nodes = nodesFromPlans(plans);
    result = checkCollisions(nodes);
  } catch (err) {
    if (!(err instanceof PlanError) && !/^globs are not supported/.test(err.message)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  let outside = [];
  if (diff) {
    const node = nodes.find((n) => n.id === diff[0]);
    if (!node) throw new UsageError(`unknown node "${diff[0]}" (nodes: ${nodes.map((n) => n.id).join(', ')})`);
    outside = diffOutside(node, changedFiles(node, nodes, diff[1])).map((p) => `OUTSIDE ${node.id} ${p}`);
  }
  const lines = [
    `nodes=${nodes.length} incomparable pairs=${result.pairs} collisions=${result.collisions.length}`,
    ...result.collisions.map((c) => `COLLISION ${c.a} ${c.b} ${c.shared.join(' ')}`),
    ...outside,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.collisions.length > 0 || outside.length > 0 ? 1 : 0;
}

export function main(argv) {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(`${USAGE}\n${COLLISIONS_USAGE}\n`);
    return 0;
  }
  try {
    const [sub, ...rest] = argv;
    if (sub === 'check-collisions') return checkCollisionsCommand(rest);
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
    process.stderr.write(`${err.message ? `${err.message}\n` : ''}${argv[0] === 'check-collisions' ? COLLISIONS_USAGE : USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
