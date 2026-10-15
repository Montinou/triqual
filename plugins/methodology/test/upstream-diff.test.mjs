// `triqual upstream-diff` (spec Addendum E.6). Every case runs in a temp git repo holding a copy of plugins/methodology/
// (upstream.json, the real FORK.md, skills/), with upstream releases served from local fixture tarballs built by
// `git archive` (so each carries the pax commit header codeload serves). No case touches the network or this repo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paxCommit, run, tarballUrl, upstreamDiff } from '../cli/upstream-diff.mjs';
import { writeAtomic } from '../cli/lib/fsx.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PLUGIN, 'cli', 'upstream-diff.mjs');
const FORK_MD = readFileSync(join(PLUGIN, 'FORK.md'), 'utf8');

const temps = [];
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// git without GIT_* (a hook run exports GIT_DIR, GIT_INDEX_FILE, …) and without XDG_CONFIG_HOME.
const gitEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  delete env.XDG_CONFIG_HOME;
  return env;
};
const IDENTITY = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false'];
const git = (cwd, args, opts = {}) =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, env: gitEnv(), encoding: 'utf8', ...opts });
const gitStatus = (cwd, args, opts = {}) =>
  spawnSync('git', [...IDENTITY, ...args], { cwd, env: gitEnv(), encoding: 'utf8', ...opts });

// ---- fixture upstream releases -------------------------------------------------------------------------------------

const body = (tag, n = 12) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';
const setLine = (text, line, value) => {
  const lines = text.split('\n');
  lines[line - 1] = value;
  return lines.join('\n');
};

const V642 = {
  'brainstorming/SKILL.md': body('brainstorming'),
  'brainstorming/visual-companion.md': body('companion'),
  'finishing-a-development-branch/SKILL.md': body('finishing'),
  'using-superpowers/SKILL.md': body('using'),
  'using-superpowers/references/gemini-tools.md': body('gemini'),
  'requesting-code-review/code-reviewer.md': body('reviewer'),
  'subagent-driven-development/SKILL.md': body('sdd'),
  'subagent-driven-development/task-reviewer-prompt.md': body('task-reviewer'),
  'dropped-skill/SKILL.md': body('dropped'), // vendored, then removed from the fork as a whole skill
};
const V643 = {
  ...V642,
  'brainstorming/SKILL.md': setLine(V642['brainstorming/SKILL.md'], 6, 'brainstorming 6 (6.4.3)'),
  'finishing-a-development-branch/SKILL.md': setLine(V642['finishing-a-development-branch/SKILL.md'], 6,
    'finishing 6 (6.4.3)'),
  'using-superpowers/references/gemini-tools.md': setLine(V642['using-superpowers/references/gemini-tools.md'], 6,
    'gemini 6 (6.4.3)'),
  'new-skill/SKILL.md': body('new-skill'),
  'brainstorming/interim.md': body('interim'), // added after the vendored 6.4.2, deleted again in 6.4.4
};
const V644 = (() => {
  const files = {
    ...V643,
    'finishing-a-development-branch/SKILL.md': setLine(V643['finishing-a-development-branch/SKILL.md'], 10,
      'finishing 10 (6.4.4)'),
    'requesting-code-review/code-reviewer.md': setLine(V643['requesting-code-review/code-reviewer.md'], 6,
      'reviewer 6 (6.4.4)'),
    'brainstorming/companion.md': V643['brainstorming/visual-companion.md'],
  };
  delete files['brainstorming/visual-companion.md'];
  delete files['brainstorming/interim.md'];
  return files;
})();
// 6.4.5: a new file under the skill the fork dropped, plus one unrelated change in a forked skill.
const V645 = {
  ...V644,
  'dropped-skill/extra.md': body('dropped-extra'),
  'brainstorming/SKILL.md': setLine(V644['brainstorming/SKILL.md'], 11, 'brainstorming 11 (6.4.5)'),
};
// 6.4.6: a file whose path a patch header would have to quote.
const V646 = { ...V645, 'brainstorming/odd name.md': body('odd') };
const RELEASES = { '6.4.2': V642, '6.4.3': V643, '6.4.4': V644, '6.4.5': V645, '6.4.6': V646 };

