import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RC_LINE, classify, findClaude, helpCache, install, launch, parseHelp, uninstall,
} from '../cli/lib/eval-launch.mjs';
import { main } from '../cli/eval-launch.mjs';
import { armFor, loadExperiments } from '../cli/lib/eval-experiments.mjs';

// Invented ids, paths and arm names only; never the real home, never the real shell rc, never a model.
const tmp = () => mkdtempSync(join(tmpdir(), 'cm-evlaunch-'));
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The shape of `claude --help`, abbreviated: options with and without values, a long option name whose description is on
// the next line, an optional value in brackets, an alias pair in Commands.
const HELP = [
  'Usage: claude [options] [command] [prompt]',
  '',
  'Arguments:',
  '  prompt                                Your prompt',
  '',
  'Options:',
  '  --add-dir <directories...>            More directories Claude can access',
  '  --allowedTools, --allowed-tools <tools...>',
  '      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)',
  '      Edit")',
  '  -c, --continue                        Continue the most recent conversation in',
  '                                        the current directory',
  '  --dangerously-skip-permissions        Bypass all permission checks.',
  '  -d, --debug [filter]                  Enable debug mode with optional category',
  '                                        filtering (e.g., --debug=hooks,mcp or',
  '                                        --debug=\'!hooks,!mcp\')',
  '  -h, --help                            Display help for command',
  '  --model <model>                       Model for the current session.',
  '  -p, --print                           Print response and exit',
  '  -r, --resume [value]                  Resume a conversation by session ID or',
  '                                        name, or pick from a list',
  '  --session-id <uuid>                   Use a specific session ID',
  '  --settings <file-or-json>             Settings file or JSON string to load',
  '  --verbose                             Override the verbose setting',
  '',
  'Commands:',
  '  auth                                  Manage authentication',
  '  mcp                                   Configure and manage MCP servers',
  '  plugin|plugins                        Manage Claude Code plugins',
  '  stop|kill <id>                        Stop a background session. Its',
  '                                        conversation is kept: `claude attach',
  '                                        <id>` opens it again',
  '',
].join('\n');

// A fake `claude`: `--help` prints HELP and counts the spawn; any other call records its argv and the launcher's two
// environment variables as one JSON line in $FAKE_OUT, and exits with $FAKE_EXIT (default 0).
function fakeClaude(dir) {
  const bin = join(dir, 'claude');
  const help = join(dir, 'help.txt');
  writeFileSync(help, HELP);
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const argv = process.argv.slice(2);",
    "if (argv.length === 1 && argv[0] === '--help') {",
    "  fs.appendFileSync(process.env.FAKE_HELP_COUNT, 'x\\n');",
    `  process.stdout.write(fs.readFileSync(${JSON.stringify(help)}, 'utf8'));`,
    '  process.exit(0);',
    '}',
    "fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ argv, arm: process.env.TRIQUAL_EVAL_ARM ?? null, launch: process.env.TRIQUAL_EVAL_LAUNCH ?? null }) + '\\n');",
    'process.exit(Number(process.env.FAKE_EXIT ?? 0));',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
}

const SESSION_EXPERIMENT = {
  id: 'exp-launch',
  kind: 'session',
  status: 'active',
  start: '2026-11-17',
  control: 'a',
  arms: { a: { model: 'sonnet' }, b: { model: 'opus' } },
  evaluators: 'abc123',
};

