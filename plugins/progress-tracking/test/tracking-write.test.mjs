// `triqual tracking write` (plan sp3-orchestration T16): local-mode tracking files live under the git dir, where Claude
// Code refuses an agent's file writes, so every tracking write goes through this program. Every test runs in a temp
// repo with a temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopVerdict } from '../scripts/gate.mjs';
import { BRAND } from '../lib/brand.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PLUGIN, 'cli', 'tracking.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NOT_OPTED_IN = 'not opted in: run triqual progress-init (or triqual progress-init --local)';
const HEADER = '# Progress\n\nAppend-only log: one entry per task, newest on top.\n';
const OLD = '## 2026-09-27 — Older\n- **Done:** before\n';
const PLAN = '# Example plan\n\n### Task 1: Alpha\n\n### Task 2: Beta\n**Depends on:** T1\n';
const NAME = '2026-09-28-example';

// A clean environment: no inherited GIT_* repo selection and a temp HOME without XDG_CONFIG_HOME.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME']) delete env[k];
  return { ...env, ...extra };
};

// A temp dir with a repo (one commit), a HOME and a drafts dir outside the repo. `mode`: 'committed', 'local' or
// null (not opted in).
function withRepo(mode, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-write-')));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const drafts = join(dir, 'drafts');
  for (const d of [repo, home, drafts]) mkdirSync(d);
  const env = cleanEnv(home);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git(...ID, 'commit', '-qm', 'initial');
  let root = null;
  if (mode === 'committed') {
    root = repo;
    writeFileSync(join(repo, 'progress.md'), `${HEADER}\n${OLD}`);
    writeFileSync(join(repo, 'status.md'), '# Status\n\n**Last updated:** before\n');
  } else if (mode === 'local') {
    root = join(repo, '.git', 'methodology');
    mkdirSync(join(root, 'plans'), { recursive: true });
    mkdirSync(join(root, 'specs'), { recursive: true });
    writeFileSync(join(root, 'progress.md'), `${HEADER}\n${OLD}`);
    writeFileSync(join(root, 'status.md'), '# Status\n\n**Last updated:** before\n');
  }
  const run = (args, { cwd = repo, extraEnv = {} } = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd, env: cleanEnv(home, extraEnv), encoding: 'utf8',
  });
  const draft = (name, text) => {
    const path = join(drafts, name);
    writeFileSync(path, text);
    return path;
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn({ dir, repo, home, root, git, run, draft, env });
  } catch (err) {
    cleanup();
    throw err;
  }
  if (typeof result?.then === 'function') return result.finally(cleanup); // an async test body
  cleanup();
  return result;
}

const read = (p) => readFileSync(p, 'utf8');
const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
const entryText = (title) => `## 2026-09-28 — ${title}\n- **Stage/task:** off-plan\n- **Done:** ${title}\n`;

test('write entry prepends below the header in committed and local mode', () => {
  for (const mode of ['committed', 'local']) {
    withRepo(mode, ({ root, run, draft, git }) => {
      const progress = join(root, 'progress.md');
      const r = ok(run(['write', 'entry', draft('entry.md', entryText('First'))]));
      assert.equal(r.stdout, `${progress}\n`, mode);
      assert.equal(read(progress), `${HEADER}\n${entryText('First')}\n${OLD}`, mode);
      // A second entry lands above the first; a draft with trailing blank lines is normalized.
      ok(run(['write', 'entry', draft('entry2.md', `${entryText('Second')}\n\n`)]));
      assert.equal(read(progress), `${HEADER}\n${entryText('Second')}\n${entryText('First')}\n${OLD}`, mode);
      if (mode === 'local') assert.equal(git('status', '--porcelain'), '', 'local mode leaves the working tree clean');
    });
  }
  // A progress.md with a header only: the entry goes below it.
  withRepo('local', ({ root, run, draft }) => {
    writeFileSync(join(root, 'progress.md'), HEADER);
    ok(run(['write', 'entry', draft('entry.md', entryText('Only'))]));
    assert.equal(read(join(root, 'progress.md')), `${HEADER}\n${entryText('Only')}`);
  });
});