// One upstream repo with a tag per release, archived the way codeload serves it: tar.gz, `superpowers-<v>/` prefix,
// pax global header carrying the commit.
const UPSTREAM = (() => {
  const repo = temp('cm-ud-upstream-');
  git(repo, ['init', '-q', '-b', 'main']);
  const tarballs = {};
  const commits = {};
  for (const [version, files] of Object.entries(RELEASES)) {
    rmSync(join(repo, 'skills'), { recursive: true, force: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, 'skills', path)), { recursive: true });
      writeFileSync(join(repo, 'skills', path), text);
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `release ${version}`]);
    git(repo, ['tag', `v${version}`]);
    commits[version] = git(repo, ['rev-parse', `v${version}^{commit}`]).trim();
    tarballs[version] = execFileSync('git', ['archive', '--format=tar.gz', `--prefix=superpowers-${version}/`,
      `v${version}`], { cwd: repo, env: gitEnv() });
  }
  return { tarballs, commits };
})();

// fetchTarball over the fixtures; records every version asked for.
const fetcher = (calls = []) => async (version) => {
  calls.push(version);
  const buffer = UPSTREAM.tarballs[version];
  return buffer ? { buffer, commit: paxCommit(buffer) } : null;
};

// ---- fixture fork clone --------------------------------------------------------------------------------------------

const RENAMES = {
  'using-superpowers/': 'using-methodology/',
  'diagnosing-superpowers/': 'diagnosing-methodology/',
  'finishing-a-development-branch/': 'finishing-branch/',
};
const forkPath = (path) => {
  for (const [from, to] of Object.entries(RENAMES)) if (path.startsWith(from)) return to + path.slice(from.length);
  return path;
};
const REMOVED = new Set(['using-superpowers/references/gemini-tools.md']);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// A git repo holding plugins/methodology/ as the fork looks at release `at`: upstream's files under their fork
// names, minus the removed ones, plus the two derived templates; `edits` maps a fork path to [line, text] edits
// (every fork file when `editAll`). Everything is committed.
function makeClone({ at = '6.4.2', reviewed = at, edits = {}, editAll = false } = {}) {
  const root = temp('cm-ud-clone-');
  git(root, ['init', '-q', '-b', 'main']);
  const plugin = join(root, 'plugins', 'methodology');
  const files = {};
  for (const [path, text] of Object.entries(RELEASES[at])) {
    if (REMOVED.has(path) || path.startsWith('new-skill/') || path.startsWith('dropped-skill/')
      || path === 'brainstorming/interim.md') continue;
    files[forkPath(path)] = text;
  }
  files['subagent-driven-development/final-review-prompt.md'] = setLine(
    RELEASES[at]['requesting-code-review/code-reviewer.md'], 2, 'adapted for roles:final-adversarial-reviewer');
  files['subagent-driven-development/safety-review-prompt.md'] = setLine(
    RELEASES[at]['subagent-driven-development/task-reviewer-prompt.md'], 2, 'adapted for roles:safety-reviewer');
  for (const path of Object.keys(files)) {
    const list = editAll ? [[3, `${path} line 3 (fork)`]] : edits[path] ?? [];
    for (const [line, text] of list) files[path] = setLine(files[path], line, text);
    mkdirSync(dirname(join(plugin, 'skills', path)), { recursive: true });
    writeFileSync(join(plugin, 'skills', path), files[path]);
  }
  const upstream = {
    source: 'https://github.com/obra/superpowers',
    vendored: {
      version: '6.4.2',
      tag: 'v6.4.2',
      commit: UPSTREAM.commits['6.4.2'],
      files: Object.fromEntries(Object.entries(V642).map(([path, text]) => [path, sha256(text)])),
    },
    reviewed: { version: reviewed, commit: UPSTREAM.commits[reviewed], reviewedAt: '2026-09-28' },
  };
  writeFileSync(join(plugin, 'upstream.json'), JSON.stringify(upstream, null, 2) + '\n');
  writeFileSync(join(plugin, 'FORK.md'), FORK_MD);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fork']);
  return { root, plugin, upstreamJson: join(plugin, 'upstream.json'), forkMd: join(plugin, 'FORK.md') };
}

const snapshot = (...paths) => paths.map((p) => readFileSync(p));
// Every file under dir with its bytes and mode, for "nothing changed" checks.
const tree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = [statSync(p).mode, readFileSync(p).toString('base64')];
    }
  };
  walk(dir);
  return out;
};

