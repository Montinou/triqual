// `triqual memory setup | block | unblock | never | unnever` and the new `status` lines (local-setup spec 2.5) through main().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main } from '../bin/memory.mjs';
import { REASON_INCOMPLETE, REASON_NOT_SET_UP, loadConfig } from '../lib/config.mjs';
import { canImportSqlite, withTempHome } from './helpers.mjs';
import { createClaudeMemDb } from './fixtures/claude-mem-schema.mjs';

const hasSqlite = await canImportSqlite();
const skip = !hasSqlite && 'node:sqlite is not available on this Node';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86400000;

// A scripted git/stat runner answering by folder: script[cwd] = { remotes } is a git root with those remotes; any other
// folder is missing. Nothing real is run.
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr, timedOut: false });
function scriptedRun(script = {}) {
  return async (cmd, args) => {
    const cwd = cmd === 'stat' ? args[0] : args[1];
    const b = script[cwd];
    if (b === undefined) return fail(`stat: cannot stat '${cwd}': No such file or directory`);
    if (cmd === 'stat') return ok('stat output');
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --show-toplevel') return ok(`${realpathSync(cwd)}\n`);
    const remotes = b.remotes ?? {};
    if (rest === 'remote get-url origin') return Object.hasOwn(remotes, 'origin') ? ok(`${remotes.origin}\n`) : fail("error: No such remote 'origin'", 2);
    if (rest === 'remote -v') return ok(Object.entries(remotes).flatMap(([n, u]) => [`${n}\t${u} (fetch)\n`, `${n}\t${u} (push)\n`]).join(''));
    return fail('unexpected command');
  };
}
const sshHost = async (host) => host;
const deps = { now: () => NOW, run: scriptedRun(), sshHost };

// Runs main with captured streams.
async function run(env, argv, d = deps) {
  let out = '';
  let err = '';
  const code = await main(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, deps: d });
  return { code, out, err };
}
const lines = (s) => s.split('\n').filter(Boolean);
const writeConfig = (paths, raw) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, typeof raw === 'string' ? raw : JSON.stringify(raw));
};
const statusLine = async (env, prefix) => lines((await run(env, ['status'])).out).find((l) => l.startsWith(prefix));

const obs = (id, project, over = {}) => ({
  id, project, type: 'decision', title: `title ${id}`, narrative: `narrative ${id}`, facts: '["fact"]', created_at_epoch: NOW - DAY, ...over,
});

// ---- block / unblock ---------------------------------------------------------------------------------------------------

test('block stores trimmed terms once, case-insensitively, and prints the list', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['block', ' Acme Corp ', 'acme', 'ACME corp', 'Globex']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.deepEqual(lines(r.out), ['Acme Corp', 'acme', 'Globex']);
  assert.deepEqual(loadConfig(paths).raw.clientTerms, ['Acme Corp', 'acme', 'Globex']);
  const again = await run(env, ['block', 'GLOBEX']);
  assert.equal(again.code, 0);
  assert.deepEqual(loadConfig(paths).raw.clientTerms, ['Acme Corp', 'acme', 'Globex']);
}));

test('block "Acme Corp" acme stores both terms', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['block', 'Acme Corp', 'acme']);
  assert.equal(r.code, 0);
  assert.deepEqual(loadConfig(paths).raw.clientTerms, ['Acme Corp', 'acme']);
}));

test('block --list prints one term per line and writes nothing', () => withTempHome(async ({ env, paths }) => {
  const empty = await run(env, ['block', '--list']);
  assert.deepEqual(empty, { code: 0, out: '', err: '' });
  await run(env, ['block', 'one', 'two words']);
  const r = await run(env, ['block', '--list']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'one\ntwo words\n');
  assert.deepEqual(Object.keys(loadConfig(paths).raw).sort(), ['clientTerms', 'version']);
}));

