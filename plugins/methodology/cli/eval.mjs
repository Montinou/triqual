// `triqual eval <sub> ...`: the dispatcher of the evals commands. `<sub>` (lowercase words joined by single hyphens) runs
// cli/eval-<sub>.mjs's exported main(argv, deps) with the arguments after it; `triqual eval`, `--help`, `-h` and `help`
// list every eval-*.mjs with its exported SUMMARY. A later subcommand needs no edit here: dropping eval-<name>.mjs
// next to this file is enough. Exit codes: the subcommand's; 0 for the list; 2 for an unknown subcommand; 1 when a
// subcommand file cannot be loaded. node: built-ins only. main() is exported for tests and runs only when this file is
// the entry point.
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUB = /^[a-z]+(?:-[a-z]+)*$/;
const FILE = /^eval-([a-z]+(?:-[a-z]+)*)\.mjs$/;

const subcommands = () => readdirSync(HERE).map((f) => FILE.exec(f)?.[1]).filter(Boolean).sort();
const load = (sub) => import(pathToFileURL(join(HERE, `eval-${sub}.mjs`)).href);

async function helpText() {
  const names = subcommands();
  const lines = ['usage: triqual eval <command> [args]', '', 'commands:'];
  const width = Math.max(0, ...names.map((n) => n.length));
  for (const name of names) {
    let summary = '';
    try { summary = (await load(name)).SUMMARY ?? ''; } catch { /* a file that cannot load is listed without a summary */ }
    lines.push(`  ${name.padEnd(width)}  ${summary}`.trimEnd());
  }
  lines.push('', 'Run "triqual eval <command> --help" for one command.', '');
  return lines.join('\n');
}

export async function main(argv, deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = deps;
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    stdout.write(await helpText());
    return 0;
  }
  if (!SUB.test(sub) || !subcommands().includes(sub)) {
    stderr.write(`triqual eval: unknown command ${sub.length > 40 ? `${sub.slice(0, 40)}...` : sub}\n${await helpText()}`);
    return 2;
  }
  let mod;
  try {
    mod = await load(sub);
  } catch (err) {
    stderr.write(`triqual eval ${sub}: could not be loaded: ${err?.code ?? 'error'}\n`);
    return 1;
  }
  return mod.main(rest, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