function setup({ experiments = [SESSION_EXPERIMENT] } = {}) {
  const root = tmp();
  const evals = join(root, 'evals');
  const experimentsFile = join(root, 'experiments.json');
  if (experiments) writeFileSync(experimentsFile, JSON.stringify({ experiments }));
  const bin = fakeClaude(root);
  const out = join(root, 'out.jsonl');
  const helpCount = join(root, 'help-count');
  writeFileSync(out, '');
  writeFileSync(helpCount, '');
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TRIQUAL_EVALS_DIR: evals,
    TRIQUAL_EXPERIMENTS_FILE: experimentsFile,
    TRIQUAL_CLAUDE_BIN: bin,
    FAKE_OUT: out,
    FAKE_HELP_COUNT: helpCount,
  };
  const calls = () => lines(out);
  const helpSpawns = () => readFileSync(helpCount, 'utf8').split('\n').filter(Boolean).length;
  return { root, evals, env, bin, calls, helpSpawns, home: env.HOME };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('parseHelp reads the subcommands and the options that take a value', () => {
  const help = parseHelp(HELP);
  assert.deepEqual(help.subcommands, ['auth', 'mcp', 'plugin', 'plugins', 'stop', 'kill']);
  for (const v of ['--add-dir', '--allowedTools', '--allowed-tools', '-d', '--debug', '--model', '-r', '--resume', '--session-id', '--settings']) {
    assert.ok(help.valueOptions.includes(v), `${v} takes a value`);
  }
  for (const f of ['-c', '--continue', '--dangerously-skip-permissions', '-h', '--help', '-p', '--print', '--verbose']) {
    assert.ok(!help.valueOptions.includes(f), `${f} is a flag`);
  }
  assert.ok(!help.valueOptions.includes('--debug=hooks,mcp'), 'a description line is not an option');
  assert.deepEqual(parseHelp(''), { subcommands: [], valueOptions: [] });
});

const HELP_PARSED = parseHelp(HELP);

test('classify: print, continue, fork, session-id, help and version never get an assignment', () => {
  for (const argv of [['-p', 'x'], ['--print', 'x'], ['-c'], ['--continue'], ['--fork-session'], ['--session-id', 'u'], ['-h'], ['--help'], ['-v'], ['--version'], ['--model', 'sonnet', '-p', 'x']]) {
    assert.deepEqual(classify(argv, HELP_PARSED), { mode: 'pass' }, argv.join(' '));
  }
});

test('classify: --from-pr, --teleport, --cloud and --bg resume or start a remote or background session: never assigned', () => {
  for (const argv of [
    ['--from-pr'], ['--from-pr', '123'], ['--from-pr=123'], ['--dangerously-skip-permissions', '--from-pr', '123'],
    ['--teleport'], ['--teleport', 'S1'], ['--teleport=S1'],
    ['--cloud'], ['--cloud', 'fix the bug'], ['--cloud=main'],
    ['--bg'], ['--bg', 'fix the bug'], ['--bg=x'],
  ]) {
    assert.deepEqual(classify(argv, HELP_PARSED), { mode: 'pass' }, argv.join(' '));
  }
});

test('classify: a subcommand is a pass, but a value taken by an option is not a subcommand', () => {
  assert.deepEqual(classify(['mcp', 'list'], HELP_PARSED), { mode: 'pass' });
  assert.deepEqual(classify(['--verbose', 'plugins', 'x'], HELP_PARSED), { mode: 'pass' });
  assert.deepEqual(classify(['--model', 'mcp', 'x'], HELP_PARSED), { mode: 'assign' });
  assert.deepEqual(classify(['--dangerously-skip-permissions', 'fix the bug'], HELP_PARSED), { mode: 'assign' });
  assert.deepEqual(classify([], HELP_PARSED), { mode: 'assign' });
  assert.deepEqual(classify(['--model=mcp'], HELP_PARSED), { mode: 'assign' }, '--name=value takes no following token');
});

test('classify: resume with an id, in its three spellings; a bare resume is not assigned', () => {
  assert.deepEqual(classify(['-r', 'S1'], HELP_PARSED), { mode: 'resume', id: 'S1' });
  assert.deepEqual(classify(['--resume', 'S1'], HELP_PARSED), { mode: 'resume', id: 'S1' });
  assert.deepEqual(classify(['--resume=S1'], HELP_PARSED), { mode: 'resume', id: 'S1' });
  assert.deepEqual(classify(['--dangerously-skip-permissions', '--resume', 'S1'], HELP_PARSED), { mode: 'resume', id: 'S1' });
  assert.deepEqual(classify(['--resume'], HELP_PARSED), { mode: 'pass' }, 'the picker chooses the session: no id to look up');
  assert.deepEqual(classify(['--resume', '--verbose'], HELP_PARSED), { mode: 'pass' });
});