test('unblock removes terms case-insensitively and reports the missing ones with exit 0', () => withTempHome(async ({ env, paths }) => {
  await run(env, ['block', 'Acme', 'globex']);
  const r = await run(env, ['unblock', 'ACME', 'initech']);
  assert.equal(r.code, 0);
  assert.match(r.out, /missing \(not in the client terms\): initech/);
  assert.deepEqual(loadConfig(paths).raw.clientTerms, ['globex']);
}));

test('block, unblock, never and unnever without a name, or with an unknown flag, exit 1 with usage', () => withTempHome(async ({ env, paths }) => {
  const argvs = [
    ['block'], ['block', '  '], ['block', '--x'], ['block', 'ok', '--x'], ['unblock'], ['unblock', '--list'], ['unblock', '--x'],
    ['never'], ['never', ''], ['never', '--x'], ['unnever'], ['unnever', '--list'], ['unnever', '--x'],
  ];
  for (const argv of argvs) {
    const r = await run(env, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /^Usage:/, argv.join(' '));
    assert.equal(r.out, '', argv.join(' '));
  }
  assert.deepEqual(loadConfig(paths).raw, {});
}));

// ---- never / unnever ---------------------------------------------------------------------------------------------------

test('never stores project names literally, trimmed and once; the slash is not a path', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['never', 'acme/feature', ' globex ', 'acme/feature']);
  assert.equal(r.code, 0);
  assert.deepEqual(lines(r.out), ['acme/feature', 'globex']);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['acme/feature', 'globex']);
  const single = await run(env, ['never', 'initech/tools']);
  assert.equal(single.code, 0);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['acme/feature', 'globex', 'initech/tools']);
}));

test('never --list prints one name per line', () => withTempHome(async ({ env }) => {
  assert.deepEqual(await run(env, ['never', '--list']), { code: 0, out: '', err: '' });
  await run(env, ['never', 'a/b', 'c']);
  assert.equal((await run(env, ['never', '--list'])).out, 'a/b\nc\n');
}));

test('unnever removes names and reports the missing ones with exit 0', () => withTempHome(async ({ env, paths }) => {
  await run(env, ['never', 'a/b', 'keep']);
  const r = await run(env, ['unnever', 'a/b', 'nope']);
  assert.equal(r.code, 0);
  assert.match(r.out, /missing \(not in the never-send list\): nope/);
  assert.deepEqual(loadConfig(paths).raw.neverSend, ['keep']);
}));

test('block, unblock, never and unnever refuse an unparsable config, exit 1 naming the file, bytes unchanged', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, '{ broken');
  for (const argv of [['block', 'x'], ['unblock', 'x'], ['never', 'x'], ['unnever', 'x'], ['setup', '--done'], ['setup', '--decline']]) {
    const r = await run(env, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.ok(r.err.includes(paths.configFile), r.err);
    assert.equal(readFileSync(paths.configFile, 'utf8'), '{ broken');
  }
}));

// ---- setup --done / --decline ------------------------------------------------------------------------------------------

test('setup --done writes setupAt (now) and removes setupDeclinedAt and noClientTermsAck', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { allowlist: ['a'], setupDeclinedAt: '2026-09-01T00:00:00.000Z', noClientTermsAck: true, other: 7 });
  const r = await run(env, ['setup', '--done']);
  assert.deepEqual(r, { code: 0, out: '', err: '' });
  assert.deepEqual(loadConfig(paths).raw, { allowlist: ['a'], setupAt: NOW_ISO, other: 7 });
}));

test('setup --done --no-client-terms writes noClientTermsAck: true', () => withTempHome(async ({ env, paths }) => {
  const r = await run(env, ['setup', '--done', '--no-client-terms']);
  assert.equal(r.code, 0);
  const raw = loadConfig(paths).raw;
  assert.equal(raw.setupAt, NOW_ISO);
  assert.equal(raw.noClientTermsAck, true);
  assert.ok(!('setupDeclinedAt' in raw));
  assert.deepEqual(Object.keys(raw).sort(), ['noClientTermsAck', 'setupAt', 'version']);
}));

