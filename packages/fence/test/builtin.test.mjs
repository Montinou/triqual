import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkAncestorOp, checkCommandArgv, checkPathWrite, protectedGlobs } from '../src/eval/builtin.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';

// A fake home and project root that never touch the real file system: `noReal` makes every
// realpath lookup fail, so globs stay as written.
const HOME = '/home/tester';
const ROOT = '/work/repo';
const noReal = () => {
  throw new Error('ENOENT');
};
const OPTS = { home: HOME, platform: 'linux', caseInsensitive: false, projectRoots: [ROOT], realpath: noReal };

function assertDenied(result, rule = 'builtin:self-protection') {
  assert.ok(result, 'expected a deny result');
  assert.equal(result.rule, rule);
  assert.equal(typeof result.reason, 'string');
  assert.match(result.reason, /fence's built-in self-protection/);
}

test('denies a write under ~/.claude/plugins', () => {
  const r = checkPathWrite(`${HOME}/.claude/plugins/cache/x/hooks/hooks.json`, OPTS);
  assertDenied(r);
  assert.ok(r.reason.includes(`${HOME}/.claude/plugins/cache/x/hooks/hooks.json`));
  assertDenied(checkPathWrite(`${HOME}/.codex/plugins/a.json`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.config/fence/policy.json`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.local/share/fence/current`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.local/state/fence/log/x.jsonl`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.local/bin/fence-hook`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.claude/settings.json`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.claude/skills/x/SKILL.md`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.claude/dev-mods/m.mjs`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.agents/plugins/marketplace.json`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.codex/hooks.json`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.codex/requirements.toml`, OPTS));
  // a lexical ".." does not escape the check
  assertDenied(checkPathWrite(`${HOME}/notes/../.claude/plugins/x`, OPTS));
  // admin directory, locked-mode directory and managed settings per platform
  assertDenied(checkPathWrite('/var/lib/fence/hatch.json', OPTS));
  assertDenied(checkPathWrite('/usr/local/libexec/fence/policy.json', OPTS));
  assertDenied(checkPathWrite('/etc/claude-code/managed-settings.json', OPTS));
  assertDenied(checkPathWrite('/etc/codex/requirements.toml', OPTS));
  const mac = { ...OPTS, platform: 'darwin' };
  assertDenied(checkPathWrite('/Library/Application Support/fence/grants/g.json', mac));
  assertDenied(checkPathWrite('/Library/Application Support/ClaudeCode/managed-settings.json', mac));
});

test('denies project .claude/settings.local.json and .codex/config.toml', () => {
  assertDenied(checkPathWrite(`${ROOT}/.claude/settings.local.json`, OPTS));
  assertDenied(checkPathWrite(`${ROOT}/.claude/settings.json`, OPTS));
  assertDenied(checkPathWrite(`${ROOT}/.claude/skills/s/SKILL.md`, OPTS));
  assertDenied(checkPathWrite(`${ROOT}/.codex/config.toml`, OPTS));
  assertDenied(checkPathWrite(`${HOME}/.codex/config.toml`, OPTS));
  // a root with glob metacharacters is matched literally
  const odd = '/work/re[po]*';
  assertDenied(checkPathWrite(`${odd}/.codex/config.toml`, { ...OPTS, projectRoots: [odd] }));
  assert.equal(checkPathWrite('/work/rep/.codex/config.toml', { ...OPTS, projectRoots: [odd] }), null);
});

test('denies a case-flipped settings path on a case-insensitive volume', () => {
  const flipped = `${ROOT}/.Claude/Settings.LOCAL.json`;
  assertDenied(checkPathWrite(flipped, { ...OPTS, caseInsensitive: true }));
  assertDenied(checkPathWrite(`${HOME}/.CLAUDE/plugins/x`, { ...OPTS, caseInsensitive: true }));
  assert.equal(checkPathWrite(flipped, OPTS), null);
  // Unicode normalization folds too: an NFD root matches an NFC candidate and the reverse
  const nfc = '/work/café';
  const nfd = '/work/café';
  assertDenied(checkPathWrite(`${nfd}/.codex/x`, { ...OPTS, caseInsensitive: true, projectRoots: [nfc] }));
  assertDenied(checkPathWrite(`${nfc}/.codex/x`, { ...OPTS, caseInsensitive: true, projectRoots: [nfd] }));
});

test('denies a full-case-folded settings path on a case-insensitive volume', () => {
  // U+017F (long s) and U+212A (Kelvin sign) open `s` and `k` on APFS
  const longS = `${ROOT}/.claude/\u017Fettings.local.json`;
  assertDenied(checkPathWrite(longS, { ...OPTS, caseInsensitive: true }));
  assertDenied(checkPathWrite(`${HOME}/.codex/hoo\u212As.json`, { ...OPTS, caseInsensitive: true }));
  assert.equal(checkPathWrite(longS, OPTS), null);
});

test('allows an unrelated file in the same project', () => {
  assert.equal(checkPathWrite(`${ROOT}/src/index.mjs`, OPTS), null);
  assert.equal(checkPathWrite(`${ROOT}/.claude/notes.md`, OPTS), null);
  assert.equal(checkPathWrite(`${ROOT}/.claude`, OPTS), null);
  assert.equal(checkPathWrite(`${HOME}/.claude/projects/x/memory.md`, OPTS), null);
  assert.equal(checkPathWrite(`${HOME}/.local/bin/other`, OPTS), null);
});

test('denies deleting or moving the ancestor ~/.claude but not writing ~/notes.txt', () => {
  for (const op of ['delete', 'move', 'chmod', 'link']) {
    assertDenied(checkAncestorOp(`${HOME}/.claude`, op, OPTS));
    assertDenied(checkAncestorOp(HOME, op, OPTS));
    assertDenied(checkAncestorOp(ROOT, op, OPTS));
    assertDenied(checkAncestorOp('/', op, OPTS));
  }
  assertDenied(checkAncestorOp(`${HOME}/.codex`, 'delete', OPTS));
  assertDenied(checkAncestorOp(`${HOME}/.local/bin`, 'delete', OPTS));
  // the protected path itself
  assertDenied(checkAncestorOp(`${HOME}/.claude/settings.json`, 'move', OPTS));
  assertDenied(checkAncestorOp(`${HOME}/.CLAUDE`, 'move', { ...OPTS, caseInsensitive: true }));
  assertDenied(checkAncestorOp(UNKNOWN, 'delete', OPTS));
  // not an ancestor
  assert.equal(checkAncestorOp(`${HOME}/notes.txt`, 'delete', OPTS), null);
  assert.equal(checkAncestorOp(`${HOME}/.claude/projects`, 'delete', OPTS), null);
  assert.equal(checkAncestorOp(`${ROOT}/src`, 'move', OPTS), null);
  assert.equal(checkPathWrite(`${HOME}/notes.txt`, OPTS), null);
  assert.throws(() => checkAncestorOp(HOME, 'write', OPTS), TypeError);
});

test('bare ancestor operations such as cp x . are not denied', () => {
  // `cp x .` and `prettier --write .` in a project root write other children of the
  // ancestor; only those children reach the write check.
  assert.equal(checkPathWrite(`${ROOT}/x`, OPTS), null);
  assert.equal(checkPathWrite(`${ROOT}/README.md`, OPTS), null);
  assert.equal(checkPathWrite(`${HOME}/x`, OPTS), null);
});

test('denies fence apply and fence hatch but allows fence check and fence doctor', () => {
  assertDenied(checkCommandArgv(['fence', 'apply']), 'builtin:fence-command');
  assertDenied(checkCommandArgv(['fence', 'hatch', '--for', '1h']), 'builtin:fence-command');
  assertDenied(checkCommandArgv(['/home/tester/.local/bin/fence', 'allow-once', '/x']), 'builtin:fence-command');
  assertDenied(checkCommandArgv(['fence', '--quiet', 'uninstall']), 'builtin:fence-command');
  for (const sub of ['check', 'test', 'log', 'doctor', 'replay', 'version', 'help']) {
    assert.equal(checkCommandArgv(['fence', sub, 'x']), null, sub);
  }
  assert.equal(checkCommandArgv(['fence']), null);
  assert.equal(checkCommandArgv(['fence', '--help']), null);
  assert.equal(checkCommandArgv(['fence', '--version']), null);
  assert.equal(checkCommandArgv(['fencer', 'apply']), null);
  assert.equal(checkCommandArgv(['ls', '-la']), null);
  assert.equal(checkCommandArgv([]), null);
});

test('denies claude plugin disable and codex features disable hooks', () => {
  const host = 'builtin:host-config';
  const r = checkCommandArgv(['claude', 'plugin', 'disable', 'fence@triqual']);
  assertDenied(r, host);
  assert.match(r.reason, /claude plugin disable/);
  for (const v of ['disable', 'uninstall', 'enable', 'install', 'update']) {
    assertDenied(checkCommandArgv(['claude', 'plugin', v, 'x']), host);
  }
  for (const v of ['add', 'remove', 'rm', 'update']) {
    assertDenied(checkCommandArgv(['claude', 'plugin', 'marketplace', v, 'x']), host);
  }
  for (const v of ['set', 'add', 'remove']) assertDenied(checkCommandArgv(['claude', 'config', v, 'k', 'v']), host);
  for (const v of ['add', 'remove']) assertDenied(checkCommandArgv(['claude', 'mcp', v, 'x']), host);
  // a global flag before the subcommand, or its value, does not hide it
  assertDenied(checkCommandArgv(['claude', '--model', 'opus', 'plugin', 'disable', 'x']), host);
  assertDenied(checkCommandArgv(['/usr/local/bin/claude', 'plugin', '--scope', 'user', 'uninstall', 'x']), host);

  const dis = checkCommandArgv(['codex', 'features', 'disable', 'hooks']);
  assertDenied(dis, host);
  assert.match(dis.reason, /codex features disable/);
  assertDenied(checkCommandArgv(['codex', 'features', 'enable', 'x']), host);
  assertDenied(checkCommandArgv(['codex', 'plugin', 'remove', 'fence']), host);
  assertDenied(checkCommandArgv(['codex', 'plugin']), host);
  assertDenied(checkCommandArgv(['codex', 'config', 'set', 'k', 'v']), host);
  assertDenied(checkCommandArgv(['codex', 'mcp', 'add', 'x']), host);
  assertDenied(checkCommandArgv(['codex', 'mcp', 'remove', 'x']), host);

  // reads and auth are allowed
  assert.equal(checkCommandArgv(['claude', 'plugin', 'list']), null);
  assert.equal(checkCommandArgv(['claude', 'config', 'get', 'k']), null);
  assert.equal(checkCommandArgv(['claude', 'mcp', 'list']), null);
  assert.equal(checkCommandArgv(['claude', '-p', 'please disable the plugin']), null);
  assert.equal(checkCommandArgv(['codex', 'features', 'list']), null);
  assert.equal(checkCommandArgv(['codex', 'mcp', 'list']), null);
  assert.equal(checkCommandArgv(['codex', 'login']), null);
  assert.equal(checkCommandArgv(['codex', 'logout']), null);
  assert.equal(checkCommandArgv(['codex', 'exec', 'fix the tests']), null);
});

test('denies launching claude with HOME= or --settings or CLAUDE_CONFIG_DIR=', () => {
  // Variable assignments (HOME=, CLAUDE_CONFIG_DIR=, XDG_*, CODEX_HOME, env -i/-u) are detected by the
  // normalizer (a later task) before argv reaches this check; here the launch flags are covered.
  const host = 'builtin:host-config';
  assertDenied(checkCommandArgv(['claude', '--settings', '/tmp/s.json']), host);
  assertDenied(checkCommandArgv(['claude', '--settings={"disableAllHooks":true}']), host);
  assertDenied(checkCommandArgv(['claude', '-p', 'hi', '--setting-sources', 'project']), host);
  assertDenied(checkCommandArgv(['claude', '--plugin-dir', '/tmp/p']), host);
  assertDenied(checkCommandArgv(['codex', '--plugin-dir=/tmp/p']), host);
  assert.equal(checkCommandArgv(['claude', '--model', 'opus', '-p', 'hi']), null);
});

test('denies codex -c features.hooks=false and --disable hooks', () => {
  const host = 'builtin:host-config';
  assertDenied(checkCommandArgv(['codex', '-c', 'features.hooks=false']), host);
  assertDenied(checkCommandArgv(['codex', '-cfeatures.hooks=false']), host);
  assertDenied(checkCommandArgv(['codex', '--config', 'hooks=[]']), host);
  assertDenied(checkCommandArgv(['codex', '--config=plugins.x.enabled=false']), host);
  assertDenied(checkCommandArgv(['codex', 'exec', '-c', 'projects."/x".trust_level="trusted"', 'go']), host);
  assertDenied(checkCommandArgv(['codex', '-c', 'sandbox_mode="danger-full-access"']), host);
  assertDenied(checkCommandArgv(['codex', '-c', 'approval_policy=never']), host);
  assertDenied(checkCommandArgv(['codex', '-c', ' "features" . hooks = false']), host);
  assertDenied(checkCommandArgv(['codex', '--disable', 'hooks']), host);
  assertDenied(checkCommandArgv(['codex', '--disable=hooks']), host);
  assertDenied(checkCommandArgv(['codex', '--enable', 'x']), host);
  assert.equal(checkCommandArgv(['codex', '-c', 'model="o3"']), null);
  assert.equal(checkCommandArgv(['codex', '--config', 'hooksmith=1']), null);
});

test('denies writes to ~/.zshrc and ~/.claude/shell-snapshots', () => {
  for (const rc of ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile']) {
    assertDenied(checkPathWrite(`${HOME}/${rc}`, OPTS));
  }
  assertDenied(checkPathWrite(`${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh`, OPTS));
  assert.equal(checkPathWrite(`${HOME}/.zshrc.bak`, OPTS), null);
});

test('an UNKNOWN write target denies', () => {
  const r = checkPathWrite(UNKNOWN, OPTS);
  assertDenied(r);
  assertDenied(checkPathWrite('relative/path', OPTS));
});

test('fence followed by an UNKNOWN word denies', () => {
  assertDenied(checkCommandArgv(['fence', UNKNOWN]), 'builtin:fence-command');
  assertDenied(checkCommandArgv(['fence', '--quiet', UNKNOWN, 'x']), 'builtin:fence-command');
  assertDenied(checkCommandArgv([UNKNOWN, 'apply']), 'builtin:fence-command');
  // an UNKNOWN operand of an allowed subcommand is fine
  assert.equal(checkCommandArgv(['fence', 'check', UNKNOWN]), null);
});

test('claude followed by an UNKNOWN flag denies', () => {
  assertDenied(checkCommandArgv(['claude', UNKNOWN]), 'builtin:host-config');
  assertDenied(checkCommandArgv(['claude', '-p', 'hi', UNKNOWN, 'x']), 'builtin:host-config');
  assertDenied(checkCommandArgv(['codex', 'exec', UNKNOWN]), 'builtin:host-config');
  assertDenied(checkCommandArgv(['codex', '-c', UNKNOWN]), 'builtin:host-config');
});

test('a symlinked ~/.claude in a temp HOME still protects the target path', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-builtin-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const target = path.join(tmp, 'elsewhere', 'claude-dir');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(target, 'plugins'), { recursive: true });
  fs.symlinkSync(target, path.join(home, '.claude'));
  const realpath = fs.realpathSync.native;

  const globs = protectedGlobs({ home, platform: 'linux', realpath });
  assert.ok(globs.includes(`${target}/plugins/**`), globs.join('\n'));
  assert.ok(globs.includes(`${home}/.claude/plugins/**`), 'the path as written stays protected');

  const opts = { home, platform: 'linux', caseInsensitive: false, projectRoots: [], realpath };
  assertDenied(checkPathWrite(path.join(target, 'plugins', 'cache', 'x.json'), opts));
  assertDenied(checkPathWrite(path.join(target, 'settings.json'), opts));
  assertDenied(checkPathWrite(path.join(home, '.claude', 'settings.json'), opts));
  assertDenied(checkAncestorOp(target, 'delete', opts));
  assert.equal(checkPathWrite(path.join(target, 'projects', 'm.md'), opts), null);
});

