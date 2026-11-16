import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evalsCheckout, evalsNotice } from '../cli/lib/eval-notice.mjs';
import { sessionContext } from '../cli/drift.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const R1 = '2026-11-15T100000Z.json';
const R2 = '2026-11-16T100000Z.json';

function withEvals(fn) {
  const base = mkdtempSync(join(tmpdir(), 'cm-notice-'));
  try {
    const evals = join(base, 'evals');
    mkdirSync(join(evals, 'rounds'), { recursive: true });
    return fn(evals, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const report = (evals, name, body) => writeFileSync(join(evals, 'rounds', name), typeof body === 'string' ? body : JSON.stringify(body));
const revisions = (evals, lines) => writeFileSync(join(evals, 'revisions.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

test('a report with two judges to revise gives the line with the count and the ids', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x', 'y'] });
    assert.equal(evalsNotice({ evals }), 'evals: 2 judge(s) below the bar (x, y): run methodology:improving-evals');
  });
});

test('a revision line for x in that round leaves y pending', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x', 'y'] });
    revisions(evals, [{ round: R1, category: 'x', kept: true }]);
    assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (y): run methodology:improving-evals');
  });
});

test('a revision line for a different round does not count', () => {
  withEvals((evals) => {
    report(evals, R2, { revise: ['x'] });
    revisions(evals, [{ round: R1, category: 'x' }]);
    assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (x): run methodology:improving-evals');
  });
});