test('setup --decline writes setupDeclinedAt and keeps the rest', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { allowlist: ['a'], setupAt: '2026-10-01T00:00:00.000Z' });
  const r = await run(env, ['setup', '--decline']);
  assert.deepEqual(r, { code: 0, out: '', err: '' });
  assert.deepEqual(loadConfig(paths).raw, { allowlist: ['a'], setupAt: '2026-10-01T00:00:00.000Z', setupDeclinedAt: NOW_ISO });
}));

test('setup --decline and setup --done still work with an invalid allowlist (Review Focus 5)', () => withTempHome(async ({ env, paths }) => {
  const raw = { version: 1, allowlist: ['acme/tools', 'github.com/mont*'] };
  writeConfig(paths, raw);
  assert.deepEqual(await run(env, ['setup', '--decline']), { code: 0, out: '', err: '' });
  assert.deepEqual(loadConfig(paths).raw, { ...raw, setupDeclinedAt: NOW_ISO });
  assert.deepEqual(await run(env, ['setup', '--done']), { code: 0, out: '', err: '' });
  assert.deepEqual(loadConfig(paths).raw, { ...raw, setupAt: NOW_ISO });
}));

test('block on invalid client terms exits 1 with the fixed message and leaves the file unchanged', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, clientTerms: ['acme', 'globex', ''] });
  const before = readFileSync(paths.configFile, 'utf8');
  const r = await run(env, ['block', 'initech']);
  assert.deepEqual(r, { code: 1, out: '', err: 'memory-report: clientTerms is invalid; fix the config first\n' });
  assert.equal(readFileSync(paths.configFile, 'utf8'), before);
}));

test('setup with no flag, an unknown flag, a combination or a stray argument exits 1 with usage and writes nothing', () => withTempHome(async ({ env, paths }) => {
  const argvs = [
    ['setup'], ['setup', '--x'], ['setup', '--done', '--decline'], ['setup', '--suggest', '--done'], ['setup', '--done', '--json'],
    ['setup', '--decline', '--no-client-terms'], ['setup', '--suggest', '--no-client-terms'], ['setup', '--done', 'x'], ['setup', 'x'],
  ];
  for (const argv of argvs) {
    const r = await run(env, argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /^Usage:/, argv.join(' '));
    assert.equal(r.out, '', argv.join(' '));
  }
  assert.deepEqual(loadConfig(paths).raw, {});
}));

test('setup --decline after --done turns the gate off with the R1 reason', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { allowlist: ['a'], clientTerms: ['acme'] });
  assert.equal((await run(env, ['setup', '--done'])).code, 0);
  assert.equal(await statusLine(env, 'insights gate:'), 'insights gate: open');
  const later = { now: () => NOW + 1000 };
  assert.equal((await run(env, ['setup', '--decline'], later)).code, 0);
  assert.equal(await statusLine(env, 'insights gate:'), `insights gate: off (${REASON_NOT_SET_UP})`);
  assert.equal(await statusLine(env, 'setup:'), 'setup: declined 2026-10-07');
}));

// ---- setup --suggest ---------------------------------------------------------------------------------------------------

test('setup --suggest without claude-mem.db exits 1 and writes nothing', () => withTempHome(async ({ env, paths }) => {
  for (const argv of [['setup', '--suggest'], ['setup', '--suggest', '--json']]) {
    const r = await run(env, argv);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /claude-mem\.db not found/);
  }
  assert.deepEqual(loadConfig(paths).raw, {});
}));

// A temp home with a database: acme (3 notes, a recorded folder), globex (2 notes, no folder), a home-named project.
async function withSuggestDb(fn) {
  await withTempHome(async (ctx) => {
    mkdirSync(dirname(ctx.paths.dbFile), { recursive: true });
    createClaudeMemDb(ctx.paths.dbFile, {
      observations: [obs(1, 'acme'), obs(2, 'acme'), obs(3, 'acme/feature'), obs(4, 'globex'), obs(5, 'globex')],
      sessions: [{ project: 'acme', cwd: '/work/acme', started_at_epoch: NOW - DAY }],
    });
    await fn(ctx);
  });
}

