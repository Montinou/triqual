// `triqual eval variant --role <R> --out <dir> [--model <m>] [--effort <e>] [--prompt <file>]`: copies <cwd>/plugins/roles to
// <dir> (run it from the repository root) and changes only agents/<R>.md there: the `model:` and `effort:` lines of its front
// matter (the lines between the first two `---` lines) and, with --prompt, everything after the closing `---` line, replaced by
// the file's bytes, nothing re-parsed. Everything else stays byte for byte, line endings included. It prints the absolute <dir>
// and exits 0. Exit 2, with nothing written, on a usage error or a refusal. The variant is what `claude plugin eval` is pointed
// at as one arm of a role experiment. node: built-ins only. main() is exported for tests and runs only when this file is the
// entry point.
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUMMARY = 'copy the roles plugin with one agent changed (variant)';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const ROLE = /^[a-z][a-z-]*$/;
const FLAGS = ['role', 'out', 'model', 'effort', 'prompt'];

const USAGE = [
  'usage:',
  '  triqual eval variant --role <R> --out <dir> [--model <m>] [--effort <e>] [--prompt <file>]',
  '      Run from the repository root. Copies plugins/roles to <dir> and changes only agents/<R>.md: its `model:` and',
  '      `effort:` front matter lines (--effort is one of low, medium, high, xhigh, max) and, with --prompt, everything after',
  '      the closing `---` line, replaced by the file. Prints the absolute <dir>. Exit 0, or 2 with nothing written.',
  '  triqual eval variant --help',
  '',
].join('\n');

const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m || !FLAGS.includes(m[1])) return { error: `unknown argument ${clip(argv[i])}` };
    const value = m[2] ?? argv[++i];
    if (value === undefined) return { error: `--${m[1]} needs a value` };
    opts[m[1]] = value;
  }
  return { opts };
}

// Lines with their terminators, so a rewrite keeps the line endings as they are.
const toLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const content = (line) => line.replace(/\r?\n$/, '');
const ending = (line) => /\r?\n$/.exec(line)?.[0] ?? '';

// The agent text with its `model:` and `effort:` lines changed and, when `prompt` is a string, its body replaced. Strings are
// latin1 so every byte of the files comes back unchanged. Returns { text } or { error }.
function rewrite(text, { model, effort, prompt }) {
  const lines = toLines(text);
  const marks = [];
  lines.forEach((l, i) => { if (marks.length < 2 && content(l) === '---') marks.push(i); });
  if (marks.length < 2) return { error: 'the agent file has no front matter block' };
  const [open, close] = marks;
  for (const [key, value] of [['model', model], ['effort', effort]]) {
    if (value === undefined) continue;
    const at = lines.findIndex((l, i) => i > open && i < close && new RegExp(`^${key}:(?:\\s|$)`).test(l));
    if (at < 0) return { error: `the agent file has no ${key}: line` };
    lines[at] = `${key}: ${Buffer.from(value, 'utf8').toString('latin1')}${ending(lines[at])}`;
  }
  const head = lines.slice(0, close + 1).join('');
  return { text: prompt === undefined ? head + lines.slice(close + 1).join('') : head + prompt };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const refuse = (m) => { stderr.write(`triqual eval variant: ${m}\n`); return 2; };
  if (argv.includes('--help') || argv.includes('-h')) { stdout.write(USAGE); return 0; }
  const { opts, error } = parseArgs(argv);
  if (error) { stderr.write(`triqual eval variant: ${error}\n${USAGE}`); return 2; }
  const { role, out, model, effort, prompt } = opts;
  if (role === undefined) return refuse('--role is needed');
  if (out === undefined) return refuse('--out is needed');
  if (!ROLE.test(role)) return refuse(`--role ${clip(role)} is not a role name`);
  if (effort !== undefined && !EFFORTS.includes(effort)) return refuse(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (model !== undefined && (model === '' || /\s/.test(model))) return refuse('--model must not be empty or hold whitespace');
  if (model === undefined && effort === undefined && prompt === undefined) return refuse('one of --model, --effort or --prompt is needed');

  const src = resolve(cwd, 'plugins', 'roles');
  const dest = resolve(cwd, out);
  const agentFile = join(src, 'agents', `${role}.md`);
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  if (!existsSync(src) || !statSync(src).isDirectory()) return refuse('no plugins/roles under the current directory');
  if (!isFile(agentFile)) return refuse(`plugins/roles/agents/${role}.md does not exist`);
  const inside = relative(src, dest);
  if (inside === '' || !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))) return refuse('--out is inside plugins/roles');
  if (existsSync(dest)) return refuse(`${clip(out)} already exists`);

  let body;
  if (prompt !== undefined) {
    try { body = readFileSync(resolve(cwd, prompt)).toString('latin1'); } catch { return refuse(`--prompt ${clip(prompt)} cannot be read`); }
  }
  const next = rewrite(readFileSync(agentFile).toString('latin1'), { model, effort, prompt: body });
  if (next.error) return refuse(next.error);

  try {
    cpSync(src, dest, { recursive: true });
    writeFileSync(join(dest, 'agents', `${role}.md`), Buffer.from(next.text, 'latin1'));
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    return refuse(`could not write the variant: ${err?.code ?? 'error'}`);
  }
  stdout.write(`${dest}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
