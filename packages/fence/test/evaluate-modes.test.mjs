// Modes in the evaluator (T7): the floor, uncertain and certain denies, and each mode's actions.
//
// The calls are hand-built effective commands and opaque verdicts in the shapes the normalizer gives
// (as in evaluate.test.mjs); `raw` is the call's command text. Nothing here writes to the file system:
// `noReal` makes every realpath lookup fail, so globs and the home stay as written, and the one real
// normalizer run (the wrapper test) uses a cwd and home that do not exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../src/eval/evaluate.mjs';
import { validatePolicy } from '../src/policy/schema.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { normalize } from '../src/norm/normalize.mjs';

const HOME = '/home/tester';
const ROOT = '/work/repo';
const noReal = () => {
  throw new Error('ENOENT');
};
const CTX = { home: HOME, platform: 'linux', caseInsensitive: false, realpath: noReal };

// The spec's example profiles.
const PROFILES = {
  default: { undecided: 'host', uncertain: 'audit' },
  strict: { undecided: 'host', uncertain: 'deny' },
  relaxed: { undecided: 'host', uncertain: 'audit', certain: 'audit' },
  unattended: { undecided: 'deny', uncertain: 'deny' },
};
const MODES = Object.keys(PROFILES);

function rule(id, decision, match, more = {}) {
  return { id, decision, match, why: `why ${id}`, ...more };
}

const CREDENTIALS = rule('credentials', 'deny', { paths: ['~/.ssh/**'], access: 'read' });

function policy(rules = [CREDENTIALS], profiles = PROFILES, extra = {}) {
  return validatePolicy({ version: 1, profiles, branches: { protected: ['main'] }, rules, ...extra });
}

function cmd(argv, more = {}) {
  return {
    argv,
    cwd: ROOT,
    env: {},
    classes: [],
    guessedClasses: [],
    reads: [],
    writes: [],
    domains: [],
    repo: { root: ROOT, branch: 'feature' },
    ops: [],
    ...more,
  };
}

const shell = (command) => ({ host: 'claude', tool: 'Bash', kind: 'shell', cwd: ROOT, command, paths: [] });
const file = (tool, p, access) => ({ host: 'claude', tool, kind: 'file', cwd: ROOT, paths: [{ path: p, access }] });

// One shell call: its raw text and normalized reading.
const sh = (raw, normalized) => ({ call: shell(raw), normalized, raw });
const opaque = (raw, reason, construct) => sh(raw, { opaque: { reason, construct } });

function run(pol, c, profile, more = {}) {
  return evaluate(pol, c.call, c.normalized ?? null, { profile, grants: [], ctx: CTX, raw: c.raw, ...more });
}

// ---- the mode table ------------------------------------------------------------------------------

const NODE_E = opaque('node -e "require(process.argv[1])" x.js', 'unsupported', 'interp-code');
const CAT_UNKNOWN = sh('cat $B', {
  commands: [cmd(['cat', UNKNOWN], { reads: [UNKNOWN], classes: ['env-dump'], guessedClasses: ['env-dump'] })],
});
const CAT_KEY = sh('cat ~/.ssh/id_rsa', { commands: [cmd(['cat', `${HOME}/.ssh/id_rsa`], { reads: [`${HOME}/.ssh/id_rsa`] })] });
const PUSH_MAIN = sh('git push origin main', {
  commands: [
    cmd(['git', 'push', 'origin', 'main'], {
      classes: ['network-fetch', 'vcs-write'],
      domains: ['github.com'],
      repo: { root: ROOT, branch: 'main' },
    }),
  ],
});

