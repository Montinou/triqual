import { test } from 'node:test';
import assert from 'node:assert/strict';

import { namesSwitchOff, switchOffMarkers, switchOffSamples } from '../src/eval/markers.mjs';
import { PROJECT_SUBGLOBS, protectedGlobs } from '../src/eval/builtin.mjs';
import { matchGlob } from '../src/match/glob.mjs';

// A fake home that never exists on disk: the realpath lookup fails, so only the given form is used.
const HOME = '/home/tester';
const noReal = () => {
  throw new Error('ENOENT');
};
const OPTS = { home: HOME, platform: 'linux', realpath: noReal };
const names = (text, extra = {}) => namesSwitchOff(text, { ...OPTS, ...extra });

const MATCHES = [
  ['an opaque rm of the policy directory', '$(printf rm) -rf ~/.config/fence'],
  ['a file under the policy directory', '$(printf rm) -rf ~/.config/fence/policy.json'],
  ['the directory in quotes', 'rm -rf "~/.config/fence"'],
  ['the directory before a semicolon', 'rm -rf ~/.config/fence;true'],
  ['the directory before a pipe', 'echo ~/.config/fence|cat'],
  ['the directory before an ampersand', 'echo ~/.config/fence&'],
  ['the directory before a close paren', '(ls ~/.config/fence)'],
  ['engine directory', 'rm -rf ~/.local/share/fence/engine'],
  ['state directory', 'rm -rf ~/.local/state/fence/sessions'],
  ['$HOME settings', 'tee $HOME/.claude/settings.json'],
  ['${HOME} rc file', 'echo x >> ${HOME}/.zshrc'],
  ['a quoted $HOME', 'echo x >> "$HOME"/.zshrc'],
  ['a quoted ${HOME}', 'echo x >> "${HOME}"/.zshrc'],
  ['the absolute home path', `rm ${HOME}/.local/bin/fence-hook`],
  ['the shim itself', 'rm ~/.local/bin/fence'],
  ['any character after the shim', 'rm ~/.local/bin/fence_old'],
  ['project settings.local', 'cp x .claude/settings.local.json'],
  ['project settings in quotes', 'cp x ".claude/settings.json"'],
  ['project codex config with ./', 'cat ./.codex/config.toml'],
  ['project codex config after =', 'X=.codex/config.toml'],
  ['project codex config at the start', '.codex/config.toml'],
  ['codex config', 'echo >> ~/.codex/config.toml'],
  ['codex hooks', 'echo >> ~/.codex/hooks.json'],
  ['codex requirements', 'echo >> ~/.codex/requirements.toml'],
  ['bash_profile', 'echo >> ~/.bash_profile'],
  ['the admin directory', 'rm -rf "/var/lib/fence"'],
  ['the managed settings', 'echo > /etc/claude-code/managed-settings.json'],
  ['a plugin in any marketplace', 'rm ~/.claude/plugins/cache/any-market/fence/hooks/hooks.json'],
  ['a marketplace clone', 'rm ~/.claude/plugins/marketplaces/m/plugins/fence/x'],
  ['the plugin registry', 'rm ~/.claude/plugins/installed_plugins.json'],
  ['the marketplace registry', 'rm ~/.claude/plugins/known_marketplaces.json'],
  ['a codex plugin', 'rm ~/.codex/plugins/cache/any-market/fence/x'],
];

for (const [label, text] of MATCHES) {
  test(`names a switch-off marker: ${label}`, () => {
    assert.ok(names(text), text);
  });
}

test('the admin directory on darwin', () => {
  assert.ok(namesSwitchOff('rm -rf "/Library/Application Support/fence"', { ...OPTS, platform: 'darwin' }));
  assert.ok(namesSwitchOff('rm -rf /Library/Application\\ Support/fence', { ...OPTS, platform: 'darwin' }));
});

test('an unknown platform covers the admin directories of both', () => {
  const o = { ...OPTS, platform: 'plan9' };
  assert.ok(namesSwitchOff('rm /var/lib/fence/x', o));
  assert.ok(namesSwitchOff('rm "/Library/Application Support/fence/x"', o));
});

test('darwin file names are case-insensitive, linux ones are not', () => {
  assert.ok(namesSwitchOff('rm ~/.ZSHRC', { ...OPTS, platform: 'darwin' }));
  assert.equal(namesSwitchOff('rm ~/.ZSHRC', OPTS), null);
});

test('the home written as a realpath is a marker too', () => {
  const real = (p) => (p === HOME ? '/private/home/tester' : p);
  assert.ok(namesSwitchOff('rm /private/home/tester/.zshrc', { ...OPTS, realpath: real }));
  assert.ok(namesSwitchOff(`rm ${HOME}/.zshrc`, { ...OPTS, realpath: real }));
});