test('setup --suggest prints numbered text lines for the last 30 days', { skip }, () => withSuggestDb(async ({ env }) => {
  const r = await run(env, ['setup', '--suggest']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(r.out, '1. acme — 3 notes — /work/acme\n2. globex — 2 notes — no recorded folder\n');
}));

const EMPTY_SUGGEST = { candidates: [], homeProject: null, owners: [], merges: [], repos: { resolved: 0, withCwd: 0, unambiguous: 0, complete: true } };

test('setup --suggest --json prints the spec 5.1 keys and writes only repo-map.json', { skip }, () => withSuggestDb(async ({ env, paths }) => {
  const r = await run(env, ['setup', '--suggest', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed), ['candidates', 'homeProject', 'owners', 'merges', 'repos']);
  assert.deepEqual(parsed.candidates, [
    { project: 'acme', notes: 3, coveredNotes: 0, cwd: '/work/acme', repo: null, owner: null },
    { project: 'globex', notes: 2, coveredNotes: 0, cwd: null, repo: null, owner: null },
  ]);
  assert.equal(parsed.homeProject, null);
  assert.deepEqual(parsed.owners, []);
  assert.deepEqual(parsed.merges, []);
  assert.deepEqual(parsed.repos, { resolved: 1, withCwd: 1, unambiguous: 0, complete: true });
  assert.ok(!existsSync(paths.configFile), 'the config is never written');
  assert.deepEqual(readdirSync(paths.stateDir), ['repo-map.json']);
}));

test('setup --suggest --json in either flag order, and an empty window prints an empty list', { skip }, () => withSuggestDb(async ({ env }) => {
  const r = await run(env, ['setup', '--json', '--suggest']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).candidates.length, 2);
  const late = await run(env, ['setup', '--suggest', '--json'], { now: () => NOW + 60 * DAY });
  assert.deepEqual(JSON.parse(late.out), { ...EMPTY_SUGGEST, repos: { resolved: 1, withCwd: 1, unambiguous: 0, complete: true } });
  assert.equal((await run(env, ['setup', '--suggest'], { now: () => NOW + 60 * DAY })).out, '');
}));

test('setup --suggest --json leaves out a never-send name while the list holds an invalid entry (Ruling 9)', { skip }, () => withSuggestDb(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, neverSend: ['acme', 'github.com/mont*'] });
  const r = await run(env, ['setup', '--suggest', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).candidates.map((c) => c.project), ['globex']);
}));

// A temp home whose database has `client` (its only folder a real temp dir whose origin is a client repository), `mine`
// (a personal repository, allowed by owner except one note without a session folder) and `plain` (no folder at all).
async function withRepoDb(fn) {
  await withTempHome(async (ctx) => {
    const dirs = ['client', 'mine'].map((name) => {
      const d = join(ctx.home, 'code', name);
      mkdirSync(d, { recursive: true });
      return d;
    });
    mkdirSync(dirname(ctx.paths.dbFile), { recursive: true });
    createClaudeMemDb(ctx.paths.dbFile, {
      sessions: [
        { memory_session_id: 's1', project: 'client', cwd: dirs[0], started_at_epoch: NOW - DAY },
        { memory_session_id: 's2', project: 'mine', cwd: dirs[1], started_at_epoch: NOW - DAY },
      ],
      observations: [
        obs(1, 'client', { memory_session_id: 's1' }), obs(2, 'client', { memory_session_id: 's1' }),
        obs(3, 'mine', { memory_session_id: 's2' }), obs(4, 'mine'), obs(5, 'plain'),
      ],
    });
    const script = { [dirs[0]]: { remotes: { origin: 'https://github.com/Client/App.git' } }, [dirs[1]]: { remotes: { origin: 'git@github.com:me/mine.git' } } };
    await fn({ ...ctx, dirs, d: { now: () => NOW, run: scriptedRun(script), sshHost } });
  });
}

