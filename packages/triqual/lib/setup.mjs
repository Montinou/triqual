// `triqual setup`: checks its arguments and the prerequisites, adds or updates the triqual marketplace, installs the
// methodology plugin when missing, then runs the bootstrap that plugin ships, which does the rest of the setup.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { installPathOf, LEGACY_MARKETPLACE, MARKETPLACE, newestCacheDir } from './plugins.mjs';

const FLAGS = new Set(['--yes', '--keep-language', '--no-harness']);
const NODE_FLOOR = [22, 13];

export const SETUP_USAGE = `usage: triqual setup [--yes] [--keep-language] [--no-harness]

Sets up triqual on this machine: adds the triqual marketplace to Claude Code, installs the methodology plugin, then
runs its installer (the triqual command, the global rules, Codex and Grok when found).

  --yes            answer yes to every confirmation
  --keep-language  keep the "language" key in ~/.claude/settings.json
  --no-harness     skip the Codex and Grok setup

Needs Node 22.13 or newer, git and the claude CLI.
`;

const LEGACY_MESSAGE = `this machine uses the previous marketplace name (${LEGACY_MARKETPLACE}): run node bin/bootstrap.mjs `
  + 'from a clone of Montinou/triqual, which migrates it\n';

export async function runSetup(args, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout.write(SETUP_USAGE);
    return 0;
  }
  const unknown = args.find((a) => !FLAGS.has(a));
  if (unknown !== undefined) {
    stderr.write(`triqual setup: unknown argument ${unknown}\n${SETUP_USAGE}`);
    return 2;
  }

  const missing = prerequisitesMissing(env);
  if (missing.length > 0) {
    for (const line of missing) stderr.write(`triqual setup: ${line}\n`);
    return 1;
  }

  const claude = (claudeArgs, opts = {}) => {
    const r = spawnSync('claude', claudeArgs, { env, encoding: 'utf8', stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    const code = r.error ? 1 : (r.status ?? 1);
    if (code !== 0) stderr.write(`triqual setup: claude ${claudeArgs.join(' ')} failed (exit ${code})\n`);
    return { code, stdout: r.stdout };
  };

  const listArgs = ['plugin', 'marketplace', 'list', '--json'];
  const list = claude(listArgs, { capture: true });
  if (list.code !== 0) return list.code;
  let names;
  try {
    const markets = JSON.parse(list.stdout);
    if (!Array.isArray(markets)) throw new Error('not an array');
    names = new Set(markets.map((m) => m?.name));
  } catch {
    stderr.write(`triqual setup: claude ${listArgs.join(' ')} printed something that is not a marketplace list\n`);
    return 1;
  }
  if (names.has(LEGACY_MARKETPLACE) && !names.has(MARKETPLACE)) {
    stderr.write(`triqual setup: ${LEGACY_MESSAGE}`);
    return 1;
  }

  const market = names.has(MARKETPLACE)
    ? claude(['plugin', 'marketplace', 'update', MARKETPLACE])
    : claude(['plugin', 'marketplace', 'add', 'Montinou/triqual', '--scope', 'user']);
  if (market.code !== 0) return market.code;

  const home = env.HOME;
  if (installPathOf(home) === null) {
    const install = claude(['plugin', 'install', `methodology@${MARKETPLACE}`, '--scope', 'user']);
    if (install.code !== 0) return install.code;
  }

  const pluginDir = installPathOf(home) ?? newestCacheDir(home);
  if (pluginDir === null) {
    stderr.write('triqual setup: the methodology plugin is not installed after claude plugin install; '
      + 'run claude plugin install methodology@triqual --scope user and look at its output\n');
    return 1;
  }
  const r = spawnSync(process.execPath, [join(pluginDir, 'setup', 'bootstrap.mjs'), ...args], { env, stdio: 'inherit' });
  if (r.error) {
    stderr.write(`triqual setup: cannot run the installer in ${pluginDir}: ${r.error.message}\n`);
    return 1;
  }
  return r.status ?? 1;
}

// The prerequisites that are missing, as one line each: Node below the floor, git or claude not on PATH.
function prerequisitesMissing(env) {
  const missing = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1])) {
    missing.push(`Node ${NODE_FLOOR.join('.')} or newer is needed (this is ${process.versions.node})`);
  }
  for (const [cmd, hint] of [['git', 'install git'], ['claude', 'install Claude Code (npm install -g @anthropic-ai/claude-code)']]) {
    const r = spawnSync(cmd, ['--version'], { env, stdio: 'ignore' });
    if (r.error || r.status !== 0) missing.push(`${cmd} is not on PATH: ${hint}, then run npx triqual setup again`);
  }
  return missing;
}