const NO_MATCH = [
  ['the plugin manifest directory', 'cat .claude-plugin/plugin.json'],
  ['the codex plugin directory', 'cat .codex-plugin/x'],
  ['a sandbox settings file', 'cat $TMP/home/.claude/settings.json'],
  ['a sandbox under the same path', 'cat $TMP/home/tester/.claude/settings.json'],
  ['a foreign directory with the home path inside', `cat /tmp/sandbox${HOME}/.zshrc`],
  ['an unrelated config', 'cat ~/.config/gh/hosts.yml'],
  ['a project marker inside a word', 'cat foo.claude/settings'],
  ['another plugin', 'ls ~/.claude/plugins/cache/triqual/methodology'],
  ['a sibling of the fence directory', 'ls ~/.config/fence-extras'],
  ['a project marker as an ancestor', 'rm -rf ~/.claude'],
  ['a project marker inside a path', 'cat /work/repo/.claude/settings.json'],
  ['a literal tilde directory', 'cat /x/~/.zshrc'],
];

for (const [label, text] of NO_MATCH) {
  test(`no marker: ${label}`, () => {
    assert.equal(names(text), null, text);
  });
}

test('the result is the matched marker source', () => {
  const hit = names('rm ~/.zshrc');
  assert.equal(typeof hit, 'string');
  assert.ok(switchOffMarkers(OPTS).some((re) => re.source === hit));
});

test('a plain read of one marker is suppressed by its resolved read path', () => {
  assert.equal(names('cat ~/.zshrc', { readPaths: [`${HOME}/.zshrc`] }), null);
});

test('a read path suppresses only the marker it matches', () => {
  assert.ok(names('cat ~/.zshrc', { readPaths: [`${HOME}/.bashrc`] }));
  assert.ok(names('cat ~/.zshrc', { readPaths: [] }));
});

test('two mentions with one read path still match', () => {
  assert.ok(names('cat ~/.zshrc > "$(printf %s ~/.zshrc)"', { readPaths: [`${HOME}/.zshrc`] }));
});

test('two mentions with two read paths are suppressed', () => {
  assert.equal(names('cat ~/.zshrc ~/.zshrc', { readPaths: [`${HOME}/.zshrc`, `${HOME}/.zshrc`] }), null);
});

test('one marker suppressed does not hide another', () => {
  assert.ok(names('cat ~/.zshrc ~/.bashrc', { readPaths: [`${HOME}/.zshrc`] }));
});

test('a project marker is suppressed by a resolved read path under a project root', () => {
  const projectRoots = ['/work/repo'];
  assert.equal(names('cat .claude/settings.json', { readPaths: ['/work/repo/.claude/settings.json'], projectRoots }), null);
  assert.ok(names('cat .claude/settings.json', { readPaths: ['/work/repo/.claude/other.json'], projectRoots }));
});

test('a project marker read outside every project root is not a read of the project marker', () => {
  const text = 'cp /evil/.claude/settings.json "$(echo .claude/settings.json)"';
  assert.ok(names(text, { readPaths: ['/evil/.claude/settings.json'], projectRoots: ['/work/repo'] }));
  assert.ok(names('cat .claude/settings.json', { readPaths: ['/evil/.claude/settings.json'], projectRoots: ['/work/repo'] }));
  assert.ok(names('cat .claude/settings.json', { readPaths: ['/work/repo2/.claude/settings.json'], projectRoots: ['/work/repo'] }));
});

test('a project marker read is not suppressed when no project root is given', () => {
  assert.ok(names('cat .claude/settings.json', { readPaths: ['/work/repo/.claude/settings.json'] }));
});

test('any of several project roots may hold the read', () => {
  const projectRoots = ['/other', '/work/repo/'];
  assert.equal(names('cat .codex/config.toml', { readPaths: ['/work/repo/.codex/config.toml'], projectRoots }), null);
});

test('projectRoots does not change home markers', () => {
  assert.equal(names('cat ~/.zshrc', { readPaths: [`${HOME}/.zshrc`], projectRoots: ['/work/repo'] }), null);
});

test('the boundary after a marker includes < and >', () => {
  assert.ok(names('$(printf rm) -f ~/.zshrc>/dev/null'));
  assert.ok(names('cat <~/.zshrc'));
  assert.ok(names('cat ~/.zshrc<x'));
  assert.ok(names('cat .claude/settings.json>x'));
});

test('a project marker starts a word after < > ( ; | &', () => {
  assert.ok(names('eval "echo {} >.claude/settings.local.json"'));
  for (const lead of ['<', '>', '(', ';', '|', '&']) {
    assert.ok(names(`echo x${lead}.claude/settings.json`), lead);
    assert.ok(names(`echo x${lead}.codex/config.toml`), lead);
  }
  assert.equal(names('echo x.claude/settings.json'), null);
  assert.equal(names('echo x$.claude/settings.json'), null);
});