test('findClaude: TRIQUAL_CLAUDE_BIN, else the first executable claude on PATH', () => {
  assert.equal(findClaude({ TRIQUAL_CLAUDE_BIN: '/x/fake-claude', PATH: '/nonexistent' }), '/x/fake-claude');
  const first = tmp();
  const second = tmp();
  writeFileSync(join(first, 'claude'), '#!/bin/sh\n');
  chmodSync(join(first, 'claude'), 0o644);
  writeFileSync(join(second, 'claude'), '#!/bin/sh\n');
  chmodSync(join(second, 'claude'), 0o755);
  assert.equal(findClaude({ PATH: `${join(tmp(), 'missing')}:${first}:${second}` }), join(second, 'claude'));
  assert.equal(findClaude({ PATH: first }), null);
  assert.equal(findClaude({}), null);
});

test('arguments pass through byte for byte', async () => {
  const t = setup();
  const owner = ['--dangerously-skip-permissions', 'an arg with spaces', 'say "hi" and \'bye\'', 'line one\nline two', '', '--model', 'sonnet', '$HOME `x` ; *'];
  const code = await launch(owner, { env: t.env, home: t.home });
  assert.equal(code, 0);
  const [call] = t.calls();
  assert.deepEqual(call.argv.slice(0, 1), ['--session-id']);
  assert.match(call.argv[1], UUID_RE);
  assert.equal(call.argv[2], '--settings');
  assert.equal(call.argv[3], join(t.evals, 'launch', `${call.argv[1]}.json`));
  assert.deepEqual(call.argv.slice(4), owner, 'the owner\'s arguments follow unchanged, in order');
});

test('an assignment writes the settings patch and the assignment line and sets both variables', async () => {
  const t = setup();
  const uuid = '11111111-2222-4333-8444-555555555555';
  await launch(['hello'], { env: t.env, home: t.home, randomUUID: () => uuid, cwd: '/home/x/Project', now: () => new Date('2026-11-17T10:00:00Z') });
  const hit = armFor('session', uuid, { experiments: loadExperiments(t.env.TRIQUAL_EXPERIMENTS_FILE) });
  const file = join(t.evals, 'launch', `${uuid}.json`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), hit.payload, 'the file is the arm\'s settings object');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(t.evals, 'launch')).mode & 0o777, 0o700);
  const assignments = join(t.evals, 'assignments.jsonl');
  assert.deepEqual(lines(assignments), [{ launchId: uuid, experiment: 'exp-launch', arm: hit.arm, cwd: '/home/x/Project', at: '2026-11-17T10:00:00.000Z' }]);
  assert.equal(statSync(assignments).mode & 0o777, 0o600);
  const [call] = t.calls();
  assert.equal(call.arm, `exp-launch/${hit.arm}`);
  assert.equal(call.launch, uuid);
});

test('the exit code of claude is the launcher\'s', async () => {
  const t = setup();
  assert.equal(await launch(['x'], { env: { ...t.env, FAKE_EXIT: '7' }, home: t.home }), 7);
});

test('claude mcp list and claude -p "x" pass with no --settings', async () => {
  const t = setup();
  await launch(['mcp', 'list'], { env: t.env, home: t.home });
  await launch(['-p', 'x'], { env: t.env, home: t.home });
  assert.deepEqual(t.calls().map((c) => c.argv), [['mcp', 'list'], ['-p', 'x']]);
  assert.deepEqual(t.calls().map((c) => [c.arm, c.launch]), [[null, null], [null, null]]);
  assert.ok(!existsSync(join(t.evals, 'assignments.jsonl')));
});

test('claude --model mcp "x" is assigned: the value is not a subcommand', async () => {
  const t = setup();
  await launch(['--model', 'mcp', 'x'], { env: t.env, home: t.home });
  const [call] = t.calls();
  assert.equal(call.argv[0], '--session-id');
  assert.deepEqual(call.argv.slice(4), ['--model', 'mcp', 'x']);
});