test('setup --suggest --json resolves the repositories: a key whose only folder is under a never-sent owner is absent (I2)', { skip }, () => withRepoDb(async ({ env, paths, d }) => {
  writeConfig(paths, { version: 1, neverSend: ['github.com/client/*'], allowlist: ['github.com/me/*'] });
  const r = await run(env, ['setup', '--suggest', '--json'], d);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  assert.deepEqual(parsed.candidates.map((c) => c.project), ['mine', 'plain']);
  assert.deepEqual(parsed.candidates[0], { project: 'mine', notes: 1, coveredNotes: 1, cwd: join(env.HOME, 'code', 'mine'), repo: 'github.com/me/mine', owner: 'github.com/me/*' });
  assert.deepEqual(parsed.owners, []); // both owners are on a list
  // fix 1 M1: unambiguous counts the candidates with a repository (`mine`), not every key with folders (`client` is blocked).
  assert.deepEqual(parsed.repos, { resolved: 2, withCwd: 2, unambiguous: 1, complete: true });
  const map = JSON.parse(readFileSync(join(paths.stateDir, 'repo-map.json'), 'utf8'));
  assert.deepEqual(Object.keys(map.folders).sort(), [join(env.HOME, 'code', 'client'), join(env.HOME, 'code', 'mine')].sort());
}));

test('setup --suggest --json lists the owners not on a list', { skip }, () => withRepoDb(async ({ env, d }) => {
  const parsed = JSON.parse((await run(env, ['setup', '--suggest', '--json'], d)).out);
  assert.deepEqual(parsed.owners, [{ owner: 'github.com/client/*', projects: 1, notes: 2 }, { owner: 'github.com/me/*', projects: 1, notes: 1 }]);
  assert.deepEqual(parsed.candidates.map((c) => [c.project, c.repo]), [['client', 'github.com/client/app'], ['mine', 'github.com/me/mine'], ['plain', null]]);
  assert.equal(parsed.repos.unambiguous, 2);
}));

const IDENTITY_NOTE = 'memory-report: repository identity unavailable: no candidates are listed this run because never-send has repository or owner entries.\n';

test('setup --suggest on a rebuilt map with owner never-send entries lists nothing and prints the fixed note (Ruling 12)', { skip }, () => withRepoDb(async ({ env, paths, d }) => {
  writeConfig(paths, { version: 1, neverSend: ['github.com/client/*'] });
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(join(paths.stateDir, 'repo-map.json'), '{ not json');
  const r = await run(env, ['setup', '--suggest', '--json'], d);
  assert.equal(r.code, 0);
  assert.equal(r.err, IDENTITY_NOTE);
  const parsed = JSON.parse(r.out);
  assert.deepEqual([parsed.candidates, parsed.owners, parsed.merges], [[], [], []]);
  assert.equal(parsed.repos.unambiguous, 0); // fix 1 M1: no candidate listed, none counted
  const text = await run(env, ['setup', '--suggest'], d);
  assert.deepEqual([text.code, text.out, text.err], [0, IDENTITY_NOTE.replace(/^memory-report: r/, 'R'), '']);
}));

test('setup --suggest on a rebuilt map without repository never-send entries still lists by name', { skip }, () => withRepoDb(async ({ env, paths, d }) => {
  writeConfig(paths, { version: 1, neverSend: ['nobody'] });
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(join(paths.stateDir, 'repo-map.json'), '{ not json');
  const r = await run(env, ['setup', '--suggest', '--json'], d);
  assert.equal(r.err, '');
  assert.deepEqual(JSON.parse(r.out).candidates.map((c) => c.project), ['client', 'mine', 'plain']);
}));

// ---- status ------------------------------------------------------------------------------------------------------------

const FRESH_STATUS = [
  'last success: never',
  'last attempt: never',
  'last error: none',
  'lock holder: none',
  'setup: not set up',
  `insights gate: off (${REASON_NOT_SET_UP})`,
  'client terms: 0',
  'never-send: 0',
  'allowlisted projects: 0',
  'config warnings: none',
  '',
];

