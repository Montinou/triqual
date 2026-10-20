import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, chmodSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, DESCRIPTIONS, HELP_BUDGET_MS, resolveInstallPath, resolveCommand, helpText } from '../plugins/methodology/setup/triqual-shim.mjs';
import { BRAND } from '../plugins/methodology/cli/lib/brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = join(ROOT, 'plugins', 'methodology', 'setup', 'triqual-shim.mjs');

// Shaped like the real agent-sdk-dev@claude-plugins-official record: one user entry and one local entry whose
// projectPath contains a space.
const PROJECT = join(tmpdir(), 'acme projects', 'Acme Tools');
const twoEntries = (id = `methodology@${BRAND.legacy.marketplace}`) => ({
  version: 2,
  plugins: {
    [id]: [
      { scope: 'user', installPath: '/cache/user/1.0.0', version: '1.0.0' },
      { scope: 'local', projectPath: PROJECT, installPath: '/cache/local/1.1.0', version: '1.1.0' },
    ],
  },
});

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// A temp HOME whose installed_plugins.json lists the given plugins, each at user scope with its own installPath.
function fixtureHome(plugins) {
  const home = tempDir('triqual-home-');
  const record = { version: 2, plugins: {} };
  for (const [name, files] of Object.entries(plugins)) {
    const installPath = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, name, '0.1.0');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(installPath, rel)), { recursive: true });
      writeFileSync(join(installPath, rel), body);
    }
    mkdirSync(installPath, { recursive: true });
    record.plugins[`${name}@${BRAND.legacy.marketplace}`] = [{ scope: 'user', installPath, version: '0.1.0' }];
  }
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(record));
  return home;
}

// A temp HOME and no XDG_CONFIG_HOME: `triqual progress-init` writes the repo registry under HOME.
const shimEnv = (home) => {
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  return env;
};
const runShim = (shim, args, { home, cwd }) =>
  spawnSync(process.execPath, [shim, ...args], { cwd, env: shimEnv(home), encoding: 'utf8' });