test('claude -c skips assignment', async () => {
  const t = setup();
  await launch(['-c'], { env: t.env, home: t.home });
  assert.deepEqual(t.calls()[0].argv, ['-c']);
  assert.equal(t.calls()[0].arm, null);
});

test('claude --resume <assigned id> gets the stored settings, in both spellings', async () => {
  const t = setup();
  const uuid = '11111111-2222-4333-8444-555555555555';
  await launch(['first'], { env: t.env, home: t.home, randomUUID: () => uuid });
  const first = t.calls()[0];
  // T18's SessionStart record of that assigned session.
  mkdirSync(t.evals, { recursive: true });
  writeFileSync(join(t.evals, 'session-arms.jsonl'), `${JSON.stringify({ sessionId: 'S-1', source: 'startup', arm: first.arm, launchId: uuid, at: '2026-11-17T10:00:00.000Z' })}\n`);
  const settings = join(t.evals, 'launch', `${uuid}.json`);
  for (const argv of [['--resume', 'S-1'], ['--resume=S-1'], ['-r', 'S-1', '--dangerously-skip-permissions']]) {
    await launch(argv, { env: t.env, home: t.home });
    const call = t.calls().at(-1);
    assert.deepEqual(call.argv, ['--settings', settings, ...argv]);
    assert.equal(call.arm, first.arm);
    assert.equal(call.launch, uuid);
  }
  assert.equal(lines(join(t.evals, 'assignments.jsonl')).length, 1, 'a resume writes no new assignment');
});

test('claude --resume of a session without one arm and a launch is unchanged', async () => {
  const t = setup();
  mkdirSync(join(t.evals, 'launch'), { recursive: true });
  writeFileSync(join(t.evals, 'launch', 'L1.json'), '{}');
  const rec = (sessionId, arm, launchId) => JSON.stringify({ sessionId, source: 'startup', arm, launchId, at: '2026-11-17T10:00:00.000Z' });
  writeFileSync(join(t.evals, 'session-arms.jsonl'), [
    rec('mixed', 'exp-launch/a', 'L1'), rec('mixed', 'exp-launch/b', 'L1'),
    rec('nolaunch', 'exp-launch/a', null),
    rec('noarm', null, 'L1'),
    rec('gone', 'exp-launch/a', 'L-missing'),
  ].join('\n'));
  for (const id of ['mixed', 'nolaunch', 'noarm', 'gone', 'never-seen']) {
    await launch(['--resume', id], { env: t.env, home: t.home });
    const call = t.calls().at(-1);
    assert.deepEqual(call.argv, ['--resume', id], id);
    assert.deepEqual([call.arm, call.launch], [null, null], id);
  }
  assert.ok(!existsSync(join(t.evals, 'assignments.jsonl')), 'an unchanged resume writes no assignment line');
});

test('no active experiment: no --settings, no assignment line and no help spawn', async () => {
  for (const experiments of [null, [{ ...SESSION_EXPERIMENT, status: 'paused' }], [{ ...SESSION_EXPERIMENT, kind: 'skill', arms: { a: { pluginDir: '/x' }, b: { pluginDir: '/y' } } }]]) {
    const t = setup({ experiments });
    await launch(['--dangerously-skip-permissions', 'x'], { env: t.env, home: t.home });
    assert.deepEqual(t.calls()[0].argv, ['--dangerously-skip-permissions', 'x']);
    assert.deepEqual([t.calls()[0].arm, t.calls()[0].launch], [null, null]);
    assert.ok(!existsSync(join(t.evals, 'assignments.jsonl')));
    assert.equal(t.helpSpawns(), 0);
  }
});

test('an experiments file that is not valid never stops claude', async () => {
  const t = setup({ experiments: null });
  writeFileSync(t.env.TRIQUAL_EXPERIMENTS_FILE, '{ not json');
  await launch(['x'], { env: t.env, home: t.home });
  assert.deepEqual(t.calls()[0].argv, ['x']);
});

const capture = () => {
  const out = [];
  return { stderr: { write: (s) => { out.push(s); } }, text: () => out.join(''), lines: () => out.join('').split('\n').filter(Boolean) };
};