// [name, call, rule, wouldDeny category, certain, per mode: 'deny' | 'audit'] — `audit` means undecided
// with one wouldDeny entry (`certain: true` on it for a certain match); `deny` a returned deny (with
// `category` only for an uncertain one).
const TABLE = [
  ['opaque node -e', NODE_E, 'builtin:opaque', 'opaque', false, { default: 'audit', strict: 'deny', relaxed: 'audit', unattended: 'deny' }],
  ['credentials on cat $B (uncertain)', CAT_UNKNOWN, 'credentials', 'rules', false, { default: 'audit', strict: 'deny', relaxed: 'audit', unattended: 'deny' }],
  ['credentials on cat ~/.ssh/id_rsa (certain)', CAT_KEY, 'credentials', 'rules', true, { default: 'deny', strict: 'deny', relaxed: 'audit', unattended: 'deny' }],
  ['protected-branch push (certain)', PUSH_MAIN, 'builtin:protected-branch', 'rules', true, { default: 'deny', strict: 'deny', relaxed: 'audit', unattended: 'deny' }],
];

for (const [name, c, ruleId, category, certain, expected] of TABLE) {
  test(`mode table: ${name}`, () => {
    const pol = policy();
    for (const mode of MODES) {
      const r = run(pol, c, mode);
      const label = `${name} under ${mode}: ${JSON.stringify(r)}`;
      if (expected[mode] === 'deny') {
        assert.equal(r.decision, 'deny', label);
        assert.equal(r.rule, ruleId, label);
        assert.equal(r.floor, undefined, label);
        assert.equal(r.category, certain ? undefined : category, label);
        assert.equal(r.wouldDeny, undefined, label);
      } else {
        assert.equal(r.decision, 'undecided', label);
        assert.equal(r.wouldDeny.length, 1, label);
        assert.equal(r.wouldDeny[0].rule, ruleId, label);
        assert.equal(r.wouldDeny[0].category, category, label);
        assert.equal(r.wouldDeny[0].certain, certain ? true : undefined, label);
        assert.equal(typeof r.wouldDeny[0].reason, 'string', label);
      }
    }
  });
}

test('an audited opaque call names its construct in wouldDeny; constructs wins over opaque', () => {
  const r = run(policy(), NODE_E, 'default');
  assert.deepEqual(Object.keys(r.wouldDeny[0]).sort(), ['category', 'construct', 'reason', 'rule']);
  assert.equal(r.wouldDeny[0].construct, 'interp-code');
  const profiles = {
    ...PROFILES,
    picky: { undecided: 'host', uncertain: { opaque: 'audit', selfProtection: 'audit', rules: 'audit', constructs: { 'interp-code': 'deny' } } },
    lenient: { undecided: 'host', uncertain: { opaque: 'deny', constructs: { 'interp-code': 'audit' } } },
  };
  assert.equal(run(policy([CREDENTIALS], profiles), NODE_E, 'picky').category, 'opaque');
  assert.equal(run(policy([CREDENTIALS], profiles), NODE_E, 'lenient').decision, 'undecided');
  assert.equal(run(policy([CREDENTIALS], profiles), opaque('a <(b)', 'unsupported', 'process-substitution'), 'lenient').decision, 'deny');
});

test('unattended denies an audited call under its undecided action and names the first audited reason', () => {
  const profiles = { ...PROFILES, night: { undecided: 'deny', uncertain: 'audit' } };
  const r = run(policy([CREDENTIALS], profiles), CAT_UNKNOWN, 'night');
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:profile');
  assert.ok(r.reason.includes('why credentials'), r.reason);
  assert.equal(r.wouldDeny.length, 1);
});

// ---- the floor -----------------------------------------------------------------------------------

const POLICY_FILE = `${HOME}/.config/fence/policy.json`;