test('write entry rejects a draft without a dated heading', () => {
  withRepo('local', ({ root, run, draft }) => {
    const progress = join(root, 'progress.md');
    const before = read(progress);
    for (const text of [
      '- **Done:** no heading\n',
      '## Some title\n- x\n',
      '## 2026-9-28 — Short date\n- x\n',
      '\n## 2026-09-28 — Leading blank line\n- x\n',
      '# 2026-09-28 — Wrong level\n- x\n',
      '',
    ]) {
      const r = run(['write', 'entry', draft('bad.md', text)]);
      assert.equal(r.status, 2, JSON.stringify(text));
      assert.match(r.stderr, /## <YYYY-MM-DD> — /, JSON.stringify(text));
      assert.equal(r.stdout, '');
    }
    const missing = run(['write', 'entry', join(root, 'nope.md')]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /nope\.md/);
    assert.equal(read(progress), before, 'progress.md is untouched');
  });
});

test('write entry refuses a draft with more than one dated heading', () => {
  withRepo('local', ({ root, run, draft }) => {
    const progress = join(root, 'progress.md');
    const before = read(progress);
    const r = run(['write', 'entry', draft('two.md', `${entryText('One')}\n${entryText('Two')}`)]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /one entry/);
    assert.match(r.stderr, /2 dated headings/);
    assert.ok(r.stderr.includes(`its own ${BRAND.cli} tracking write entry`), r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(read(progress), before, 'progress.md is untouched');
    // A `## ` heading that is not dated is part of the entry.
    ok(run(['write', 'entry', draft('one.md', `${entryText('One')}\n## Notes\n- more\n`)]));
  });
});

test('write status names a corrupt ledger and says tracking writes need it fixed', () => {
  withRepo('local', ({ root, run, draft }) => {
    const ledger = join(root, 'plans', `${NAME}.tasks.json`);
    writeFileSync(ledger, '{ not json');
    const status = join(root, 'status.md');
    const before = read(status);
    const r = run(['write', 'status', draft('status.md', '# Status\n\nnew\n')]);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(ledger), r.stderr);
    assert.match(r.stderr, /not valid JSON/);
    assert.match(r.stderr, /fix it/);
    assert.match(r.stderr, /tracking writes/);
    assert.equal(read(status), before, 'status.md is untouched');
  });
});

test('write status keeps the managed tasks section', () => {
  withRepo('local', ({ root, run, draft }) => {
    const status = join(root, 'status.md');
    // Create a ledger, so the section has a plan to render.
    ok(run(['write', 'plan', draft(`${NAME}.md`, PLAN)]));
    const section = read(status).slice(read(status).indexOf('<!-- tasks:start -->'));
    assert.match(section, /### 2026-09-28-example — 0\/2 done/);
    // A draft without the section: the section is kept.
    const r = ok(run(['write', 'status', draft('status.md', '# Status\n\n**Last updated:** 2026-09-28 — new\n')]));
    assert.equal(r.stdout, `${status}\n`);
    assert.equal(read(status), `# Status\n\n**Last updated:** 2026-09-28 — new\n\n${section}`);
    // A draft whose own section is stale or hand-edited: replaced by the rendered one, in place.
    const edited = '# Status\n\n<!-- tasks:start -->\nhand edit\n<!-- tasks:end -->\n\n## Risks\n- none\n';
    ok(run(['write', 'status', draft('status2.md', edited)]));
    assert.equal(read(status), `# Status\n\n${section}\n## Risks\n- none\n`);
    // Misordered markers in the draft: refused, nothing written.
    const before = read(status);
    const bad = run(['write', 'status', draft('status3.md', '# S\n<!-- tasks:end -->\n<!-- tasks:start -->\n')]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /misordered/);
    assert.equal(read(status), before);
  });
  // No ledger and no section anywhere: the draft is written as it is.
  withRepo('committed', ({ root, run, draft }) => {
    ok(run(['write', 'status', draft('status.md', '# Status\n\nplain\n')]));
    assert.equal(read(join(root, 'status.md')), '# Status\n\nplain\n');
  });
});

test('write spec refuses to overwrite without --replace', () => {
  for (const mode of ['committed', 'local']) {
    withRepo(mode, ({ root, run, draft }) => {
      const specsDir = mode === 'local' ? join(root, 'specs') : join(root, 'docs', 'specs');
      const dest = join(specsDir, '2026-09-28-topic-design.md');
      const r = ok(run(['write', 'spec', draft('2026-09-28-topic-design.md', '# Spec v1\n')]));
      assert.equal(r.stdout, `${dest}\n`, mode);
      assert.equal(read(dest), '# Spec v1\n', mode);
      const again = run(['write', 'spec', draft('2026-09-28-topic-design.md', '# Spec v2\n')]);
      assert.equal(again.status, 2, mode);
      assert.match(again.stderr, /already exists[\s\S]*--replace/, mode);
      assert.equal(read(dest), '# Spec v1\n', `${mode}: the spec is untouched`);
      ok(run(['write', 'spec', join(dirname(draft('x', '')), '2026-09-28-topic-design.md'), '--replace']));
      assert.equal(read(dest), '# Spec v2\n', mode);
      assert.deepEqual(readdirSync(specsDir), ['2026-09-28-topic-design.md'], `${mode}: no temp file left`);
    });
  }
});

test('write plan adopts and creates the ledger in local mode', () => {
  withRepo('local', ({ root, run, draft, git }) => {
    const planPath = join(root, 'plans', `${NAME}.md`);
    const ledgerPath = join(root, 'plans', `${NAME}.tasks.json`);
    const source = draft(`${NAME}.md`, PLAN);
    const r = ok(run(['write', 'plan', source]));
    assert.equal(r.stdout, `${planPath}\ncreated ${ledgerPath}\n`);
    assert.equal(read(planPath), PLAN);
    const ledger = JSON.parse(read(ledgerPath));
    assert.equal(ledger.plan, `plans/${NAME}.md`);
    assert.deepEqual(ledger.tasks.map((t) => t.id), ['T1', 'T2']);
    assert.match(read(join(root, 'status.md')), /### 2026-09-28-example — 0\/2 done/);
    assert.equal(git('status', '--porcelain'), '');
    // The name exists: refused without --replace, nothing changes.
    writeFileSync(source, `${PLAN}\n### Task 3: Gamma\n`);
    const again = run(['write', 'plan', source]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists/);
    assert.equal(read(planPath), PLAN);
    // --replace re-adopts and reconciles.
    const replaced = ok(run(['write', 'plan', source, '--replace']));
    assert.equal(replaced.stdout.split('\n')[0], planPath);
    assert.match(replaced.stdout, /reconciled .*added T3/);
    assert.equal(read(planPath), `${PLAN}\n### Task 3: Gamma\n`);
    assert.deepEqual(JSON.parse(read(ledgerPath)).tasks.map((t) => t.id), ['T1', 'T2', 'T3']);
    // A --replace draft that would not init leaves the adopted plan as it was.
    writeFileSync(source, '### Task 1: A\n**Depends on:** T9\n');
    const bad = run(['write', 'plan', source, '--replace']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /T1 depends on T9 \(unknown task\)/);
    assert.equal(read(planPath), `${PLAN}\n### Task 3: Gamma\n`);
    assert.deepEqual(readdirSync(join(root, 'plans')).sort(), [`${NAME}.md`, `${NAME}.tasks.json`], 'no temp file left');
  });
});

test('not opted in exits 2', () => {
  withRepo(null, ({ repo, run, draft, dir }) => {
    for (const kind of ['entry', 'status', 'spec', 'plan']) {
      const r = run(['write', kind, draft(`${NAME}.md`, entryText('x'))]);
      assert.equal(r.status, 2, kind);
      assert.equal(r.stderr, `${NOT_OPTED_IN}\n`, kind);
      assert.equal(r.stdout, '', kind);
    }
    assert.equal(existsSync(join(repo, 'progress.md')), false, 'progress.md was created');
    assert.equal(existsSync(join(repo, '.git', 'methodology', 'progress.md')), false, 'local progress.md was created');
    // Outside git too.
    const outside = run(['write', 'entry', draft('e.md', entryText('x'))], { cwd: dir });
    assert.equal(outside.status, 2);
    assert.equal(outside.stderr, `${NOT_OPTED_IN}\n`);
  });
});

test('bad arguments exit 2 with the usage; --help prints it and exits 0', () => {
  withRepo('local', ({ root, run, draft }) => {
    const d = draft('e.md', entryText('x'));
    for (const args of [[], ['write'], ['write', 'entry'], ['write', 'nope', d], ['read', 'entry', d],
      ['write', 'entry', d, 'extra'], ['write', 'entry', d, '--bogus']]) {
      const r = run(args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /usage: triqual tracking write <entry\|status\|spec\|plan> <draft> \[--replace\]/, args.join(' '));
    }
    for (const args of [['--help'], ['-h'], ['write', '--help'], ['write', 'entry', d, '-h']]) {
      const r = run(args);
      assert.equal(r.status, 0, args.join(' '));
      assert.match(r.stdout, /^usage: triqual tracking write <entry\|status\|spec\|plan> <draft> \[--replace\]/, args.join(' '));
    }
    assert.equal(read(join(root, 'progress.md')), `${HEADER}\n${OLD}`, 'nothing was written');
  });
});

test('concurrent writes are serialized by the tracking lock', async () => {
  const N = 12;
  await withRepo('local', async ({ repo, root, draft, home }) => {
    // Each worker writes N entries in sequence, one tracking.mjs process per entry; the two workers run at once.
    const worker = (tag) => new Promise((resolve, reject) => {
      const drafts = Array.from({ length: N }, (_, i) => draft(`${tag}-${i}.md`, entryText(`${tag} ${i}`)));
      const script = `const { spawnSync } = require('node:child_process');
for (const d of ${JSON.stringify(drafts)}) {
  const r = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'write', 'entry', d], { encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
}`;
      const child = spawn(process.execPath, ['-e', script], {
        cwd: repo, env: cleanEnv(home, { CM_LOCK_TIMEOUT_MS: '20000' }),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tag} exited ${code}: ${err}`))));
    });
    await Promise.all([worker('A'), worker('B')]);
    const text = read(join(root, 'progress.md'));
    assert.ok(text.startsWith(HEADER), 'the header stays on top');
    const titles = [...text.matchAll(/^## 2026-09-28 — (.*)$/gm)].map((m) => m[1]).sort();
    const expected = ['A', 'B'].flatMap((tag) => Array.from({ length: N }, (_, i) => `${tag} ${i}`)).sort();
    assert.deepEqual(titles, expected, 'an entry was lost');
    assert.ok(text.endsWith(OLD), 'the older entry stays at the bottom');
    assert.equal(existsSync(join(root, 'tasks.lock')), false, 'the lock was released');
  });
});

test('the local-mode Stop message names triqual tracking write entry', () => {
  const t = {
    mode: 'local', root: '/r/.git/methodology', progress: '/r/.git/methodology/progress.md',
    status: '/r/.git/methodology/status.md',
  };
  const hooked = stopVerdict({ dirty: ['a.txt'], tracking: t, input: {}, currentHash: 'x', lastHash: 'x' });
  const hookless = stopVerdict({ dirty: ['a.txt'], tracking: t, input: {}, currentHash: 'x', lastHash: 'x', sinceCommit: { commitTime: 100, progressMtimeMs: 0 } });
  for (const v of [hooked, hookless]) {
    assert.equal(v?.decision, 'block');
    assert.ok(v.reason.includes(`\`${BRAND.cli} tracking write entry <draft>\``), v.reason);
    assert.ok(v.reason.includes(`\`${BRAND.cli} tracking write status <draft>\``), v.reason);
    assert.match(v.reason, /\/r\/\.git\/methodology\/progress\.md/);
  }
  const committed = stopVerdict({
    dirty: ['a.txt'], tracking: { mode: 'committed', root: '/r', progress: '/r/progress.md', status: '/r/status.md' },
    input: {}, currentHash: null, lastHash: null,
  });
  assert.ok(!committed.reason.includes('tracking write'), 'committed mode is unchanged');
});