test('an owner --settings means no arm: arguments unchanged, nothing recorded, one stderr line saying why', async () => {
  for (const owner of [['--settings', '/x/own.json', 'hello'], ['--settings={"model":"x"}', 'hello'], ['hello', '--settings', '/x/own.json']]) {
    const t = setup();
    const err = capture();
    await launch(owner, { env: t.env, home: t.home, stderr: err.stderr });
    const [call] = t.calls();
    assert.deepEqual(call.argv, owner, owner.join(' '));
    assert.deepEqual([call.arm, call.launch], [null, null]);
    assert.ok(!existsSync(join(t.evals, 'assignments.jsonl')), 'no assignment is recorded');
    assert.equal(err.lines().length, 1, err.text());
    assert.match(err.text(), /--settings/);
  }
});

test('an owner --settings on a resume of an assigned session is not overridden either', async () => {
  const t = setup();
  const uuid = '11111111-2222-4333-8444-555555555555';
  await launch(['first'], { env: t.env, home: t.home, randomUUID: () => uuid });
  const first = t.calls()[0];
  writeFileSync(join(t.evals, 'session-arms.jsonl'), `${JSON.stringify({ sessionId: 'S-1', source: 'startup', arm: first.arm, launchId: uuid, at: '2026-11-17T10:00:00.000Z' })}\n`);
  const err = capture();
  await launch(['--resume', 'S-1', '--settings', '/x/own.json'], { env: t.env, home: t.home, stderr: err.stderr });
  const call = t.calls().at(-1);
  assert.deepEqual(call.argv, ['--resume', 'S-1', '--settings', '/x/own.json']);
  assert.deepEqual([call.arm, call.launch], [null, null]);
  assert.equal(err.lines().length, 1, err.text());
  assert.equal(lines(join(t.evals, 'assignments.jsonl')).length, 1, 'still only the first launch');
});

test('an owner --settings with no active experiment prints nothing', async () => {
  const t = setup({ experiments: null });
  const err = capture();
  await launch(['--settings', '/x/own.json'], { env: t.env, home: t.home, stderr: err.stderr });
  assert.deepEqual(t.calls()[0].argv, ['--settings', '/x/own.json']);
  assert.equal(err.text(), '');
});

test('an assignment that cannot be written starts claude unchanged and says so on one stderr line', async () => {
  const t = setup();
  mkdirSync(join(t.evals, 'assignments.jsonl'), { recursive: true }); // appending to a directory fails
  const err = capture();
  const code = await launch(['hello'], { env: t.env, home: t.home, stderr: err.stderr });
  assert.equal(code, 0);
  const [call] = t.calls();
  assert.deepEqual(call.argv, ['hello']);
  assert.deepEqual([call.arm, call.launch], [null, null]);
  assert.equal(err.lines().length, 1, err.text());
  assert.match(err.text(), /triqual eval launch: .*arm/);
});

test('an experiments file that is invalid starts claude unchanged and says so on one stderr line', async () => {
  for (const content of ['{ not json', JSON.stringify({ experiments: 'nope' }), JSON.stringify({ experiments: [{ ...SESSION_EXPERIMENT, kind: 'nope' }] })]) {
    const t = setup({ experiments: null });
    writeFileSync(t.env.TRIQUAL_EXPERIMENTS_FILE, content);
    const err = capture();
    await launch(['x'], { env: t.env, home: t.home, stderr: err.stderr });
    assert.deepEqual(t.calls()[0].argv, ['x']);
    assert.equal(err.lines().length, 1, `${content}: ${err.text()}`);
    assert.match(err.text(), /experiments/);
  }
});

test('the same UUID always maps to the same arm', async () => {
  const t = setup();
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await launch(['one'], { env: t.env, home: t.home, randomUUID: () => uuid });
  await launch(['two'], { env: t.env, home: t.home, randomUUID: () => uuid });
  const [a, b] = t.calls();
  assert.equal(a.arm, b.arm);
  const assigned = lines(join(t.evals, 'assignments.jsonl'));
  assert.equal(assigned[0].arm, assigned[1].arm);
});