test('a dot is a boundary only after the settings markers', () => {
  assert.equal(names('rm ~/.zshrc.bak'), null);
  assert.equal(names('rm ~/.config/fence.d'), null);
  assert.equal(names('rm ~/.local/share/fence.old'), null);
  assert.equal(names('rm ~/.codex/config.toml.bak'), null);
  assert.equal(names('rm /var/lib/fence.d'), null);
  assert.equal(names('rm ~/.claude/plugins/installed_plugins.json.bak'), null);
  assert.equal(names('rm ~/.claude/plugins/cache/m/fence.old'), null);
  assert.ok(names('rm ~/.claude/settings.local.json'));
  assert.ok(names('rm ~/.claude/settings.json'));
  assert.ok(names('rm .claude/settings.local.json'));
  assert.ok(names('rm ~/.local/bin/fence.bak'));
});

test('on darwin only the path body is case-insensitive, not the home variables', () => {
  const o = { ...OPTS, platform: 'darwin' };
  assert.equal(namesSwitchOff('echo x >> $home/.zshrc', o), null);
  assert.equal(namesSwitchOff('echo x >> ${home}/.zshrc', o), null);
  assert.ok(namesSwitchOff('echo x >> $HOME/.ZSHRC', o));
  assert.ok(namesSwitchOff('echo x >> ${HOME}/.Zshrc', o));
  assert.ok(namesSwitchOff('echo x >> ~/.ZshRC', o));
  assert.ok(namesSwitchOff('echo x >> /HOME/Tester/.zshrc', o));
  assert.ok(namesSwitchOff('rm -rf "/library/application support/FENCE"', o));
});

// Drift: every marker is covered by a protected glob.
const covered = (path, platform = 'linux') => {
  const globs = protectedGlobs({ home: HOME, platform, realpath: noReal });
  const project = PROJECT_SUBGLOBS.map((sub) => `/work/repo/${sub}`);
  return [...globs, ...project].some((g) => matchGlob(g, path, { home: HOME }));
};

test('every marker has a sample the marker matches and a protected glob covers', () => {
  for (const platform of ['linux', 'darwin']) {
    const o = { home: HOME, platform, realpath: noReal };
    const markers = switchOffMarkers(o);
    const samples = switchOffSamples(o);
    assert.equal(samples.length, markers.length);
    for (const { marker, text, path } of samples) {
      assert.ok(markers.some((m) => m.source === marker.source), `${text} belongs to the table`);
      marker.lastIndex = 0;
      assert.ok(marker.test(text), `${marker.source} matches its sample ${text}`);
      assert.ok(covered(path, platform), `${path} is covered by a protected ${platform} glob`);
    }
  }
});

test('the spec files, the watchdog and the shim included, are each named by a marker', () => {
  const files = [
    '~/.config/fence/policy.json',
    '~/.local/share/fence/engine/x.mjs',
    '~/.local/state/fence/sessions/s.json',
    '~/.local/bin/fence',
    '~/.local/bin/fence-hook',
    '~/.claude/settings.json',
    '~/.claude/settings.local.json',
    '~/.codex/config.toml',
    '~/.codex/hooks.json',
    '~/.codex/requirements.toml',
    '~/.zshrc',
    '~/.zprofile',
    '~/.zshenv',
    '~/.bashrc',
    '~/.bash_profile',
    '~/.profile',
    '/var/lib/fence/x',
    '/usr/local/libexec/fence/x',
    '/etc/claude-code/managed-settings.json',
    '/etc/codex/requirements.toml',
  ];
  for (const f of files) {
    assert.ok(names(f), f);
    const abs = f.replace('~', HOME);
    assert.ok(covered(abs), `${abs} is covered by a protected glob`);
  }
});

test('the scan is linear: a 512 KiB text takes at most 3x a 256 KiB one', () => {
  const unit = 'echo ~/.claude/plugins/cache/ab ~/.config/fenc $HOME/.cl /home/tester/ .claude/ "x" ';
  const make = (bytes) => unit.repeat(Math.ceil(bytes / unit.length));
  const small = make(256 * 1024);
  const big = make(512 * 1024);
  const time = (text) => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      assert.equal(names(text), null);
      best = Math.min(best, Number(process.hrtime.bigint() - t));
    }
    return best;
  };
  time(small);
  assert.ok(time(big) <= 3 * time(small) + 5e6, 'scan time grows linearly');
});

test('a long run of one segment does not blow up', () => {
  const text = `~/.claude/plugins/cache/${'a'.repeat(200000)}`;
  const t = Date.now();
  assert.equal(names(text), null);
  assert.ok(Date.now() - t < 2000);
});