const diff = (clone, opts = {}) =>
  upstreamDiff({ cwd: clone.root, fetchTarball: fetcher(), now: new Date(2026, 9, 1, 12), ...opts });

const applyPatch = (root, patch) => gitStatus(root, ['apply', '--3way', '-'], { input: patch });
const indexShas = (patch) =>
  [...patch.matchAll(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/gm)].map((m) => m[1]);
const ZERO = '0'.repeat(40);
// The indented lines under one skill's header line in the stat summary.
const section = (out, header) => {
  const lines = out.split('\n');
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith('  '));
  return end === -1 ? rest : rest.slice(0, end);
};

// ---- tarballs ------------------------------------------------------------------------------------------------------

test('tarballs come from codeload by tag, and the commit from the pax header', () => {
  assert.equal(tarballUrl('6.4.3'), 'https://codeload.github.com/obra/superpowers/tar.gz/refs/tags/v6.4.3');
  assert.equal(paxCommit(UPSTREAM.tarballs['6.4.3']), UPSTREAM.commits['6.4.3']);
});

// ---- stat, --from, --skill, --full ---------------------------------------------------------------------------------

test('a stat summary per forked skill between two fixture tarballs', async () => {
  const clone = makeClone();
  const r = await diff(clone, { version: '6.4.3' });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'superpowers 6.4.2 → 6.4.3');
  assert.ok(lines.includes('brainstorming'), r.out);
  assert.ok(lines.includes('finishing-branch  (upstream finishing-a-development-branch)'), r.out);
  assert.ok(lines.includes('  SKILL.md  +1 -1'), r.out);
  assert.ok(lines.includes('using-methodology  (upstream using-superpowers)'), r.out);
  assert.ok(lines.includes('  references/gemini-tools.md  +1 -1  (removed in the fork)'), r.out);
  assert.doesNotMatch(r.out, /^finishing-a-development-branch/m);
  assert.doesNotMatch(r.out, /new-skill/, 'a new upstream skill is not a forked skill');
  assert.match(r.err, /new upstream skill new-skill/);
});

test("--from defaults to upstream.json's reviewed.version", async () => {
  const clone = makeClone({ at: '6.4.3', reviewed: '6.4.3' });
  const calls = [];
  const r = await diff(clone, { version: '6.4.4', fetchTarball: fetcher(calls) });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls.sort(), ['6.4.3', '6.4.4']);
  assert.equal(r.out.split('\n')[0], 'superpowers 6.4.3 → 6.4.4');
  assert.match(r.out, /^finishing-branch {2}\(upstream finishing-a-development-branch\)$/m);
  assert.deepEqual(section(r.out, 'finishing-branch  (upstream finishing-a-development-branch)'), ['  SKILL.md  +1 -1']);
  // brainstorming/SKILL.md and gemini-tools.md changed only in 6.4.2 → 6.4.3: absent here.
  assert.ok(!section(r.out, 'brainstorming').some((l) => l.startsWith('  SKILL.md')), r.out);
  assert.doesNotMatch(r.out, /gemini/);
});

test('--skill finishing-branch maps to the upstream name', async () => {
  const clone = makeClone();
  for (const skill of ['finishing-branch', 'finishing-a-development-branch']) {
    const r = await diff(clone, { version: '6.4.3', skill });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^finishing-branch {2}\(upstream finishing-a-development-branch\)$/m);
    assert.doesNotMatch(r.out, /^brainstorming$/m);
    assert.doesNotMatch(r.out, /gemini/);
  }
  const full = await diff(clone, { version: '6.4.3', skill: 'finishing-branch', mode: 'full' });
  assert.match(full.out, /^diff --git a\/skills\/finishing-a-development-branch\/SKILL\.md /m);
  assert.doesNotMatch(full.out, /skills\/brainstorming/);
});