test('lines for both judges give null', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x', 'y'] });
    revisions(evals, [{ round: R1, category: 'x' }, { round: R1, category: 'y' }]);
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('an empty revise, a missing directory, a file that is not JSON and a revise that is a string give null', () => {
  withEvals((evals, base) => {
    report(evals, R1, { revise: [] });
    assert.equal(evalsNotice({ evals }), null);
    assert.equal(evalsNotice({ evals: join(base, 'missing') }), null);
    report(evals, R2, 'not json');
    assert.equal(evalsNotice({ evals }), null);
    report(evals, R2, { revise: 'x' });
    assert.equal(evalsNotice({ evals }), null);
    report(evals, R2, { revise: ['x', 3] });
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('a rounds directory with no file gives null', () => {
  withEvals((evals) => {
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('with two reports only the one whose name sorts last counts', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['old'] });
    report(evals, R2, { revise: ['new'] });
    assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (new): run methodology:improving-evals');
    report(evals, '2026-11-17T100000Z.json', { revise: [] });
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('failed steps with nothing to revise give the failed-steps line with the report path', () => {
  withEvals((evals) => {
    report(evals, R2, { failed: ['propose'], revise: [] });
    assert.equal(evalsNotice({ evals }), `evals: the last round had failed steps (propose): see ${join(evals, 'rounds', R2)}`);
  });
});

test('failed steps and a pending judge give both lines, the failed-steps line first', () => {
  withEvals((evals) => {
    report(evals, R2, { failed: ['review sample', 'judge x'], revise: ['x'] });
    assert.equal(
      evalsNotice({ evals }),
      `evals: the last round had failed steps (review sample, judge x): see ${join(evals, 'rounds', R2)}\nevals: 1 judge(s) below the bar (x): run methodology:improving-evals`,
    );
  });
});

test('failed steps with a revise that is not an array still announce the failure', () => {
  withEvals((evals) => {
    report(evals, R2, { failed: ['referee'], revise: 'x' });
    assert.match(evalsNotice({ evals }), /^evals: the last round had failed steps \(referee\)/);
  });
});

test('an empty failed, or one that is not an array of strings, adds nothing', () => {
  withEvals((evals) => {
    for (const failed of [[], 'propose', ['propose', 2], { a: 1 }, null]) {
      report(evals, R2, { failed, revise: ['x'] });
      assert.equal(evalsNotice({ evals }), 'evals: 1 judge(s) below the bar (x): run methodology:improving-evals');
      report(evals, R2, { failed, revise: [] });
      assert.equal(evalsNotice({ evals }), null);
    }
  });
});

test('a revisions file that is not JSON on every line does not throw', () => {
  withEvals((evals) => {
    report(evals, R1, { revise: ['x'] });
    writeFileSync(join(evals, 'revisions.jsonl'), 'garbage\n{"round":"' + R1 + '","category":"x"}\n');
    assert.equal(evalsNotice({ evals }), null);
  });
});

test('no argument at all gives null instead of throwing', () => {
  assert.equal(evalsNotice(), null);
  assert.equal(evalsNotice({}), null);
});

const JUDGES = join('plugins', 'methodology', 'evals', 'judges');
const LINE = 'evals: 1 judge(s) below the bar (x): run methodology:improving-evals';
const FAILED_LINE = (evals) => `evals: the last round had failed steps (propose): see ${join(evals, 'rounds', R2)}`;

// A temp tree: <base>/home (with .claude and the CLI shim), <base>/repo (a checkout), <base>/other (not a checkout),
// <base>/evals/rounds. fn gets { home, evals, repo, other, base }.
function withTree(fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-checkout-')));
  try {
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'triqual.mjs'), '// The `triqual` shim.\n');
    const repo = join(base, 'repo');
    mkdirSync(join(repo, JUDGES), { recursive: true });
    mkdirSync(join(repo, 'plugins', 'methodology', 'cli'), { recursive: true });
    const other = join(base, 'other');
    mkdirSync(other);
    const evals = join(base, 'evals');
    mkdirSync(join(evals, 'rounds'), { recursive: true });
    return fn({ home, evals, repo, other, base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('evalsCheckout gives the root for the root itself and for a nested directory', () => {
  withTree(({ home, repo }) => {
    assert.equal(evalsCheckout(repo, home), repo);
    assert.equal(evalsCheckout(join(repo, 'plugins', 'methodology', 'cli'), home), repo);
  });
});

test('evalsCheckout gives null for a directory outside any checkout', () => {
  withTree(({ home, other, base }) => {
    assert.equal(evalsCheckout(other, home), null);
    assert.equal(evalsCheckout(base, home), null);
  });
});

test('evalsCheckout gives null for a tree under the harness plugin directories of the home', () => {
  withTree(({ home }) => {
    for (const parts of [['.claude', 'plugins', 'marketplaces', 'x'], ['.claude', 'plugins', 'cache', 'x', 'y'], ['.codex', '.tmp', 'marketplaces', 'x']]) {
      const root = join(home, ...parts);
      mkdirSync(join(root, JUDGES), { recursive: true });
      mkdirSync(join(root, 'plugins', 'methodology', 'cli'), { recursive: true });
      assert.equal(evalsCheckout(root, home), null, root);
      assert.equal(evalsCheckout(join(root, 'plugins', 'methodology', 'cli'), home), null, root);
    }
  });
});

test('evalsCheckout is not defeated by a symlinked home', () => {
  withTree(({ home, base }) => {
    const link = join(base, 'home-link');
    symlinkSync(home, link);
    const root = join(home, '.claude', 'plugins', 'marketplaces', 'x');
    mkdirSync(join(root, JUDGES), { recursive: true });
    assert.equal(evalsCheckout(root, link), null);
    assert.equal(evalsCheckout(join(link, '.claude', 'plugins', 'marketplaces', 'x'), home), null);
  });
});

test('evalsCheckout gives null for a non-string and for a path that does not exist', () => {
  withTree(({ home, base }) => {
    for (const dir of [undefined, null, 3, {}, ['a'], '']) assert.equal(evalsCheckout(dir, home), null);
    assert.equal(evalsCheckout(join(base, 'missing', 'dir'), home), null);
    assert.equal(evalsCheckout(join(base, 'repo'), undefined), join(base, 'repo'));
  });
});

const context = ({ home, evals }, extra) => sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'resume', env: { TRIQUAL_EVALS_DIR: evals }, ...extra });

test('sessionContext contains the notice line once when cwd is inside a checkout', () => {
  withTree((t) => {
    report(t.evals, R1, { revise: ['x'] });
    for (const harness of [null, 'codex']) {
      for (const cwd of [t.repo, join(t.repo, 'plugins', 'methodology', 'cli')]) {
        const out = context(t, { harness, cwd });
        assert.ok(out.includes(LINE));
        assert.equal(out.split(LINE).length, 2);
      }
    }
  });
});

test('sessionContext has no evals text when cwd is another directory, absent or inside a plugin directory', () => {
  withTree((t) => {
    report(t.evals, R1, { revise: ['x'] });
    const cache = join(t.home, '.claude', 'plugins', 'marketplaces', 'triqual');
    const codex = join(t.home, '.codex', '.tmp', 'marketplaces', 'triqual');
    for (const root of [cache, codex]) mkdirSync(join(root, JUDGES), { recursive: true });
    for (const harness of [null, 'codex']) {
      for (const cwd of [t.other, undefined, null, cache, codex, join(t.base, 'missing')]) {
        const out = context(t, { harness, cwd });
        assert.ok(!/evals:/.test(out ?? ''), `${harness} ${cwd}`);
      }
    }
  });
});

test('the failed-steps line is gated the same way', () => {
  withTree((t) => {
    report(t.evals, R2, { failed: ['propose'], revise: [] });
    assert.ok(context(t, { cwd: t.repo }).includes(FAILED_LINE(t.evals)));
    assert.ok(context(t, { harness: 'codex', cwd: t.repo }).includes(FAILED_LINE(t.evals)));
    for (const cwd of [t.other, undefined]) {
      assert.ok(!/evals:/.test(context(t, { cwd }) ?? ''));
      assert.ok(!/evals:/.test(context(t, { harness: 'codex', cwd }) ?? ''));
    }
  });
});

test('sessionContext with nothing to revise has no evals line and equals the output for a missing directory', () => {
  withTree((t) => {
    report(t.evals, R1, { revise: [] });
    const withReport = context(t, { source: 'startup', cwd: t.repo });
    assert.ok(!/^evals:/m.test(withReport ?? ''));
    assert.equal(withReport, context({ ...t, evals: join(t.base, 'does-not-exist') }, { source: 'startup', cwd: t.repo }));
  });
});

test('the entry point reads cwd from the stdin payload: the line in a checkout, none elsewhere', () => {
  withTree((t) => {
    report(t.evals, R1, { revise: ['x'] });
    const { CLAUDE_PLUGIN_DATA: _, XDG_CONFIG_HOME: __, ...env } = process.env;
    const run = (input, args = []) => {
      const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'cli', 'drift.mjs'), ...args], {
        env: { ...env, HOME: t.home, TRIQUAL_EVALS_DIR: t.evals }, input, encoding: 'utf8', cwd: t.other,
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout === '' ? '' : JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    };
    assert.ok(run(JSON.stringify({ source: 'resume', cwd: t.repo })).includes(LINE));
    assert.ok(run(JSON.stringify({ source: 'resume', cwd: t.repo }), ['--harness', 'codex']).includes(LINE));
    assert.ok(!/^evals:/m.test(run(JSON.stringify({ source: 'resume', cwd: t.other }))));
    assert.ok(!/^evals:/m.test(run(JSON.stringify({ source: 'resume', cwd: t.other }), ['--harness', 'codex'])));
    // No cwd in the payload (or no payload): the process's own working directory decides; it is not a checkout here.
    assert.ok(!/^evals:/m.test(run(JSON.stringify({ source: 'resume' }))));
    assert.ok(!/^evals:/m.test(run(''))); // startup: the skill's own text mentions `evals:`, mid-line
  });
});