test('help cache: one claude --help spawn for two launches', async () => {
  const t = setup();
  await launch(['one'], { env: t.env, home: t.home });
  await launch(['two'], { env: t.env, home: t.home });
  assert.equal(t.helpSpawns(), 1);
  const cache = join(t.evals, 'launch', 'claude-help.json');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
});

test('helpCache keys on the binary\'s realpath, size and mtime', () => {
  const t = setup();
  let spawns = 0;
  const run = () => { spawns += 1; return HELP; };
  const first = helpCache({ bin: t.bin, evalsDir: t.evals, run });
  assert.deepEqual(first, HELP_PARSED);
  assert.deepEqual(helpCache({ bin: t.bin, evalsDir: t.evals, run }), HELP_PARSED);
  assert.equal(spawns, 1, 'a hit spawns nothing');
  const later = new Date(Date.now() + 60_000);
  utimesSync(t.bin, later, later);
  helpCache({ bin: t.bin, evalsDir: t.evals, run });
  assert.equal(spawns, 2, 'a changed mtime misses');
  writeFileSync(t.bin, `${readFileSync(t.bin, 'utf8')}// more\n`);
  helpCache({ bin: t.bin, evalsDir: t.evals, run });
  assert.equal(spawns, 3, 'a changed size misses');
});

test('help that cannot be read gives no assignment and is not cached', async () => {
  const t = setup();
  let spawns = 0;
  const run = () => { spawns += 1; return ''; };
  assert.deepEqual(helpCache({ bin: t.bin, evalsDir: t.evals, run }), { subcommands: [], valueOptions: [] });
  assert.deepEqual(helpCache({ bin: t.bin, evalsDir: t.evals, run }), { subcommands: [], valueOptions: [] });
  assert.equal(spawns, 2, 'an empty answer is retried next time');
  assert.ok(!existsSync(join(t.evals, 'launch', 'claude-help.json')));
  await launch(['x'], { env: t.env, home: t.home, run });
  assert.deepEqual(t.calls()[0].argv, ['x'], 'with no help to classify by, the arguments go through unchanged');
});

test('SIGINT and SIGQUIT are ignored by the parent, SIGTERM and SIGHUP are forwarded, and the listeners are removed', async () => {
  const t = setup();
  const killed = [];
  const child = new EventEmitter();
  child.kill = (sig) => { killed.push(sig); return true; };
  const before = Object.fromEntries(['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'].map((s) => [s, process.listeners(s)]));
  let added;
  const spawn = () => {
    // The launcher installs its handlers right after spawn returns: look once it has.
    setImmediate(() => {
      added = Object.fromEntries(Object.keys(before).map((s) => [s, process.listeners(s).filter((l) => !before[s].includes(l))]));
      child.emit('close', 3, null);
    });
    return child;
  };
  const code = await launch(['mcp', 'list'], { env: t.env, home: t.home, spawn });
  assert.equal(code, 3);
  assert.equal(added.SIGINT.length, 1);
  assert.equal(added.SIGQUIT.length, 1);
  added.SIGINT[0]();
  added.SIGQUIT[0]();
  assert.deepEqual(killed, [], 'ignored, not forwarded');
  added.SIGTERM[0]();
  added.SIGHUP[0]();
  assert.deepEqual(killed, ['SIGTERM', 'SIGHUP']);
  for (const s of Object.keys(before)) assert.deepEqual(process.listeners(s), before[s], `${s} listeners restored`);
});

test('a child ended by a signal exits 128 plus the signal number; a missing claude exits 127', async () => {
  const t = setup();
  const child = new EventEmitter();
  child.kill = () => true;
  const code = await launch(['mcp'], { env: t.env, home: t.home, spawn: () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); return child; } });
  assert.equal(code, 143);
  const errors = [];
  const none = await launch(['mcp'], { env: { PATH: '/nonexistent', HOME: t.home, TRIQUAL_EVALS_DIR: t.evals }, home: t.home, stderr: { write: (s) => errors.push(s) } });
  assert.equal(none, 127);
  assert.match(errors.join(''), /claude/);
});