// ---- fix round 1 ----

test('claude subcommand aliases map to their canonical names', () => {
  const host = 'builtin:host-config';
  // aliases from `claude plugin --help`, `claude plugin help marketplace` (Claude Code 2.1.302)
  const spec = checkCommandArgv(['claude', 'plugins', 'disable', 'fence@triqual']);
  assertDenied(spec, host);
  assert.match(spec.reason, /claude plugin disable/);
  assertDenied(checkCommandArgv(['claude', 'plugin', 'i', 'x']), host);
  assertDenied(checkCommandArgv(['claude', 'plugins', 'i', 'x']), host);
  const rem = checkCommandArgv(['claude', 'plugin', 'remove', 'x']);
  assertDenied(rem, host);
  assert.match(rem.reason, /claude plugin uninstall/);
  assertDenied(checkCommandArgv(['claude', 'plugin', 'autoremove']), host);
  assertDenied(checkCommandArgv(['claude', 'plugins', 'marketplace', 'rm', 'x']), host);
  assert.match(checkCommandArgv(['claude', 'plugin', 'marketplace', 'rm', 'x']).reason, /marketplace remove/);
  assert.equal(checkCommandArgv(['claude', 'plugins', 'list']), null);
  assert.equal(checkCommandArgv(['claude', 'plugins', 'marketplace', 'list']), null);
});