const FLOOR = [
  [
    'a resolved policy write beside an Unknown root',
    sh(`tee $X ${POLICY_FILE}`, { commands: [cmd(['tee', UNKNOWN, POLICY_FILE], { writes: [UNKNOWN, POLICY_FILE], repo: UNKNOWN })] }),
    'builtin:self-protection',
  ],
  [
    'an uncertain part first, then a resolved policy write',
    sh('echo x > $F; cd ~/.config; echo y > fence/policy.json', {
      commands: [
        cmd(['echo', 'x'], { writes: [UNKNOWN] }),
        cmd(['cd', `${HOME}/.config`], { reads: [`${HOME}/.config`] }),
        cmd(['echo', 'y'], { cwd: `${HOME}/.config`, writes: [POLICY_FILE], repo: null }),
      ],
    }),
    'builtin:self-protection',
  ],
  [
    'claude with an Unknown word',
    sh('claude "$(cat f)" -p hi', { commands: [cmd(['cat', 'f'], { reads: [`${ROOT}/f`] }), cmd(['claude', UNKNOWN, '-p', 'hi'])] }),
    'builtin:host-config',
  ],
  ['unset FENCE_PROFILE', opaque('unset FENCE_PROFILE; claude', 'unsupported', 'host-config-var'), 'builtin:opaque'],
  ['opaque internal', opaque('ls', 'internal', 'error'), 'builtin:opaque'],
  ['opaque size', opaque('ls', 'size', 'command'), 'builtin:opaque'],
  ['opaque depth', opaque('ls', 'depth', 'nesting'), 'builtin:opaque'],
  ['an opaque call naming a switch-off marker', opaque('$(printf rm) -rf ~/.config/fence', 'unknown', 'command-word'), 'builtin:opaque'],
];

for (const [name, c, ruleId] of FLOOR) {
  test(`floor in every mode: ${name}`, () => {
    for (const mode of MODES) {
      const r = run(policy(), c, mode);
      const label = `${name} under ${mode}: ${JSON.stringify(r)}`;
      assert.equal(r.decision, 'deny', label);
      assert.equal(r.rule, ruleId, label);
      assert.equal(r.floor, true, label);
      assert.equal(r.category, undefined, label);
    }
  });
}

test('the switch-off marker floor sets marker', () => {
  const r = run(policy(), opaque('$(printf rm) -rf ~/.config/fence', 'unknown', 'command-word'), 'relaxed');
  assert.equal(typeof r.marker, 'string');
  assert.ok(r.marker.length > 0);
});

test('an unknown profile is a floor deny', () => {
  const r = run(policy(), CAT_KEY, 'nightly');
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:unknown-profile');
  assert.equal(r.floor, true);
});

test('an internal error (modeOf throwing) is a floor deny', () => {
  const c = sh('claude -p x', { commands: [cmd(['claude', '-p', 'x'])] });
  const r = run(policy(), c, 'default', {
    modeOf: () => {
      throw new Error('boom');
    },
  });
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'builtin:internal-error');
  assert.equal(r.floor, true);
});

test('uncertain self-protection: audited in default unless the raw text names a switch-off marker', () => {
  const plain = sh('tee $F', { commands: [cmd(['tee', UNKNOWN], { writes: [UNKNOWN] })] });
  const audited = run(policy(), plain, 'default');
  assert.equal(audited.decision, 'undecided');
  assert.equal(audited.wouldDeny[0].rule, 'builtin:self-protection');
  assert.equal(audited.wouldDeny[0].category, 'selfProtection');
  const strict = run(policy(), plain, 'strict');
  assert.equal(strict.decision, 'deny');
  assert.equal(strict.category, 'selfProtection');
  assert.equal(strict.floor, undefined);

  const named = sh('tee "$(echo ~/.config/fence/policy.json)"', {
    commands: [cmd(['echo', POLICY_FILE]), cmd(['tee', UNKNOWN], { writes: [UNKNOWN] })],
  });
  for (const mode of MODES) {
    const r = run(policy(), named, mode);
    assert.equal(r.decision, 'deny', mode);
    assert.equal(r.rule, 'builtin:self-protection', mode);
    assert.equal(r.floor, true, mode);
    assert.equal(typeof r.marker, 'string', mode);
  }
  // a marker inside a path the normalizer resolved as a read does not count
  const read = sh('cat ~/.zshrc > $F', { commands: [cmd(['cat', `${HOME}/.zshrc`], { reads: [`${HOME}/.zshrc`], writes: [UNKNOWN] })] });
  const r = run(policy(), read, 'default');
  assert.equal(r.decision, 'undecided', JSON.stringify(r));
  assert.equal(r.wouldDeny[0].category, 'selfProtection');
});