test('install twice writes one line; uninstall removes it exactly', () => {
  const dir = tmp();
  const rc = join(dir, '.zshrc');
  const original = 'export A=1\nalias ll=\'ls -l\'\n';
  writeFileSync(rc, original, { mode: 0o600 });
  chmodSync(rc, 0o600);
  assert.equal(RC_LINE, "alias claude='triqual eval launch' # triqual eval launch");
  assert.deepEqual(install({ rcFile: rc }), { changed: true });
  assert.deepEqual(install({ rcFile: rc }), { changed: false });
  const text = readFileSync(rc, 'utf8');
  assert.equal(text, `${original}${RC_LINE}\n`);
  assert.equal(text.split('\n').filter((l) => l === RC_LINE).length, 1);
  assert.equal(statSync(rc).mode & 0o777, 0o600, 'the file\'s mode is kept');
  assert.deepEqual(uninstall({ rcFile: rc }), { changed: true });
  assert.equal(readFileSync(rc, 'utf8'), original, 'removed exactly');
  assert.deepEqual(uninstall({ rcFile: rc }), { changed: false });
  assert.equal(statSync(rc).mode & 0o777, 0o600);
});

test('install on a missing file or one without a final newline; uninstall of a missing file', () => {
  const dir = tmp();
  const fresh = join(dir, '.zshrc');
  assert.deepEqual(uninstall({ rcFile: fresh }), { changed: false });
  assert.ok(!existsSync(fresh), 'uninstall never creates the file');
  install({ rcFile: fresh });
  assert.equal(readFileSync(fresh, 'utf8'), `${RC_LINE}\n`);
  const bare = join(dir, 'bare');
  writeFileSync(bare, 'export A=1');
  install({ rcFile: bare });
  assert.equal(readFileSync(bare, 'utf8'), `export A=1\n${RC_LINE}\n`);
  const other = join(dir, 'other');
  writeFileSync(other, `${RC_LINE} extra\n# ${RC_LINE}\n`);
  install({ rcFile: other });
  assert.equal(readFileSync(other, 'utf8').split('\n').filter((l) => l === RC_LINE).length, 1, 'only an identical line counts as installed');
  uninstall({ rcFile: other });
  assert.equal(readFileSync(other, 'utf8'), `${RC_LINE} extra\n# ${RC_LINE}\n`, 'a similar line is left alone');
});

test('main: --install and --uninstall as the sole argument edit ${ZDOTDIR:-$HOME}/.zshrc', async () => {
  const zdot = tmp();
  const home = tmp();
  const out = [];
  const stdout = { write: (s) => out.push(s) };
  assert.equal(await main(['--install'], { env: { ZDOTDIR: zdot, HOME: home }, stdout }), 0);
  assert.equal(readFileSync(join(zdot, '.zshrc'), 'utf8'), `${RC_LINE}\n`);
  assert.ok(!existsSync(join(home, '.zshrc')), 'ZDOTDIR wins over HOME');
  assert.equal(await main(['--install'], { env: { ZDOTDIR: zdot, HOME: home }, stdout }), 0);
  assert.equal(readFileSync(join(zdot, '.zshrc'), 'utf8'), `${RC_LINE}\n`);
  assert.equal(await main(['--uninstall'], { env: { ZDOTDIR: zdot, HOME: home }, stdout }), 0);
  assert.equal(readFileSync(join(zdot, '.zshrc'), 'utf8'), '');
  assert.equal(await main(['--install'], { env: { HOME: home }, stdout }), 0);
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), `${RC_LINE}\n`, 'no ZDOTDIR: HOME');
  assert.ok(out.length > 0);
});

test('main: --install with any other argument goes to claude and touches no rc', async () => {
  const t = setup({ experiments: null });
  const zdot = tmp();
  const code = await main(['--install', 'x'], { env: { ...t.env, ZDOTDIR: zdot } });
  assert.equal(code, 0);
  assert.deepEqual(t.calls()[0].argv, ['--install', 'x']);
  assert.ok(!existsSync(join(zdot, '.zshrc')));
});