test('--full prints unified diffs', async () => {
  const clone = makeClone();
  const r = await diff(clone, { version: '6.4.3', mode: 'full' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^diff --git a\/skills\/brainstorming\/SKILL\.md b\/skills\/brainstorming\/SKILL\.md$/m);
  assert.match(r.out, /^--- a\/skills\/brainstorming\/SKILL\.md$/m);
  assert.match(r.out, /^\+\+\+ b\/skills\/brainstorming\/SKILL\.md$/m);
  assert.match(r.out, /^@@ /m);
  assert.match(r.out, /^-brainstorming 6$/m);
  assert.match(r.out, /^\+brainstorming 6 \(6\.4\.3\)$/m);
});

// ---- the fork is the cwd's clone -----------------------------------------------------------------------------------

test('outside a clone of the fork exits 2', async (t) => {
  // An installed plugin root: upstream.json and FORK.md, but not a git toplevel of a clone.
  const home = temp('cm-ud-home-');
  const installed = join(home, '.claude', 'plugins', 'cache', 'triqual', 'methodology', '0.2.0');
  const source = makeClone();
  cpSync(source.plugin, installed, { recursive: true });
  const before = tree(installed);
  const other = temp('cm-ud-other-');
  git(other, ['init', '-q', '-b', 'main']);
  for (const [name, cwd] of [['a repo without plugins/methodology/upstream.json', other],
    ['outside any repo (the installed root)', installed]]) {
    await t.test(name, async () => {
      const calls = [];
      const r = await upstreamDiff({
        version: '6.4.3', cwd, markReviewed: 'reviewed', fetchTarball: fetcher(calls), now: new Date(),
      });
      assert.equal(r.code, 2);
      assert.equal(r.out, '');
      assert.match(r.err, /run triqual upstream-diff from a clone of triqual/);
      assert.equal(r.err.trimEnd().split('\n').length, 1);
      assert.deepEqual(calls, []);
    });
  }
  assert.deepEqual(tree(installed), before);
});

// ---- --patch -------------------------------------------------------------------------------------------------------

test('--patch maps paths to fork names and applies with git apply --3way', async () => {
  // One local adaptation two lines above upstream's change: the direct apply fails, the three-way merge succeeds.
  const clone = makeClone({ edits: { 'finishing-branch/SKILL.md': [[3, 'finishing 3 (fork)']] } });
  const r = await diff(clone, { version: '6.4.3', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out,
    /^diff --git a\/plugins\/methodology\/skills\/finishing-branch\/SKILL\.md b\/plugins\/methodology\/skills\/finishing-branch\/SKILL\.md$/m);
  assert.match(r.out, /^--- a\/plugins\/methodology\/skills\/finishing-branch\/SKILL\.md$/m);
  assert.match(r.out, /^\+\+\+ b\/plugins\/methodology\/skills\/finishing-branch\/SKILL\.md$/m);
  assert.doesNotMatch(r.out, /finishing-a-development-branch/);
  assert.doesNotMatch(r.out, /^diff --git a\/skills\//m);
  assert.notEqual(gitStatus(clone.root, ['apply', '--check', '-'], { input: r.out }).status, 0,
    'the direct apply must fail, so the three-way path is what applies it');
  const applied = applyPatch(clone.root, r.out);
  assert.equal(applied.status, 0, applied.stderr);
  const text = readFileSync(join(clone.plugin, 'skills', 'finishing-branch', 'SKILL.md'), 'utf8');
  assert.match(text, /^finishing 3 \(fork\)$/m, 'the local adaptation is kept');
  assert.match(text, /^finishing 6 \(6\.4\.3\)$/m, "upstream's change landed under the fork name");
  assert.match(readFileSync(join(clone.plugin, 'skills', 'brainstorming', 'SKILL.md'), 'utf8'),
    /^brainstorming 6 \(6\.4\.3\)$/m);
});

test('--patch applies with --3way in a clone that lacks the from-version blobs', async () => {
  const clone = makeClone({ editAll: true });
  const probe = await diff(makeClone(), { version: '6.4.3', mode: 'patch' });
  const shas = indexShas(probe.out).filter((sha) => sha !== ZERO);
  assert.ok(shas.length > 0);
  for (const sha of shas) {
    assert.match(sha, /^[0-9a-f]{40}$/, 'the patch carries --full-index ids');
    assert.notEqual(gitStatus(clone.root, ['cat-file', '-e', sha]).status, 0, `${sha} already present`);
  }
  const head = git(clone.root, ['rev-parse', 'HEAD']);
  const refs = git(clone.root, ['for-each-ref']);
  const index = readFileSync(join(clone.root, '.git', 'index'));
  const work = tree(clone.plugin);
  const r = await diff(clone, { version: '6.4.3', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(indexShas(r.out), indexShas(probe.out));
  for (const sha of shas) assert.equal(gitStatus(clone.root, ['cat-file', '-e', sha]).status, 0, `${sha} missing`);
  // Objects only: no ref, index or working-tree change.
  assert.equal(git(clone.root, ['rev-parse', 'HEAD']), head);
  assert.equal(git(clone.root, ['for-each-ref']), refs);
  assert.deepEqual(readFileSync(join(clone.root, '.git', 'index')), index);
  assert.deepEqual(tree(clone.plugin), work);
  assert.notEqual(gitStatus(clone.root, ['apply', '--check', '-'], { input: r.out }).status, 0,
    'the direct apply must fail, so the three-way path is what applies it');
  const applied = applyPatch(clone.root, r.out);
  assert.equal(applied.status, 0, applied.stderr);
  const text = readFileSync(join(clone.plugin, 'skills', 'finishing-branch', 'SKILL.md'), 'utf8');
  assert.match(text, /^finishing-branch\/SKILL\.md line 3 \(fork\)$/m);
  assert.match(text, /^finishing 6 \(6\.4\.3\)$/m);
});

test('--patch uses no rename detection', async () => {
  const clone = makeClone({ at: '6.4.3' });
  const r = await diff(clone, { version: '6.4.4', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /^(rename|similarity|copy) /m);
  assert.match(r.out,
    /^diff --git a\/plugins\/methodology\/skills\/brainstorming\/visual-companion\.md b\/plugins\/methodology\/skills\/brainstorming\/visual-companion\.md\ndeleted file mode 100644$/m);
  assert.match(r.out,
    /^diff --git a\/plugins\/methodology\/skills\/brainstorming\/companion\.md b\/plugins\/methodology\/skills\/brainstorming\/companion\.md\nnew file mode 100644$/m);
  const applied = applyPatch(clone.root, r.out);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(join(clone.plugin, 'skills', 'brainstorming', 'visual-companion.md')), false);
  assert.equal(existsSync(join(clone.plugin, 'skills', 'brainstorming', 'companion.md')), true);
});

test('--patch reaches the derived templates registered in FORK.md', async () => {
  const clone = makeClone({ at: '6.4.3' });
  const r = await diff(clone, { version: '6.4.4', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  for (const path of ['requesting-code-review/code-reviewer.md', 'subagent-driven-development/final-review-prompt.md']) {
    assert.match(r.out, new RegExp(`^diff --git a/plugins/methodology/skills/${path} b/plugins/methodology/skills/${path}$`, 'm'));
  }
  const applied = applyPatch(clone.root, r.out);
  assert.equal(applied.status, 0, applied.stderr);
  const derived = readFileSync(join(clone.plugin, 'skills', 'subagent-driven-development', 'final-review-prompt.md'), 'utf8');
  assert.match(derived, /^adapted for roles:final-adversarial-reviewer$/m);
  assert.match(derived, /^reviewer 6 \(6\.4\.4\)$/m);
});

test('--patch leaves out changes to removed files and names them on stderr', async () => {
  const clone = makeClone();
  const r = await diff(clone, { version: '6.4.3', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /gemini/);
  assert.match(r.err, /^left out of the patch: skills\/using-superpowers\/references\/gemini-tools\.md \(removed in the fork\)$/m);
});

test('an upstream file the fork never had is not reported as removed in the fork', async () => {
  // interim.md: added upstream after the vendored release (not in vendored.files), deleted again in 6.4.4.
  const clone = makeClone({ at: '6.4.3' });
  const stat = await diff(clone, { version: '6.4.4' });
  assert.equal(stat.code, 0, stat.err);
  assert.ok(section(stat.out, 'brainstorming').includes('  interim.md  +0 -12  (deleted upstream; not in the fork)'),
    stat.out);
  const patch = await diff(clone, { version: '6.4.4', mode: 'patch' });
  assert.equal(patch.code, 0, patch.err);
  assert.doesNotMatch(patch.out, /interim/);
  assert.match(patch.err, /^left out of the patch: skills\/brainstorming\/interim\.md \(not in the fork\)$/m);
  assert.doesNotMatch(patch.err, /interim\.md \(removed in the fork\)/);
  const applied = applyPatch(clone.root, patch.out);
  assert.equal(applied.status, 0, applied.stderr);
});

test('--patch leaves out the upstream deletion of a file the fork adapted, and the rest still applies', async () => {
  // visual-companion.md is adapted in the fork and deleted upstream in 6.4.4: git apply --3way cannot merge a
  // deletion, so keeping it would abort the whole patch.
  const clone = makeClone({ at: '6.4.3', edits: { 'brainstorming/visual-companion.md': [[3, 'companion 3 (fork)']] } });
  const r = await diff(clone, { version: '6.4.4', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /visual-companion/);
  assert.match(r.err, /^deleted upstream but adapted in the fork: plugins\/methodology\/skills\/brainstorming\/visual-companion\.md — review by hand$/m);
  const applied = applyPatch(clone.root, r.out);
  assert.equal(applied.status, 0, applied.stderr);
  const skills = join(clone.plugin, 'skills');
  assert.match(readFileSync(join(skills, 'brainstorming', 'visual-companion.md'), 'utf8'), /^companion 3 \(fork\)$/m);
  assert.equal(existsSync(join(skills, 'brainstorming', 'companion.md')), true);
  assert.match(readFileSync(join(skills, 'finishing-branch', 'SKILL.md'), 'utf8'), /^finishing 10 \(6\.4\.4\)$/m);
  assert.match(readFileSync(join(skills, 'requesting-code-review', 'code-reviewer.md'), 'utf8'), /^reviewer 6 \(6\.4\.4\)$/m);
});

test('--patch leaves out a new upstream file under a vendored skill the fork removed entirely', async () => {
  const clone = makeClone({ at: '6.4.4' });
  const r = await diff(clone, { version: '6.4.5', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /dropped-skill/);
  assert.match(r.err, /^left out of the patch: skills\/dropped-skill\/extra\.md \(skill removed in the fork\)$/m);
  const applied = applyPatch(clone.root, r.out);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(join(clone.plugin, 'skills', 'dropped-skill')), false);
  assert.match(readFileSync(join(clone.plugin, 'skills', 'brainstorming', 'SKILL.md'), 'utf8'),
    /^brainstorming 11 \(6\.4\.5\)$/m);
});

test('--patch and --full refuse a path a header would have to quote', async () => {
  const clone = makeClone({ at: '6.4.5' });
  const objects = () => git(clone.root, ['count-objects', '-v']);
  const before = objects();
  for (const mode of ['patch', 'full']) {
    const r = await diff(clone, { version: '6.4.6', mode });
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, '');
    assert.match(r.err, /brainstorming\/odd name\.md.*needs quoting/);
  }
  assert.equal(objects(), before, 'no blob is written before the refusal');
  const stat = await diff(clone, { version: '6.4.6' });
  assert.equal(stat.code, 0, stat.err);
});

test('successive ports: A → B ported, committed and marked reviewed, then B → C from the default --from', async () => {
  const clone = makeClone({ editAll: true }); // every fork file adapted: no upstream blob in the clone
  const first = await diff(clone, { version: '6.4.3', mode: 'patch' });
  assert.equal(first.code, 0, first.err);
  const one = applyPatch(clone.root, first.out);
  assert.equal(one.status, 0, one.stderr);
  git(clone.root, ['commit', '-q', '-am', 'port 6.4.3']);
  const mark = await diff(clone, { version: '6.4.3', markReviewed: 'ported 6.4.3' });
  assert.equal(mark.code, 0, mark.err);
  git(clone.root, ['add', '-A']);
  git(clone.root, ['commit', '-q', '-m', 'reviewed 6.4.3']);
  assert.equal(JSON.parse(readFileSync(clone.upstreamJson, 'utf8')).reviewed.version, '6.4.3');

  const probe = await diff(makeClone({ at: '6.4.3' }), { version: '6.4.4', mode: 'patch' });
  const shas = indexShas(probe.out).filter((sha) => sha !== ZERO);
  const absent = shas.filter((sha) => gitStatus(clone.root, ['cat-file', '-e', sha]).status !== 0);
  assert.ok(absent.length > 0, 'some 6.4.3 blobs must be absent before the second run');
  const second = await diff(clone, { version: '6.4.4', mode: 'patch' });
  assert.equal(second.code, 0, second.err);
  // The adapted visual-companion.md deletion is left out (its blob is not needed); every base the patch names exists.
  const used = indexShas(second.out).filter((sha) => sha !== ZERO);
  assert.ok(used.some((sha) => absent.includes(sha)), 'the second run needs a blob the clone lacked');
  for (const sha of used) assert.equal(gitStatus(clone.root, ['cat-file', '-e', sha]).status, 0, `${sha} missing`);
  const two = applyPatch(clone.root, second.out);
  assert.equal(two.status, 0, two.stderr);
  const finishing = readFileSync(join(clone.plugin, 'skills', 'finishing-branch', 'SKILL.md'), 'utf8');
  assert.match(finishing, /^finishing-branch\/SKILL\.md line 3 \(fork\)$/m);
  assert.match(finishing, /^finishing 6 \(6\.4\.3\)$/m);
  assert.match(finishing, /^finishing 10 \(6\.4\.4\)$/m);
  assert.match(readFileSync(join(clone.plugin, 'skills', 'requesting-code-review', 'code-reviewer.md'), 'utf8'),
    /^reviewer 6 \(6\.4\.4\)$/m);
});

test('--patch leaves out a new upstream skill and names it on stderr', async () => {
  const clone = makeClone();
  const r = await diff(clone, { version: '6.4.3', mode: 'patch' });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /new-skill/);
  assert.match(r.err, /^new upstream skill new-skill \(no fork counterpart\): left out$/m);
});

test('--full with --patch exits 2', async () => {
  const clone = makeClone();
  const calls = [];
  const r = await run(['6.4.3', '--full', '--patch'], { cwd: clone.root, fetchTarball: fetcher(calls), now: new Date() });
  assert.equal(r.code, 2);
  assert.match(r.err, /--full and --patch/);
  assert.deepEqual(calls, []);
});

test('the work dir is a triqual-upstream-diff- temp dir under tmp', async () => {
  const clone = makeClone();
  // A tmp that does not exist: mkdtemp fails, and its message names the prefix it was given.
  const tmp = join(temp('cm-ud-tmp-'), 'missing');
  const r = await run(['6.4.3'], { cwd: clone.root, fetchTarball: fetcher(), now: new Date(), tmp });
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(join(tmp, 'triqual-upstream-diff-')), r.err);
});

// ---- --mark-reviewed -----------------------------------------------------------------------------------------------

test("--mark-reviewed sets reviewed and appends to FORK.md's review log", async () => {
  const clone = makeClone();
  const before = JSON.parse(readFileSync(clone.upstreamJson, 'utf8'));
  const r = await diff(clone, { version: '6.4.3', markReviewed: 'ported the finishing tweak' });
  assert.equal(r.code, 0, r.err);
  const after = JSON.parse(readFileSync(clone.upstreamJson, 'utf8'));
  // reviewed.files: every file of the reviewed release's skills tree with its sha256, which the fork checks read.
  const files = Object.fromEntries(Object.keys(RELEASES['6.4.3']).sort().map((path) => [path, sha256(RELEASES['6.4.3'][path])]));
  assert.deepEqual(after.reviewed, {
    version: '6.4.3', commit: UPSTREAM.commits['6.4.3'], reviewedAt: '2026-10-01', files,
  });
  assert.deepEqual(Object.keys(after.reviewed.files), Object.keys(files), 'sorted paths');
  assert.deepEqual(after.vendored, before.vendored);
  assert.equal(readFileSync(clone.upstreamJson, 'utf8'), JSON.stringify(after, null, 2) + '\n');
  const fork = readFileSync(clone.forkMd, 'utf8');
  assert.equal(fork, `${FORK_MD.replace(/\n*$/, '\n')}2026-10-01 6.4.3 ported the finishing tweak\n`);
  assert.match(r.out, /^superpowers 6\.4\.2 → 6\.4\.3$/m, 'the diff runs first');
});

test('--mark-reviewed restores upstream.json when the FORK.md write fails', async (t) => {
  const clone = makeClone();
  // FORK.md is a link into a read-only directory: reading works, the atomic write (temp file beside the target) fails.
  const ro = temp('cm-ud-ro-');
  writeFileSync(join(ro, 'FORK.md'), FORK_MD);
  rmSync(clone.forkMd);
  symlinkSync(join(ro, 'FORK.md'), clone.forkMd);
  chmodSync(ro, 0o555);
  t.after(() => chmodSync(ro, 0o755));
  const before = readFileSync(clone.upstreamJson);
  const r = await diff(clone, { version: '6.4.3', markReviewed: 'ported' });
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /upstream\.json restored/);
  assert.deepEqual(readFileSync(clone.upstreamJson), before);
  assert.equal(readFileSync(join(ro, 'FORK.md'), 'utf8'), FORK_MD);
});

test('--mark-reviewed says so when restoring upstream.json fails too', async () => {
  const clone = makeClone();
  let upstreamWrites = 0;
  const writeFile = (path, content) => {
    if (path === clone.forkMd) throw new Error('disk full');
    if (path === clone.upstreamJson && ++upstreamWrites === 2) throw new Error('read-only file system');
    writeAtomic(path, content);
  };
  const r = await diff(clone, { version: '6.4.3', markReviewed: 'ported', writeFile });
  assert.equal(r.code, 1, r.err);
  const errors = r.err.split('\n').filter((l) => l.startsWith('triqual upstream-diff: '));
  assert.equal(errors.length, 1, r.err);
  assert.match(errors[0], /disk full/);
  assert.match(errors[0], /read-only file system/);
  assert.match(errors[0], /upstream\.json now holds reviewed 6\.4\.3/);
  assert.doesNotMatch(r.err, /upstream\.json restored/);
  assert.equal(JSON.parse(readFileSync(clone.upstreamJson, 'utf8')).reviewed.version, '6.4.3');
  assert.equal(readFileSync(clone.forkMd, 'utf8'), FORK_MD);
});

async function assertRefused(clone, opts) {
  const files = snapshot(clone.upstreamJson, clone.forkMd);
  const r = await diff(clone, { markReviewed: 'reviewed', ...opts });
  assert.equal(r.code, 2, r.err);
  assert.deepEqual(snapshot(clone.upstreamJson, clone.forkMd), files);
  return r;
}

test('--mark-reviewed refuses a version older than reviewed', async () => {
  const r = await assertRefused(makeClone({ at: '6.4.3', reviewed: '6.4.3' }), { version: '6.4.2' });
  assert.match(r.err, /older than the reviewed 6\.4\.3/);
});

test('--mark-reviewed refuses an unknown version', async () => {
  const r = await assertRefused(makeClone(), { version: '6.9.9' });
  assert.match(r.err, /unknown superpowers version 6\.9\.9/);
});

test('--mark-reviewed refuses --skill', async () => {
  const r = await assertRefused(makeClone(), { version: '6.4.3', skill: 'brainstorming' });
  assert.match(r.err, /--skill/);
});

test('--mark-reviewed refuses a --from newer than reviewed', async () => {
  const r = await assertRefused(makeClone(), { version: '6.4.4', from: '6.4.3' });
  assert.match(r.err, /--from 6\.4\.3 is newer than the reviewed 6\.4\.2/);
});

// ---- failures ------------------------------------------------------------------------------------------------------

test('an unknown version exits 2', async () => {
  const clone = makeClone();
  for (const opts of [{ version: '6.9.9' }, { version: '6.4.3', from: '6.9.9' }]) {
    const r = await diff(clone, opts);
    assert.equal(r.code, 2);
    assert.equal(r.err, 'triqual upstream-diff: unknown superpowers version 6.9.9\n');
  }
});

test('a network error exits 1 with one line', async () => {
  const clone = makeClone();
  const r = await diff(clone, {
    version: '6.4.3',
    fetchTarball: async () => {
      throw new Error('getaddrinfo ENOTFOUND codeload.github.com\n    at somewhere');
    },
  });
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.equal(r.err.split('\n').filter(Boolean).length, 1, r.err);
  assert.match(r.err, /ENOTFOUND/);
});

test('an unknown --skill exits 2', async () => {
  const clone = makeClone();
  const calls = [];
  for (const skill of ['no-such-skill', 'new-skill']) {
    const r = await diff(clone, { version: '6.4.3', skill, fetchTarball: fetcher(calls) });
    assert.equal(r.code, 2);
    assert.equal(r.err, `triqual upstream-diff: unknown skill ${skill}\n`);
  }
});

test('--help prints the usage and exits 0', async () => {
  const r = await run(['--help'], { cwd: tmpdir(), fetchTarball: fetcher(), now: new Date() });
  assert.equal(r.code, 0);
  assert.match(r.out, /^usage: triqual upstream-diff <version> \[--from <v>\] \[--skill <name>\] \[--full \| --patch\] \[--mark-reviewed "<summary>"\]/);
  const cli = spawnSync(process.execPath, [CLI, '-h'], { cwd: tmpdir(), encoding: 'utf8', env: gitEnv() });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, r.out);
});