// ---- mode escape ---------------------------------------------------------------------------------

const CLAUDE_OTHER = sh('cd /other && claude -p x', { commands: [cmd(['cd', '/other'], { reads: ['/other'] }), cmd(['claude', '-p', 'x'], { cwd: '/other', repo: null })] });
const CLAUDE_MISSING = sh('cd /does-not-exist && claude -p x', {
  commands: [cmd(['cd', '/does-not-exist'], { reads: ['/does-not-exist'] }), cmd(['claude', '-p', 'x'], { cwd: '/does-not-exist', repo: null })],
});
const relaxedOther = (dir) => (dir === '/other' ? 'relaxed' : 'default');

test('mode escape: a host launched into a differently mapped project is a floor deny', () => {
  const r = run(policy(), CLAUDE_OTHER, 'default', { modeOf: relaxedOther });
  assert.equal(r.decision, 'deny', JSON.stringify(r));
  assert.equal(r.floor, true);
  const r2 = run(policy(), CLAUDE_MISSING, 'default', { modeOf: () => null });
  assert.equal(r2.decision, 'deny', JSON.stringify(r2));
  assert.equal(r2.floor, true);
  // codex too, and an Unknown cwd counts as different
  const codex = sh('codex exec x', { commands: [cmd(['codex', 'exec', 'x'], { cwd: UNKNOWN, repo: null })] });
  assert.equal(run(policy(), codex, 'default', { modeOf: () => 'default' }).floor, true);
  // in every mode, against a modeOf that answers a different mode
  for (const mode of MODES) {
    const other = mode === 'relaxed' ? 'strict' : 'relaxed';
    const m = run(policy(), CLAUDE_OTHER, mode, { modeOf: (d) => (d === '/other' ? other : mode) });
    assert.equal(m.floor, true, mode);
  }
});

test('mode escape: the same mode, an omitted modeOf, or FENCE_PROFILE set is not a floor deny', () => {
  const same = run(policy(), CLAUDE_OTHER, 'default', { modeOf: () => 'default' });
  assert.equal(same.decision, 'undecided', JSON.stringify(same));
  assert.equal(run(policy(), CLAUDE_OTHER, 'default').decision, 'undecided');
  const env = { ...CTX, envProfileSet: true };
  for (const [c, modeOf] of [
    [CLAUDE_OTHER, relaxedOther],
    [CLAUDE_MISSING, () => null],
  ]) {
    const r = run(policy(), c, 'default', { modeOf, ctx: env });
    assert.notEqual(r.floor, true, JSON.stringify(r));
    assert.equal(r.decision, 'undecided', JSON.stringify(r));
  }
});

// ---- audit and rule actions ----------------------------------------------------------------------

test('an allow rule never allows a call with an audited deny', () => {
  const readAll = rule('reads', 'allow', { paths: ['/**'], access: 'read' });
  const call = { call: file('Read', `${HOME}/.ssh/id_rsa`, 'read') };
  assert.equal(run(policy([readAll]), call, 'relaxed').decision, 'allow');
  const r = run(policy([CREDENTIALS, readAll]), call, 'relaxed');
  assert.equal(r.decision, 'undecided');
  assert.equal(r.wouldDeny[0].rule, 'credentials');
  // an audited opaque call beside an allowed file part ends undecided too
  const r2 = evaluate(policy([readAll]), { ...shell('node -e x'), paths: [{ path: '/tmp/a', access: 'read' }] }, NODE_E.normalized, {
    profile: 'default',
    ctx: CTX,
    raw: NODE_E.raw,
  });
  assert.equal(r2.decision, 'undecided');
});

test('rules: off skips a rule (no deny, no wouldDeny)', () => {
  const profiles = { ...PROFILES, quiet: { undecided: 'host', rules: { credentials: 'off' } } };
  for (const c of [CAT_KEY, CAT_UNKNOWN]) {
    const r = run(policy([CREDENTIALS], profiles), c, 'quiet');
    assert.equal(r.decision, 'undecided', JSON.stringify(r));
    assert.equal(r.wouldDeny, undefined);
  }
});