// A synthetic command no release ships (`future`, in the plugin `future-plugin`) for the cases about a command that does
// not resolve: a copy of the shim, which is built to be copied alone, with the command added to its own COMMANDS and
// DESCRIPTIONS. { file, mod } is the copy's path (for runShim) and its imported module.
const FUTURE = 'future';
const FUTURE_PLUGIN = 'future-plugin';
async function withFuture(fn) {
  const dir = tempDir('triqual-future-shim-');
  try {
    const file = join(dir, 'triqual.mjs');
    const source = readFileSync(SHIM, 'utf8')
      .replace('export const COMMANDS = {\n', `export const COMMANDS = {\n  ${FUTURE}: ['${FUTURE_PLUGIN}', 'cli/${FUTURE}.mjs'],\n`)
      .replace('export const DESCRIPTIONS = {\n', `export const DESCRIPTIONS = {\n  ${FUTURE}: 'a command that no release ships',\n`);
    assert.ok(source.includes(`${FUTURE}: ['${FUTURE_PLUGIN}'`) && source.includes(`${FUTURE}: 'a command that`), 'the synthetic command was not added');
    writeFileSync(file, source);
    return await fn({ file, mod: await import(pathToFileURL(file).href) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('COMMANDS maps every triqual command to its plugin and cli file', () => {
  assert.deepEqual(COMMANDS, {
    tasks: ['progress-tracking', 'cli/tasks.mjs'],
    'progress-init': ['progress-tracking', 'cli/progress-init.mjs'],
    suggest: ['methodology', 'cli/suggest.mjs'],
    doctor: ['methodology', 'cli/doctor.mjs'],
    sync: ['methodology', 'cli/sync.mjs'],
    ui: ['progress-tracking', 'cli/ui.mjs'],
    tracking: ['progress-tracking', 'cli/tracking.mjs'],
    hook: ['methodology', 'cli/hook.mjs'],
    memory: ['memory-report', 'cli/memory.mjs'],
    'role-eval': ['methodology', 'cli/role-eval.mjs'],
    migrate: ['methodology', 'cli/migrate.mjs'],
    cost: ['methodology', 'cli/cost.mjs'],
  });
});

test('resolveCommand runs cli/ and falls back to bin/ for a plugin installed before the move', () => {
  const home = fixtureHome({
    'progress-tracking': { 'cli/tasks.mjs': '// new layout\n' },
    methodology: { 'bin/doctor.mjs': '// old layout\n' },
  });
  try {
    const tasks = resolveCommand({ home, cwd: home, cmd: 'tasks' });
    assert.ok(tasks.file?.endsWith(join('progress-tracking', '0.1.0', 'cli', 'tasks.mjs')), JSON.stringify(tasks));
    const doctor = resolveCommand({ home, cwd: home, cmd: 'doctor' });
    assert.ok(doctor.file?.endsWith(join('methodology', '0.1.0', 'bin', 'doctor.mjs')), JSON.stringify(doctor));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('line 2 of setup/triqual-shim.mjs is BRAND.ownership.shim', () => {
  assert.equal(readFileSync(SHIM, 'utf8').split('\n')[1], BRAND.ownership.shim);
});

test('COMMANDS includes ui', () => {
  assert.deepEqual(COMMANDS.ui, ['progress-tracking', 'cli/ui.mjs']);
});

test('resolveInstallPath prefers a local entry for the cwd', () => {
  const id = `methodology@${BRAND.legacy.marketplace}`;
  assert.equal(resolveInstallPath(twoEntries(id), id, PROJECT), '/cache/local/1.1.0');
  assert.equal(resolveInstallPath(twoEntries(id), id, join(PROJECT, 'src', 'deep')), '/cache/local/1.1.0');
});

test('resolveInstallPath falls back to user outside the projectPath', () => {
  const id = `methodology@${BRAND.legacy.marketplace}`;
  assert.equal(resolveInstallPath(twoEntries(id), id, join(tmpdir(), 'elsewhere')), '/cache/user/1.0.0');
});

test('resolveInstallPath does not treat a sibling with a longer name as inside the projectPath', () => {
  const id = `methodology@${BRAND.legacy.marketplace}`;
  assert.equal(resolveInstallPath(twoEntries(id), id, `${PROJECT}2`), '/cache/user/1.0.0');
  assert.equal(resolveInstallPath(twoEntries(id), id, `${PROJECT}2/src`), '/cache/user/1.0.0');
});

test('resolveInstallPath ranks local over project over user', () => {
  const id = `methodology@${BRAND.legacy.marketplace}`;
  const installed = {
    version: 2,
    plugins: {
      [id]: [
        { scope: 'user', installPath: '/u' },
        { scope: 'project', projectPath: '/a/b', installPath: '/p' },
        { scope: 'local', projectPath: '/a/b/c', installPath: '/l' },
      ],
    },
  };
  assert.equal(resolveInstallPath(installed, id, '/a/b/c/d'), '/l');
  assert.equal(resolveInstallPath(installed, id, '/a/b/x'), '/p');
  assert.equal(resolveInstallPath(installed, id, '/a/z'), '/u');
});

test('resolveInstallPath returns null for a local-only install of another project', () => {
  const id = `methodology@${BRAND.legacy.marketplace}`;
  const installed = { version: 2, plugins: { [id]: [twoEntries(id).plugins[id][1]] } };
  assert.equal(resolveInstallPath(installed, id, join(tmpdir(), 'acme-other-project')), null);
});

test('resolveInstallPath returns null for malformed input', () => {
  const id = `methodology@${BRAND.legacy.marketplace}`;
  assert.equal(resolveInstallPath(null, id, '/x'), null);
  assert.equal(resolveInstallPath({}, id, '/x'), null);
  assert.equal(resolveInstallPath({ plugins: [] }, id, '/x'), null);
  assert.equal(resolveInstallPath({ plugins: { [id]: 'nope' } }, id, '/x'), null);
  assert.equal(resolveInstallPath({ plugins: { [id]: [null, { scope: 'user' }] } }, id, '/x'), null);
  assert.equal(resolveInstallPath(twoEntries(id), `other@${BRAND.legacy.marketplace}`, '/x'), null);
});

test('resolveCommand reports a missing plugin', () => withFuture(({ mod }) => {
  const home = fixtureHome({ methodology: {} });
  try {
    // No marketplace is known: the missing plugin is named under triqual.
    const r = mod.resolveCommand({ home, cwd: home, cmd: FUTURE });
    assert.equal(r.file, undefined);
    assert.ok(r.error.includes(`requires ${FUTURE_PLUGIN}@${BRAND.marketplace}`), r.error);
    assert.ok(r.error.includes(`claude plugin install ${FUTURE_PLUGIN}@${BRAND.marketplace} --scope user`), r.error);
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('resolveCommand treats a missing or unparsable installed_plugins.json as no plugins', () => {
  const home = tempDir('triqual-home-');
  try {
    const requires = `requires methodology@${BRAND.marketplace}`;
    assert.ok(resolveCommand({ home, cwd: home, cmd: 'doctor' }).error.includes(requires));
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
    assert.ok(resolveCommand({ home, cwd: home, cmd: 'doctor' }).error.includes(requires));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// The installed marketplace copy under the home, listing the named plugins; files: { plugin: [rel...] } present in the
// copy's ./plugins/<plugin>/ source.
function marketplaceCopy(home, names, files = {}) {
  const location = join(home, '.claude', 'plugins', 'marketplaces', BRAND.legacy.marketplace);
  mkdirSync(join(location, '.claude-plugin'), { recursive: true });
  for (const [name, rels] of Object.entries(files)) {
    for (const rel of rels) {
      mkdirSync(dirname(join(location, 'plugins', name, rel)), { recursive: true });
      writeFileSync(join(location, 'plugins', name, rel), '');
    }
  }
  writeFileSync(join(location, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: BRAND.legacy.marketplace, plugins: names.map((name) => ({ name, source: `./plugins/${name}`, version: '0.1.0' })),
  }));
  writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({
    [BRAND.legacy.marketplace]: { installLocation: location },
  }));
}

const RELEASED = ['methodology', 'progress-tracking', 'workflow-gate', 'roles'];
const NOT_RELEASED = `triqual ${FUTURE}: requires ${FUTURE_PLUGIN}@${BRAND.legacy.marketplace}, which is not released yet`;
const UNRELEASED = { error: NOT_RELEASED, status: 'unreleased', marker: '(not released yet)' };

test('resolveCommand says "not released yet" for a plugin the installed marketplace does not list', () => withFuture(({ file, mod }) => {
  const home = fixtureHome({ methodology: {} });
  try {
    marketplaceCopy(home, RELEASED);
    assert.deepEqual(mod.resolveCommand({ home, cwd: home, cmd: FUTURE }), UNRELEASED);
    const r = runShim(file, [FUTURE], { home, cwd: home });
    assert.equal(r.status, 3);
    assert.equal(r.stderr, `${NOT_RELEASED}\n`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('resolveCommand says "not released yet" when an unlisted plugin is installed without the command file', () => withFuture(({ mod }) => {
  const home = fixtureHome({ [FUTURE_PLUGIN]: { 'README.md': '' } });
  try {
    marketplaceCopy(home, RELEASED);
    assert.deepEqual(mod.resolveCommand({ home, cwd: home, cmd: FUTURE }), UNRELEASED);
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('resolveCommand keeps the install hint for a listed plugin, and when the marketplace copy is unreadable', () => withFuture(({ mod }) => {
  const home = fixtureHome({ methodology: {} });
  const hint = `claude plugin install ${FUTURE_PLUGIN}@${BRAND.legacy.marketplace} --scope user`;
  try {
    marketplaceCopy(home, [...RELEASED, FUTURE_PLUGIN]);
    assert.ok(mod.resolveCommand({ home, cwd: home, cmd: FUTURE }).error.includes(hint));
    writeFileSync(join(home, '.claude', 'plugins', 'marketplaces', BRAND.legacy.marketplace, '.claude-plugin', 'marketplace.json'), '{ nope');
    assert.ok(mod.resolveCommand({ home, cwd: home, cmd: FUTURE }).error.includes(hint));
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('resolveCommand reports a missing command file in an older install', () => {
  const home = fixtureHome({ 'progress-tracking': { 'scripts/init.mjs': '' } });
  try {
    const r = resolveCommand({ home, cwd: home, cmd: 'tasks' });
    assert.equal(r.file, undefined);
    assert.match(r.error, /installed version of progress-tracking lacks cli\/tasks\.mjs/);
    // No marketplace copy to tell whether an update would help: no update hint.
    assert.doesNotMatch(r.error, /update/i);
    assert.equal(r.marker, '(not in the installed progress-tracking)');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolveCommand returns the command file inside the resolved installPath', () => {
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': '' } });
  try {
    const r = resolveCommand({ home, cwd: home, cmd: 'doctor' });
    assert.equal(r.error, undefined);
    assert.equal(r.file, join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'methodology', '0.1.0', 'bin', 'doctor.mjs'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the shim exits 3 on a missing plugin', () => {
  const home = tempDir('triqual-home-');
  try {
    const r = runShim(SHIM, ['doctor'], { home, cwd: home });
    assert.equal(r.status, 3);
    assert.ok(r.stderr.includes(`requires methodology@${BRAND.marketplace}`), r.stderr);
    assert.ok(r.stderr.includes(`claude plugin install methodology@${BRAND.marketplace} --scope user`), r.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('shim runs a command whose plugin is installed only under the legacy id while triqual is known', () => {
  // A half-finished migration: methodology still only under its legacy id, progress-tracking already under triqual.
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': 'process.exit(6);\n' } });
  try {
    const plugins = join(home, '.claude', 'plugins');
    const record = JSON.parse(readFileSync(join(plugins, 'installed_plugins.json'), 'utf8'));
    const tasks = join(home, 'cache', 'progress-tracking', '0.2.3');
    mkdirSync(join(tasks, 'bin'), { recursive: true });
    writeFileSync(join(tasks, 'bin', 'tasks.mjs'), 'process.exit(7);\n');
    record.plugins[`progress-tracking@${BRAND.marketplace}`] = [{ scope: 'user', installPath: tasks, version: '0.2.3' }];
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify(record));
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({
      [BRAND.marketplace]: { installLocation: join(home, 'nowhere') },
    }));
    assert.ok(Object.hasOwn(record.plugins, `methodology@${BRAND.legacy.marketplace}`));
    const doctor = runShim(SHIM, ['doctor'], { home, cwd: home });
    assert.equal(doctor.status, 6, doctor.stderr);
    const ran = runShim(SHIM, ['tasks'], { home, cwd: home });
    assert.equal(ran.status, 7, ran.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('shim runs a command whose triqual id is installed only at local scope elsewhere, from the legacy user install', () => {
  // progress-tracking at user scope under its legacy id, and under triqual only for another project (local scope).
  const home = fixtureHome({ 'progress-tracking': { 'bin/tasks.mjs': 'process.exit(7);\n' } });
  try {
    const plugins = join(home, '.claude', 'plugins');
    const record = JSON.parse(readFileSync(join(plugins, 'installed_plugins.json'), 'utf8'));
    const local = join(home, 'cache', 'progress-tracking', '0.2.4');
    mkdirSync(join(local, 'bin'), { recursive: true });
    writeFileSync(join(local, 'bin', 'tasks.mjs'), 'process.exit(8);\n');
    const project = join(home, 'project');
    mkdirSync(project, { recursive: true });
    record.plugins[`progress-tracking@${BRAND.marketplace}`] = [
      { scope: 'local', projectPath: project, installPath: local, version: '0.2.4' },
    ];
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify(record));
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({
      [BRAND.marketplace]: { installLocation: join(home, 'nowhere') },
      [BRAND.legacy.marketplace]: { installLocation: join(home, 'nowhere') },
    }));
    assert.ok(Object.hasOwn(record.plugins, `progress-tracking@${BRAND.legacy.marketplace}`));
    const ran = runShim(SHIM, ['tasks'], { home, cwd: home });
    assert.equal(ran.status, 7, ran.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the shim forwards args and exit code', () => {
  const doctor = 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n';
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': doctor } });
  try {
    const r = runShim(SHIM, ['doctor', 'x', '--repo', 'a b'], { home, cwd: home });
    assert.equal(r.status, 7);
    assert.deepEqual(JSON.parse(r.stdout), ['x', '--repo', 'a b']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the shim prints usage on stderr and exits 1 with an unknown command, in every help order too', () => {
  const home = tempDir('triqual-home-');
  try {
    for (const args of [['nope'], ['help', 'nope'], ['--help', 'nope'], ['-h', 'nope']]) {
      const r = runShim(SHIM, args, { home, cwd: home });
      assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
      assert.equal(r.stdout, '', `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /^triqual: unknown command "nope"\nusage: triqual <command> \[args\.\.\.\]\n/, `args ${JSON.stringify(args)}`);
      for (const name of Object.keys(COMMANDS)) assert.match(r.stderr, new RegExp(`\\b${name}\\b`));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('DESCRIPTIONS gives every command its one-line description', () => {
  assert.deepEqual(DESCRIPTIONS, {
    tasks: 'task ledger: move plan tasks, check drift, status, status-line segment',
    'progress-init': 'opt the current repo into strict progress tracking (--local for shared repos)',
    suggest: 'suggest vault skills for a request (through headjack)',
    doctor: "diagnose the install (--repo: this repo's tracking)",
    sync: "write the installed rules into ~/.claude/CLAUDE.md's managed section",
    ui: 'local read-only tracking dashboard',
    tracking: 'write a tracking file (entry, status, spec, plan) from a draft; the way to write them in local mode',
    hook: 'run a methodology hook for another harness (Codex, Grok)',
    memory: 'weekly local claude-mem memory report and its allowlist',
    'role-eval': 'record hunter results and summarize the store',
    migrate: `move this machine from ${BRAND.legacy.marketplace} to ${BRAND.marketplace}`,
    cost: 'estimated token spend per model from the Claude Code transcripts, controller vs subagents',
  });
});

const FOOTER = 'Run "triqual help <command>" (or "triqual <command> --help") for one command.';
const FAKE_DOCTOR_USAGE = 'usage: triqual doctor FAKE [--flag]\n  --flag  a fake flag\n';
// Prints its usage on --help and exits 0; any other call exits 9, so a dispatch that dropped --help shows.
const FAKE_DOCTOR = `if (process.argv.includes('--help')) process.stdout.write(${JSON.stringify(FAKE_DOCTOR_USAGE)});\nelse process.exit(9);\n`;
// Fails its --help: the help shows sync's description only.
const FAILING_SYNC = "process.stdout.write('boom\\n');\nprocess.exit(1);\n";
const indented = (text) => text.trimEnd().split('\n').map((l) => (l ? `      ${l}` : '')).join('\n');

// A temp HOME with: methodology installed (fake doctor, failing sync, no migrate file), the real
// progress-tracking of this checkout, and no plugin that ships the synthetic `future` command, installed or released.
const manifest = (version) => JSON.stringify({ name: 'methodology', version });
function helpHome() {
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': FAKE_DOCTOR, 'bin/sync.mjs': FAILING_SYNC, '.claude-plugin/plugin.json': manifest('0.1.2') } });
  const path = join(home, '.claude', 'plugins', 'installed_plugins.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.plugins[`progress-tracking@${BRAND.legacy.marketplace}`] = [{ scope: 'user', installPath: join(ROOT, 'plugins', 'progress-tracking') }];
  writeFileSync(path, JSON.stringify(record));
  marketplaceCopy(home, RELEASED);
  return home;
}

test('triqual, triqual help, triqual --help and triqual -h print the full help to stdout and exit 0', () => withFuture(({ file }) => {
  const home = helpHome();
  try {
    const runs = [[], ['help'], ['--help'], ['-h']].map((args) => runShim(file, args, { home, cwd: home }));
    for (const r of runs) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, runs[0].stdout);
    }
    const help = runs[0].stdout;
    const lines = help.trimEnd().split('\n');
    assert.equal(lines[0], 'usage: triqual <command> [args...]');
    assert.equal(lines.at(-1), FOOTER);
    const row = (cmd) => lines.filter((l) => l.startsWith(`  ${cmd} `));
    for (const cmd of Object.keys(COMMANDS)) {
      assert.equal(row(cmd).length, 1, `${cmd} row`);
      assert.ok(row(cmd)[0].includes(DESCRIPTIONS[cmd]), `${cmd} description`);
    }
    // Available commands: no marker, their installed --help indented beneath.
    for (const cmd of ['doctor', 'tasks', 'progress-init', 'ui']) {
      assert.doesNotMatch(row(cmd)[0], /\(not (installed|released yet)\)/, cmd);
    }
    assert.ok(help.includes(`${row('doctor')[0]}\n${indented(FAKE_DOCTOR_USAGE)}\n`), 'doctor usage beneath its row');
    for (const [cmd, bin] of [['tasks', 'cli/tasks.mjs'], ['progress-init', 'cli/progress-init.mjs'], ['ui', 'cli/ui.mjs']]) {
      const usage = execFileSync(process.execPath, [join(ROOT, 'plugins', 'progress-tracking', bin), '--help'], { encoding: 'utf8', env: shimEnv(home) });
      assert.match(usage, new RegExp(`^usage: triqual ${cmd} `), cmd);
      assert.ok(help.includes(`${row(cmd)[0]}\n${indented(usage)}\n`), `${cmd} usage beneath its row`);
    }
    // A --help that fails: the description only.
    assert.doesNotMatch(row('sync')[0], /\(not /);
    assert.doesNotMatch(help, /boom/);
    assert.match(lines[lines.indexOf(row('sync')[0]) + 1], /^  \S/, 'sync row directly followed by the next row');
    // Unresolvable: the marker, no usage.
    assert.match(row(FUTURE)[0], / \(not released yet\)$/);
    assert.ok(row(FUTURE)[0].includes('a command that no release ships'));
    // Missing from both the install and the marketplace copy: not released, whatever the plugin.
    assert.match(row('migrate')[0], / \(not released yet\)$/);
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('triqual help <command>, triqual --help <command>, triqual -h <command> and triqual <command> --help print the same one help', () => withFuture(({ file }) => {
  const home = helpHome();
  try {
    for (const cmd of ['doctor', 'tasks']) {
      const runs = [['help', cmd], ['--help', cmd], ['-h', cmd], [cmd, '--help']].map((args) => runShim(SHIM, args, { home, cwd: home }));
      for (const r of runs) {
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stderr, '');
        assert.equal(r.stdout, runs[0].stdout, cmd);
      }
      assert.match(runs[0].stdout, new RegExp(`^usage: triqual ${cmd} `));
      assert.doesNotMatch(runs[0].stdout, /usage: triqual <command>/);
    }
    assert.equal(runShim(SHIM, ['help', 'doctor'], { home, cwd: home }).stdout, FAKE_DOCTOR_USAGE);
    // An unresolvable command answers as `triqual future --help` does: the resolution error, exit 3.
    for (const args of [['help', FUTURE], ['--help', FUTURE], [FUTURE, '--help']]) {
      const r = runShim(file, args, { home, cwd: home });
      assert.equal(r.status, 3, args.join(' '));
      assert.equal(r.stderr, `${NOT_RELEASED}\n`, args.join(' '));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('helpText shows the description only for a command whose --help times out', () => {
  const hang = "if (process.argv.includes('--help')) setTimeout(() => console.log('late'), 5000);\n";
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': hang, '.claude-plugin/plugin.json': manifest('0.1.2') } });
  try {
    const started = Date.now();
    const help = helpText({ home, cwd: home, timeoutMs: 200 });
    assert.ok(Date.now() - started < 4000, 'did not wait for the hung child');
    const lines = help.trimEnd().split('\n');
    const i = lines.findIndex((l) => l.startsWith('  doctor '));
    assert.ok(lines[i].endsWith(DESCRIPTIONS.doctor), lines[i]);
    assert.match(lines[i + 1], /^  \S/);
    assert.doesNotMatch(help, /late/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the shim works copied alone as triqual.mjs behind a relative triqual symlink, even under a commonjs package.json', () => {
  const doctor = 'process.exit(5);\n';
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': doctor } });
  try {
    writeFileSync(join(home, 'package.json'), '{"type":"commonjs"}\n');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    copyFileSync(SHIM, join(bin, BRAND.cliFile));
    chmodSync(join(bin, BRAND.cliFile), 0o755);
    symlinkSync(BRAND.cliFile, join(bin, BRAND.cli));
    assert.equal(readFileSync(join(bin, BRAND.cliFile), 'utf8').split('\n')[0], '#!/usr/bin/env node');
    const direct = spawnSync(join(bin, BRAND.cli), ['doctor'], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(direct.status, 5, direct.stderr);
    assert.equal(runShim(join(bin, BRAND.cli), ['doctor'], { home, cwd: home }).status, 5);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('importing the shim does not run its main', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(SHIM)}); console.log('imported');`], { encoding: 'utf8' });
  assert.equal(out, 'imported\n');
});

test('triqual progress-init runs the progress-tracking init in the cwd repo', () => {
  const home = tempDir('triqual-home-');
  const repo = tempDir('triqual-repo-');
  try {
    const record = { version: 2, plugins: { [`progress-tracking@${BRAND.legacy.marketplace}`]: [{ scope: 'user', installPath: join(ROOT, 'plugins', 'progress-tracking') }] } };
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(record));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const r = runShim(SHIM, ['progress-init'], { home, cwd: repo });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.created.sort(), ['progress.md', 'status.md']);
    assert.match(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), /progress-tracking:start/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('progress-tracking is at version 0.5.2', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'plugins', 'progress-tracking', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '0.5.2');
});

// Before methodology 0.1.2 and progress-tracking 0.2.1 the commands ignored --help: sync ran and wrote
// ~/.claude/CLAUDE.md. The shim must never pass --help to such an install.
test('the shim never passes --help to an install older than the one that supports it', () => {
  const home = tempDir('triqual-home-');
  const sentinel = join(home, 'ran');
  const runs = `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(sentinel)}, process.argv.slice(2).join(' ') + '\\n');\n`;
  for (const [name, version, files] of [
    ['methodology', '0.1.1', ['bin/doctor.mjs', 'bin/sync.mjs']],
    ['progress-tracking', '0.2.0', ['bin/tasks.mjs', 'bin/ui.mjs', 'bin/progress-init.mjs']],
  ]) {
    const installPath = join(home, 'cache', name, version);
    for (const rel of files) {
      mkdirSync(dirname(join(installPath, rel)), { recursive: true });
      writeFileSync(join(installPath, rel), runs);
    }
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
    writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
  }
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    [`methodology@${BRAND.legacy.marketplace}`]: [{ scope: 'user', installPath: join(home, 'cache', 'methodology', '0.1.1') }],
    [`progress-tracking@${BRAND.legacy.marketplace}`]: [{ scope: 'user', installPath: join(home, 'cache', 'progress-tracking', '0.2.0') }],
  } }));
  try {
    const full = runShim(SHIM, ['--help'], { home, cwd: home });
    assert.equal(full.status, 0, full.stderr);
    const lines = full.stdout.trimEnd().split('\n');
    for (const cmd of ['doctor', 'sync', 'tasks', 'ui', 'progress-init']) {
      const i = lines.findIndex((l) => l.startsWith(`  ${cmd} `));
      assert.ok(lines[i].endsWith(DESCRIPTIONS[cmd]), lines[i]);
      assert.match(lines[i + 1], /^(  \S|$)/, `${cmd}: no usage beneath`);
    }
    for (const args of [['help', 'sync'], ['--help', 'sync'], ['-h', 'sync'], ['sync', '--help'], ['sync', '-h'], ['tasks', 'status', '--help']]) {
      const r = runShim(SHIM, args, { home, cwd: home });
      assert.equal(r.status, 3, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
      assert.match(r.stderr, new RegExp(` or later \\(installed: \\d+\\.\\d+\\.\\d+\\): update it with: claude plugin update (methodology|progress-tracking)@${BRAND.legacy.marketplace}\\n$`), args.join(' '));
      assert.doesNotMatch(r.stderr, /no --help/, `${args.join(' ')}: the command may well have a --help`);
    }
    assert.equal(existsSync(sentinel), false, existsSync(sentinel) ? readFileSync(sentinel, 'utf8') : '');
    // Without --help the old install still runs as before.
    assert.equal(runShim(SHIM, ['sync'], { home, cwd: home }).status, 0);
    assert.equal(readFileSync(sentinel, 'utf8'), '\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- fix round 1 ----

const plugin = (name, version) => ({ '.claude-plugin/plugin.json': JSON.stringify({ name, version }) });
const rowOf = (help, cmd) => help.split('\n').find((l) => l.startsWith(`  ${cmd} `));

test('markers and errors are per command: the marketplace copy decides between update and not released', () => withFuture(({ file, mod }) => {
  const home = fixtureHome({ methodology: { ...plugin('methodology', '0.1.2') }, 'progress-tracking': { ...plugin('progress-tracking', '0.2.0') } });
  try {
    // progress-tracking lacks bin/tasks.mjs, which the marketplace copy has; methodology lacks bin/migrate.mjs,
    // which the copy lacks too; future-plugin is listed but not installed.
    marketplaceCopy(home, [...RELEASED, FUTURE_PLUGIN], { 'progress-tracking': ['bin/tasks.mjs'] });
    const tasks = resolveCommand({ home, cwd: home, cmd: 'tasks' });
    assert.equal(tasks.status, 'update');
    assert.equal(tasks.marker, '(update progress-tracking to get it)');
    assert.ok(tasks.error.endsWith(`Update it with: claude plugin update progress-tracking@${BRAND.legacy.marketplace}`), tasks.error);
    const diff = resolveCommand({ home, cwd: home, cmd: 'migrate' });
    assert.equal(diff.status, 'unreleased');
    assert.equal(diff.marker, '(not released yet)');
    assert.doesNotMatch(diff.error, /update|install/i);
    const future = mod.resolveCommand({ home, cwd: home, cmd: FUTURE });
    assert.equal(future.status, 'not-installed');
    assert.equal(future.marker, '(not installed)');
    for (const [cmd, marker] of [['tasks', '(update progress-tracking to get it)'], ['migrate', '(not released yet)'], [FUTURE, '(not installed)']]) {
      const r = runShim(file, [cmd], { home, cwd: home });
      assert.equal(r.status, 3, cmd);
      assert.equal(r.stderr, `${mod.resolveCommand({ home, cwd: home, cmd }).error}\n`, cmd);
      assert.ok(rowOf(mod.helpText({ home, cwd: home }), cmd).endsWith(` ${marker}`), cmd);
    }
    // The marketplace copy cannot be read: the installed version is named and no update is suggested.
    rmSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'));
    const unknown = resolveCommand({ home, cwd: home, cmd: 'migrate' });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.marker, '(not in the installed methodology 0.1.2)');
    assert.doesNotMatch(unknown.error, /update/i);
    assert.equal(resolveCommand({ home, cwd: home, cmd: 'tasks' }).marker, '(not in the installed progress-tracking 0.2.0)');
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

// A command that records every call in the sentinel file and prints a usage on --help.
const recorder = (sentinel) => `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(sentinel)}, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv.includes('--help')) console.log('usage: recorded');\n`;

test('--help goes only to a plugin listed in HELP_SINCE: an unlisted plugin gets the description only', () => withFuture(({ file, mod }) => {
  const home = fixtureHome({ [FUTURE_PLUGIN]: { [`bin/${FUTURE}.mjs`]: '', ...plugin(FUTURE_PLUGIN, '9.9.9') } });
  writeFileSync(join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, FUTURE_PLUGIN, '0.1.0', 'bin', `${FUTURE}.mjs`), recorder(join(home, 'ran')));
  try {
    marketplaceCopy(home, [...RELEASED, FUTURE_PLUGIN]);
    const help = runShim(file, ['--help'], { home, cwd: home });
    assert.equal(help.status, 0, help.stderr);
    assert.ok(rowOf(help.stdout, FUTURE).endsWith(mod.DESCRIPTIONS[FUTURE]), rowOf(help.stdout, FUTURE));
    assert.doesNotMatch(help.stdout, /usage: recorded/);
    for (const args of [['help', FUTURE], [FUTURE, '--help']]) {
      const r = runShim(file, args, { home, cwd: home });
      assert.equal(r.status, 3, args.join(' '));
      assert.doesNotMatch(r.stderr, /update/i, args.join(' '));
    }
    assert.equal(existsSync(join(home, 'ran')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
}));

test('--help goes only to an install whose version can be read', () => {
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': '', '.claude-plugin/plugin.json': '{ not json' } });
  const doctor = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'methodology', '0.1.0', 'bin', 'doctor.mjs');
  writeFileSync(doctor, recorder(join(home, 'ran')));
  try {
    const help = runShim(SHIM, ['--help'], { home, cwd: home });
    assert.equal(help.status, 0, help.stderr);
    assert.ok(rowOf(help.stdout, 'doctor').endsWith(DESCRIPTIONS.doctor));
    assert.doesNotMatch(help.stdout, /usage: recorded/);
    const r = runShim(SHIM, ['doctor', '--help'], { home, cwd: home });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /version/);
    assert.equal(existsSync(join(home, 'ran')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('triqual suggest gets --help only from methodology 1.0.0 or later, and runs from the methodology plugin', () => {
  for (const [version, helped] of [['0.9.9', false], ['1.0.0', true]]) {
    const home = fixtureHome({ methodology: { 'cli/suggest.mjs': '', ...plugin('methodology', version) } });
    const script = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'methodology', '0.1.0', 'cli', 'suggest.mjs');
    writeFileSync(script, recorder(join(home, 'ran')));
    try {
      const help = runShim(SHIM, ['suggest', '--help'], { home, cwd: home });
      assert.equal(help.status, helped ? 0 : 3, `${version}: ${help.stderr}`);
      assert.equal(help.stdout, helped ? 'usage: recorded\n' : '', version);
      assert.equal(existsSync(join(home, 'ran')), helped, version);
      // Without --help it runs whatever the version, with the arguments as given.
      const ran = runShim(SHIM, ['suggest', 'a request', '--json'], { home, cwd: home });
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(readFileSync(join(home, 'ran'), 'utf8').split('\n').at(helped ? 1 : 0), 'a request --json');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('helpText kills a --help that ignores SIGTERM once it times out', () => {
  const stubborn = "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 4000);\n";
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': stubborn, ...plugin('methodology', '0.1.2') } });
  try {
    const started = Date.now();
    const help = helpText({ home, cwd: home, timeoutMs: 200 });
    assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
    assert.ok(rowOf(help, 'doctor').endsWith(DESCRIPTIONS.doctor));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('helpText stops spawning once its overall budget is spent: the rest show their description only', () => {
  const hang = "setTimeout(() => console.log('late'), 5000);\n";
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': hang, 'bin/sync.mjs': hang, 'bin/migrate.mjs': hang, ...plugin('methodology', '0.1.2') } });
  try {
    const started = Date.now();
    const help = helpText({ home, cwd: home, timeoutMs: 1000, budgetMs: 300 });
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    for (const cmd of ['doctor', 'sync', 'migrate']) assert.ok(rowOf(help, cmd).endsWith(DESCRIPTIONS[cmd]), cmd);
    assert.doesNotMatch(help, /late/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the default budget is 8 s', () => {
  assert.equal(HELP_BUDGET_MS, 8000);
});

test('an unknown command prints the descriptions-only help on stderr and spawns nothing', () => {
  const home = fixtureHome({ methodology: { 'bin/doctor.mjs': '', ...plugin('methodology', '0.1.2') } });
  writeFileSync(join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'methodology', '0.1.0', 'bin', 'doctor.mjs'), recorder(join(home, 'ran')));
  try {
    const r = runShim(SHIM, ['nope'], { home, cwd: home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^triqual: unknown command "nope"\n/);
    assert.ok(rowOf(r.stderr, 'doctor').endsWith(DESCRIPTIONS.doctor));
    assert.doesNotMatch(r.stderr, /usage: recorded/);
    assert.equal(existsSync(join(home, 'ran')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('triqual help help, triqual --help --help and triqual -h -h print the general help and exit 0', () => {
  const home = helpHome();
  try {
    const general = runShim(SHIM, ['--help'], { home, cwd: home }).stdout;
    assert.match(general, /^usage: triqual <command> \[args\.\.\.\]\n/);
    for (const args of [['help', 'help'], ['--help', '--help'], ['-h', '-h']]) {
      const r = runShim(SHIM, args, { home, cwd: home });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.equal(r.stdout, general, args.join(' '));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- T16: triqual tracking ----

test('triqual --help lists tracking', () => {
  const home = fixtureHome({ 'progress-tracking': { 'bin/tracking.mjs': '', ...plugin('progress-tracking', '0.2.2') } });
  const file = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'progress-tracking', '0.1.0', 'bin', 'tracking.mjs');
  writeFileSync(file, recorder(join(home, 'ran')));
  try {
    marketplaceCopy(home, RELEASED);
    assert.equal(typeof DESCRIPTIONS.tracking, 'string');
    assert.match(DESCRIPTIONS.tracking, /write/);
    const help = runShim(SHIM, ['--help'], { home, cwd: home });
    assert.equal(help.status, 0, help.stderr);
    const lines = help.stdout.split('\n');
    const i = lines.findIndex((l) => l.startsWith('  tracking '));
    assert.ok(i >= 0, help.stdout);
    assert.ok(lines[i].endsWith(DESCRIPTIONS.tracking), lines[i]);
    assert.equal(lines[i + 1], '      usage: recorded', 'the installed --help is shown beneath');
    const one = runShim(SHIM, ['help', 'tracking'], { home, cwd: home });
    assert.equal(one.status, 0, one.stderr);
    assert.equal(one.stdout, 'usage: recorded\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('HELP_SINCE is per command: tasks forwards --help on progress-tracking 0.2.1, tracking needs 0.2.2', () => {
  const home = fixtureHome({ 'progress-tracking': { 'bin/tracking.mjs': '', 'bin/tasks.mjs': '', ...plugin('progress-tracking', '0.2.1') } });
  const base = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'progress-tracking', '0.1.0');
  const sentinel = join(home, 'ran');
  for (const rel of ['bin/tracking.mjs', 'bin/tasks.mjs']) writeFileSync(join(base, rel), recorder(sentinel));
  try {
    // tasks keeps --help forwarding on 0.2.1.
    const tasks = runShim(SHIM, ['tasks', '--help'], { home, cwd: home });
    assert.equal(tasks.status, 0, tasks.stderr);
    assert.equal(tasks.stdout, 'usage: recorded\n');
    const full = runShim(SHIM, ['--help'], { home, cwd: home });
    const lines = full.stdout.split('\n');
    assert.equal(lines[lines.findIndex((l) => l.startsWith('  tasks ')) + 1], '      usage: recorded', 'tasks usage beneath on 0.2.1');
    const trackingRow = lines.findIndex((l) => l.startsWith('  tracking '));
    assert.match(lines[trackingRow + 1], /^(  \S|$)/, 'no tracking usage on 0.2.1');
    // tracking needs 0.2.2: not forwarded, and the message does not claim the command has no --help.
    const before = readFileSync(sentinel, 'utf8');
    const r = runShim(SHIM, ['tracking', '--help'], { home, cwd: home });
    assert.equal(r.status, 3);
    assert.equal(r.stderr, 'triqual tracking: --help is passed on only to progress-tracking 0.2.2 or later (installed: 0.2.1): '
      + `update it with: claude plugin update progress-tracking@${BRAND.legacy.marketplace}\n`);
    assert.equal(readFileSync(sentinel, 'utf8'), before, 'tracking ran');
    writeFileSync(join(base, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'progress-tracking', version: '0.2.2' }));
    const ok = runShim(SHIM, ['tracking', '--help'], { home, cwd: home });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'usage: recorded\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("hook resolves to methodology's cli/hook.mjs, and triqual --help lists its description", () => {
  const home = fixtureHome({ methodology: { 'bin/hook.mjs': '', ...plugin('methodology', '0.3.0') } });
  const file = join(home, '.claude', 'plugins', 'cache', BRAND.legacy.marketplace, 'methodology', '0.1.0', 'bin', 'hook.mjs');
  writeFileSync(file, recorder(join(home, 'ran')));
  try {
    marketplaceCopy(home, RELEASED);
    assert.deepEqual(COMMANDS.hook, ['methodology', 'cli/hook.mjs']);
    assert.equal(resolveCommand({ home, cwd: home, cmd: 'hook' }).file, file);
    const help = runShim(SHIM, ['--help'], { home, cwd: home });
    assert.equal(help.status, 0, help.stderr);
    const lines = help.stdout.split('\n');
    const i = lines.findIndex((l) => l.startsWith('  hook '));
    assert.ok(i >= 0, help.stdout);
    assert.ok(lines[i].endsWith(DESCRIPTIONS.hook), lines[i]);
    assert.equal(lines[i + 1], '      usage: recorded', 'methodology 0.3.0 gets --help forwarded');
    const run = runShim(SHIM, ['hook', 'stop', '--harness', 'codex'], { home, cwd: home });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(readFileSync(join(home, 'ran'), 'utf8').includes('stop --harness codex\n'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