test('status for a fresh home reports not set up and zero counts', () => withTempHome(async ({ env }) => {
  const r = await run(env, ['status']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.split('\n'), FRESH_STATUS);
}));

test('status for a 0.1.0-style config (allowlist, no setupAt) is not set up with the allowlist counted', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { version: 1, allowlist: ['acme', 'globex'] });
  const out = (await run(env, ['status'])).out.split('\n');
  assert.ok(out.includes('setup: not set up'));
  assert.ok(out.includes(`insights gate: off (${REASON_NOT_SET_UP})`));
  assert.ok(out.includes('allowlisted projects: 2'));
  assert.ok(out.includes('client terms: 0'));
}));

test('status for a done setup prints the date, the counts and the gate', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { allowlist: ['a'], clientTerms: ['acme', 'globex'], neverSend: ['x'], setupAt: '2026-10-01T23:59:59.000Z' });
  const out = (await run(env, ['status'])).out.split('\n');
  assert.deepEqual(out.slice(4, 9), ['setup: done 2026-10-01', 'insights gate: open', 'client terms: 2', 'never-send: 1', 'allowlisted projects: 1']);
}));

test('status for a done but incomplete setup shows the R2 reason', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { allowlist: ['a'], setupAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(await statusLine(env, 'insights gate:'), `insights gate: off (${REASON_INCOMPLETE})`);
}));

test('status for a declined setup without setupAt prints declined', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { setupDeclinedAt: '2026-10-03T08:00:00.000Z' });
  assert.equal(await statusLine(env, 'setup:'), 'setup: declined 2026-10-03');
}));

test('status with an invalid setupDeclinedAt keeps done and shows the gate off with the R2 reason', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { allowlist: ['a'], clientTerms: ['acme'], setupAt: '2026-10-01T00:00:00.000Z', setupDeclinedAt: 'yesterday-ish' });
  assert.equal(await statusLine(env, 'setup:'), 'setup: done 2026-10-01');
  assert.equal(await statusLine(env, 'insights gate:'), `insights gate: off (${REASON_INCOMPLETE})`);
}));

test('status keeps done when setupAt is later than setupDeclinedAt', () => withTempHome(async ({ env, paths }) => {
  writeConfig(paths, { setupDeclinedAt: '2026-10-01T00:00:00.000Z', setupAt: '2026-10-03T00:00:00.000Z' });
  assert.equal(await statusLine(env, 'setup:'), 'setup: done 2026-10-03');
}));

// ---- help --------------------------------------------------------------------------------------------------------------

test('--help lists setup, block, unblock, never and unnever and still omits generate', async () => {
  const r = await run({}, ['--help']);
  assert.equal(r.code, 0);
  for (const word of ['setup --suggest', 'setup --done', 'setup --decline', 'block <term>', 'unblock <term>', 'block --list', 'never <entry>', 'unnever <entry>', 'never --list', 'allow', 'deny', 'status', 'report', 'repos [--json]']) {
    assert.ok(r.out.includes(word), word);
  }
  assert.ok(!r.out.includes('generate'));
});

test('setup --suggest text escapes control characters in names and folders (fix 1 I1)', { skip }, () => withTempHome(async ({ env, paths }) => {
  mkdirSync(dirname(paths.dbFile), { recursive: true });
  createClaudeMemDb(paths.dbFile, {
    observations: [obs(1, 'esc\u001b[2K\rfake'), obs(2, 'esc\u001b[2K\rfake')],
    sessions: [{ project: 'esc\u001b[2K\rfake', cwd: '/work/a\nb\u009b', started_at_epoch: NOW - DAY }],
  });
  const r = await run(env, ['setup', '--suggest']);
  assert.equal(r.code, 0);
  assert.equal(r.out, '1. esc\\x1b[2K\\rfake — 2 notes — /work/a\\nb\\x9b\n');
}));