test('a rule with decision audit is observe-only unless a mode says deny', () => {
  const watch = rule('watch-ls', 'audit', { argv: [['ls']] });
  const allowLs = rule('ls-ok', 'allow', { argv: [['ls']] });
  const profiles = { ...PROFILES, loud: { undecided: 'host', rules: { 'watch-ls': 'deny' } } };
  const ls = sh('ls', { commands: [cmd(['ls'])] });
  const pol = policy([watch, allowLs], profiles);
  for (const mode of ['default', 'strict', 'relaxed']) {
    const r = run(pol, ls, mode);
    assert.equal(r.decision, 'undecided', `${mode}: ${JSON.stringify(r)}`);
    assert.equal(r.wouldDeny[0].rule, 'watch-ls');
  }
  const loud = run(pol, ls, 'loud');
  assert.equal(loud.decision, 'deny');
  assert.equal(loud.rule, 'watch-ls');
  // a mode override to audit turns a deny rule into observe-only
  const soft = { ...PROFILES, soft: { undecided: 'host', rules: { credentials: 'audit' } } };
  assert.equal(run(policy([CREDENTIALS], soft), CAT_KEY, 'soft').decision, 'undecided');
});

test('wouldDeny is capped at 8 entries', () => {
  const rules = Array.from({ length: 12 }, (_, i) => rule(`watch-${i}`, 'audit', { argv: [['ls']] }));
  const r = run(policy(rules), sh('ls', { commands: [cmd(['ls'])] }), 'default');
  assert.equal(r.decision, 'undecided');
  assert.equal(r.wouldDeny.length, 8);
  assert.equal(r.wouldDeny[0].rule, 'watch-0');
});

// ---- certainty of a rule match -------------------------------------------------------------------