test('denies the extra settings-writing subcommands and launch flags', () => {
  const host = 'builtin:host-config';
  for (const argv of [
    ['claude', 'mcp', 'add-json', 'x', '{}'],
    ['claude', 'mcp', 'add-from-claude-desktop'],
    ['claude', 'plugin', 'configure', 'x'],
    ['claude', 'plugin', 'prune'],
    ['claude', '--bare', '-p', 'task'],
    ['claude', '--plugin-url', 'https://example.invalid/p'],
    ['claude', '--plugin-url=https://example.invalid/p'],
    ['codex', '-s', 'danger-full-access'],
    ['codex', '-sdanger-full-access'],
    ['codex', '-s=danger-full-access'],
    ['codex', '--sandbox', 'danger-full-access'],
    ['codex', '--sandbox=danger-full-access'],
    ['codex', 'exec', '-a', 'never', 'task'],
    ['codex', '-anever'],
    ['codex', '--ask-for-approval', 'never'],
    ['codex', '--ask-for-approval=never'],
    ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['codex', 'exec', '--dangerously-bypass-hook-trust', 'task'],
  ]) {
    assertDenied(checkCommandArgv(argv), host);
  }
  // harmless counterparts stay allowed
  assert.equal(checkCommandArgv(['codex', 'exec', 'task']), null);
  assert.equal(checkCommandArgv(['codex', '-m', 'o3', 'task']), null);
  assert.equal(checkCommandArgv(['claude', '-p', 'task']), null);
  assert.equal(checkCommandArgv(['claude', 'mcp', 'list']), null);
  assert.equal(checkCommandArgv(['claude', 'mcp', 'get', 'x']), null);
  assert.equal(checkCommandArgv(['claude', 'plugin', 'details', 'x']), null);
  // -s and -a are codex flags only
  assert.equal(checkCommandArgv(['claude', '-s', 'x']), null);
});