test('a rule match is uncertain when it needed an Unknown, a guessed class or an unresolved placeholder', () => {
  const net = rule('no-net', 'deny', { class: ['network-fetch'] });
  const inRepo = rule('no-repo-notes', 'deny', { paths: ['${repo}/notes.txt'], access: 'any' });
  const pol = policy([net, inRepo]);
  const cases = [
    ['guessed class', sh('rsync $F a b', { commands: [cmd(['rsync', UNKNOWN, 'a', 'b'], { classes: ['network-fetch'], guessedClasses: ['network-fetch'] })] }), 'rules'],
    ['Unknown class', sh('x', { commands: [cmd(['x'], { classes: [UNKNOWN] })] }), 'rules'],
    [
      'a certain part beside an uncertain one is certain',
      sh('rsync $F a b; curl x', {
        commands: [
          cmd(['rsync', UNKNOWN, 'a', 'b'], { classes: ['network-fetch'], guessedClasses: ['network-fetch'] }),
          cmd(['curl', 'x'], { classes: ['network-fetch'] }),
        ],
      }),
      undefined,
    ],
    ['class from an Unknown operand stays certain', sh('open $URL', { commands: [cmd(['open', UNKNOWN], { classes: ['network-fetch'] })] }), undefined],
    ['unresolved ${repo}', sh('cat notes.txt', { commands: [cmd(['cat', '/elsewhere/notes.txt'], { reads: ['/elsewhere/notes.txt'], repo: null, cwd: UNKNOWN })] }), 'rules'],
  ];
  for (const [name, c, category] of cases) {
    const r = run(pol, c, 'strict');
    assert.equal(r.decision, 'deny', `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.category, category, `${name}: ${JSON.stringify(r)}`);
    const d = run(pol, c, 'default');
    assert.equal(d.decision, category === undefined ? 'deny' : 'undecided', `${name} default: ${JSON.stringify(d)}`);
  }
});

test('a protected-branch deny on an Unknown branch is uncertain', () => {
  const c = sh('git commit', { commands: [cmd(['git', 'commit'], { classes: ['vcs-write'], repo: { root: ROOT, branch: UNKNOWN } })] });
  const r = run(policy(), c, 'default');
  assert.equal(r.decision, 'undecided');
  assert.equal(r.wouldDeny[0].rule, 'builtin:protected-branch');
  assert.equal(r.wouldDeny[0].category, 'rules');
  assert.equal(run(policy(), c, 'strict').category, 'rules');
});

// ---- the raw-text host-config net ----------------------------------------------------------------

// Opaque calls whose raw text sets, unsets or clears a host-config name: floor in every mode.
const HOST_CONFIG_FLOOR = [
  // the carry cases
  'FOO+=y; HOME=/x claude',
  'FOO+=y | HOME=/x claude',
  'ARR=(a) ; HOME=x claude',
  'FOO+=y\nHOME=/x claude',
  'FOO+=y env HOME=/x claude',
  'FOO+=y X=$(HOME=1 a) claude',
  'command export HOME=(a)',
  // assignments in assignment position, through wrappers and reserved words
  'FOO+=y; FENCE_PROFILE+=x claude',
  'FOO+=y; XDG_CONFIG_HOME[1]=x',
  'FOO+=y; XDG_DATA_DIRS[1]+=x',
  'FOO+=y; sudo HOME=/x claude',
  'FOO+=y; if true; then HOME=/x claude; fi',
  'FOO+=y; { HOME=/x claude; }',
  'FOO+=y; a `HOME=1 b`',
  // ${NAME=} and ${NAME:=} anywhere
  'FOO+=y; : ${HOME:=/x}; claude',
  'FOO+=y; echo ${CODEX_HOME=/x}',
  // env
  'FOO+=y; env -i claude',
  'FOO+=y; env - claude',
  'FOO+=y; env --ignore-environment claude',
  'FOO+=y; env -u CODEX_HOME claude',
  'FOO+=y; env -uHOME claude',
  'FOO+=y; env -iu HOME claude',
  'FOO+=y; env --unset=CLAUDE_CODE_PLUGIN_DIRS claude',
  'FOO+=y; env -u FOO -i claude',
  'FOO+=y; env -C /tmp -i claude',
  'FOO+=y; env -u $X claude',
  'FOO+=y; nohup env -i claude',
  // exec
  'FOO+=y; exec -c claude',
  'FOO+=y; exec -cl claude',
  'FOO+=y; exec -a x -c claude',
  // builtins that assign, unset or export a named variable
  'FOO+=y; read HOME; claude',
  'FOO+=y; read -r XDG_CONFIG_HOME < f; claude',
  'FOO+=y; read HOME<f; claude',
  'FOO+=y; read HOME<<<x; claude',
  'FOO+=y; mapfile -t HOME<f',
  'FOO+=y; mapfile CODEX_HOME < f; claude',
  'FOO+=y; readarray -t FENCE_PROFILE < f; claude',
  'FOO+=y; getopts ab HOME; claude',
  'FOO+=y; printf -v HOME %s /x; claude',
  'FOO+=y; printf -vHOME %s /x; claude',
  'FOO+=y; for HOME in /x; do claude; done',
  'FOO+=y; select HOME in a; do claude; done',
  'FOO+=y; unset CLAUDE_CONFIG_DIR',
  'FOO+=y; unset -v FOO HOME',
  'FOO+=y; export HOME',
  'FOO+=y; export $X',
  'FOO+=y; typeset HOME=1',
  'FOO+=y; local XDG_STATE_HOME',
  'FOO+=y; readonly HOME',
  'FOO+=y; declare -n r=HOME; r=/x claude',
  'FOO+=y; let HOME=1',
  // nested shell text: eval, sh -c and friends, env -S
  'FOO+=y; eval HOME=/x claude',
  'FOO+=y; bash -c "HOME=/x claude"',
  "FOO+=y; sh -c 'unset HOME; claude'",
  'FOO+=y; bash -lc "HOME=/x claude"',
  "FOO+=y; zsh -c 'export HOME=/x'",
  'FOO+=y; env -S "HOME=/x claude"',
  'FOO+=y; env -SHOME=/x claude',
  'FOO+=y; eval bash -c "env -i claude"',
  // braces and redirections
  'FOO+=y; function f { HOME=/x claude; }',
  'FOO+=y; 2>&1 HOME=/x claude',
  'FOO+=y; 0<&3 HOME=/x claude',
  // more wrappers
  'FOO+=y; xargs -I{} env -i claude',
  'FOO+=y; xargs -n 1 env -i claude',
  'FOO+=y; timeout 5 env -i claude',
  'FOO+=y; timeout -s KILL 5 env -i claude',
  'FOO+=y; setsid env -i claude',
  'FOO+=y; stdbuf -oL env -i claude',
  // a command word written as a path, or with a leading backslash
  'FOO+=y; /usr/bin/env -i claude',
  'FOO+=y; /bin/bash -c "HOME=/x claude"',
  'FOO+=y; /usr/bin/sudo HOME=/x claude',
  'FOO+=y; /usr/bin/eval HOME=/x claude',
  'FOO+=y; /bin/export HOME=/x',
  'FOO+=y; \\env -i claude',
  // shell options that take a value word
  'FOO+=y; bash --rcfile /dev/null -c "HOME=/x claude"',
  'FOO+=y; bash --init-file /dev/null -c "HOME=/x claude"',
  'FOO+=y; bash -O extglob -c "HOME=/x claude"',
  'FOO+=y; bash +O extglob -c "HOME=/x claude"',
  // find's -exec / -execdir / -ok / -okdir commands
  'FOO+=y; find . -exec env -i claude {} +',
  'FOO+=y; find . -execdir env -i claude {} \\;',
  'FOO+=y; find . -ok HOME=/x claude ;',
  'FOO+=y; find . -name x -okdir unset HOME +',
  'FOO+=y; find . -exec ls {} \\; -exec env -i claude {} \\;',
  'FOO+=y; /usr/bin/find . -exec env -i claude {} +',
];

// Opaque calls that only mention a name, read it, or set another one: audited in default.
const HOST_CONFIG_CONTROLS = [
  'node -e "require(process.argv[1])" x.js',
  'node -e "x" $HOME',
  'echo $HOME; node -e "x"',
  'FOO+=y; MYHOME=1 a',
  'FOO+=y; sort -u HOME.txt',
  'FOO+=y; echo ${HOME[0]}',
  'FOO+=y; grep read HOME.txt',
  'FOO+=y; grep read HOME',
  'FOO+=y; echo "for HOME"',
  'FOO+=y; echo HOME=1',
  'FOO+=y; printf %s HOME',
  'FOO+=y; read x <HOME',
  'FOO+=y; env FOO=1 claude',
  'FOO+=y; env -u FOO claude',
  'FOO+=y; exec claude',
  'FOO+=y; declare -n r=OTHER',
  'FOO+=y; bash -c "echo hi"',
  'FOO+=y; eval echo HOME',
  'FOO+=y; xargs grep read HOME',
  'FOO+=y; timeout 5 echo HOME',
  'FOO+=y; /usr/bin/env FOO=1 ls',
  'FOO+=y; /bin/bash -c "echo hi"',
  'FOO+=y; bash --rcfile /dev/null -c "echo HOME"',
  'FOO+=y; find . -exec grep HOME {} +',
  'FOO+=y; find HOME -name x',
];

for (const text of HOST_CONFIG_FLOOR) {
  test(`host-config net, floor: ${JSON.stringify(text)}`, () => {
    for (const mode of ['default', 'relaxed']) {
      const r = run(policy(), opaque(text, 'unsupported', 'append-assign'), mode);
      assert.equal(r.decision, 'deny', `${mode}: ${JSON.stringify(r)}`);
      assert.equal(r.floor, true, mode);
    }
  });
}

for (const text of HOST_CONFIG_CONTROLS) {
  test(`host-config net, control: ${JSON.stringify(text)}`, () => {
    const r = run(policy(), opaque(text, 'unsupported', 'interp-code'), 'default');
    assert.equal(r.decision, 'undecided', JSON.stringify(r));
    assert.equal(r.wouldDeny[0].category, 'opaque');
  });
}

test('the host-config net scans 32 KiB of text in under 200 ms', () => {
  // [unit, decision]: nesting deeper than the scanner follows can not be checked, so it is a floor deny
  for (const [unit, decision] of [
    ['declare -n x ', 'undecided'],
    ['read x ', 'undecided'],
    ['bash -c "echo hi" ', 'undecided'],
    ['bash -c ', 'deny'],
    ['eval bash -c ', 'deny'],
    ['/bin/bash -c "echo hi" ', 'undecided'],
    ['/bin/bash -c ', 'deny'],
    ['/usr/bin/env FOO=1 ', 'undecided'],
    ['find . -exec echo {} + ', 'undecided'],
    ['find . -exec echo + ', 'undecided'],
    ['find . -exec ', 'deny'],
  ]) {
    const raw = `FOO+=y; ${unit.repeat(Math.ceil((32 * 1024) / unit.length))}`;
    const t0 = performance.now();
    const r = run(policy(), opaque(raw, 'unsupported', 'append-assign'), 'default');
    const ms = performance.now() - t0;
    assert.equal(r.decision, decision, unit);
    assert.ok(ms < 200, `${JSON.stringify(unit)}: ${ms.toFixed(1)} ms`);
  }
});

test('an opaque call without its raw text is a floor deny (the text can not be checked)', () => {
  for (const mode of MODES) {
    const r = evaluate(policy(), shell('node -e x'), NODE_E.normalized, { profile: mode, grants: [], ctx: CTX });
    assert.equal(r.decision, 'deny', `${mode}: ${JSON.stringify(r)}`);
    assert.equal(r.rule, 'builtin:opaque', mode);
    assert.equal(r.floor, true, mode);
    assert.ok(r.reason.includes('interp-code'), r.reason);
  }
});

test('a returned deny lists the audited denies met before it', () => {
  const c = { call: { ...shell('node -e x'), paths: [{ path: `${HOME}/.ssh/id_rsa`, access: 'read' }] }, normalized: NODE_E.normalized, raw: NODE_E.raw };
  const r = run(policy(), c, 'default');
  assert.equal(r.decision, 'deny', JSON.stringify(r));
  assert.equal(r.rule, 'credentials');
  assert.equal(r.wouldDeny.length, 1);
  assert.equal(r.wouldDeny[0].rule, 'builtin:opaque');
  assert.equal(r.wouldDeny[0].category, 'opaque');
});

test('mode escape: codex through a wrapper the normalizer unwraps', () => {
  // the real normalizer's reading (cwd and home are never read: neither exists)
  for (const raw of ['env codex exec x', 'sudo codex exec x']) {
    const normalized = normalize(raw, { cwd: ROOT, home: HOME, env: {} });
    assert.equal(normalized.commands.at(-1).argv[0], 'codex', raw);
    const c = { call: shell(raw), normalized, raw };
    const r = run(policy(), c, 'default', { modeOf: (d) => (d === ROOT ? 'relaxed' : 'default') });
    assert.equal(r.decision, 'deny', `${raw}: ${JSON.stringify(r)}`);
    assert.equal(r.rule, 'builtin:mode-escape', raw);
    assert.equal(r.floor, true, raw);
    assert.notEqual(run(policy(), c, 'default', { modeOf: () => 'default' }).floor, true, raw);
  }
});

test('a policy without the new keys denies uncertain calls as before', () => {
  const old = validatePolicy({ version: 1, profiles: { default: { undecided: 'host' } }, rules: [CREDENTIALS] });
  assert.equal(run(old, NODE_E, 'default').decision, 'deny');
  assert.equal(run(old, CAT_UNKNOWN, 'default').decision, 'deny');
  assert.equal(run(old, CAT_KEY, 'default').decision, 'deny');
});