test('fence treats a word after a flag as a possible value', () => {
  assertDenied(checkCommandArgv(['fence', '--config', 'check', 'apply']), 'builtin:fence-command');
  assertDenied(checkCommandArgv(['fence', '--policy', 'x.json', 'check']), 'builtin:fence-command');
  assert.equal(checkCommandArgv(['fence', '--policy=x.json', 'check', 'apply']), null);
});

test('malformed argv fails closed', () => {
  assertDenied(checkCommandArgv('fence apply'), 'builtin:fence-command');
  assertDenied(checkCommandArgv(null), 'builtin:fence-command');
  assertDenied(checkCommandArgv([42, 'apply']), 'builtin:fence-command');
  assertDenied(checkCommandArgv(['claude', { x: 1 }]), 'builtin:host-config');
});

test('a relative or UNKNOWN project root fails closed', () => {
  for (const projectRoots of [['repo'], [UNKNOWN], ['./x'], 'not-an-array']) {
    const opts = { ...OPTS, projectRoots };
    assertDenied(checkPathWrite(`${HOME}/notes.txt`, opts));
    assertDenied(checkAncestorOp(`${HOME}/notes.txt`, 'delete', opts));
  }
  // an absent list is fine
  const { projectRoots: _omit, ...noRoots } = OPTS;
  assert.equal(checkPathWrite(`${HOME}/notes.txt`, noRoots), null);
});

// ---- fix round 2 ----

test('denies codex --yolo and --full-auto', () => {
  const host = 'builtin:host-config';
  assertDenied(checkCommandArgv(['codex', '--yolo']), host);
  assertDenied(checkCommandArgv(['codex', 'exec', '--yolo', 't']), host);
  assertDenied(checkCommandArgv(['codex', '--yolo=1']), host);
  assertDenied(checkCommandArgv(['codex', '--full-auto']), host);
  assertDenied(checkCommandArgv(['codex', 'exec', '--full-auto', 't']), host);
  assert.equal(checkCommandArgv(['codex', 'exec', 'run in yolo mode']), null);
});

test('denies claude plugin init and its alias new', () => {
  const host = 'builtin:host-config';
  assertDenied(checkCommandArgv(['claude', 'plugin', 'init', 'x']), host);
  const n = checkCommandArgv(['claude', 'plugins', 'new', 'x']);
  assertDenied(n, host);
  assert.match(n.reason, /claude plugin init/);
});

test('the bad project root reason reads cleanly', () => {
  const r = checkPathWrite(`${HOME}/x`, { ...OPTS, projectRoots: ['rel'] });
  assertDenied(r);
  assert.doesNotMatch(r.reason, /paths that is/);
});

// ---- fix round 3 ----

test('denies codex --ignore-user-config and --approve-for-me but allows --ignore-rules', () => {
  const host = 'builtin:host-config';
  for (const flag of ['--ignore-user-config', '--approve-for-me']) {
    assertDenied(checkCommandArgv(['codex', flag]), host);
    assertDenied(checkCommandArgv(['codex', 'exec', flag, 't']), host);
    assertDenied(checkCommandArgv(['codex', `${flag}=1`]), host);
  }
  assert.equal(checkCommandArgv(['codex', 'exec', '--ignore-rules', 't']), null);
});
