// `triqual tracking add`, `status set` and the store-mode `write` paths (plan tracking-store-1 T3), plus the entry and
// status parsers they use. Every CLI test runs in a temp repo marked for store mode, with a temp HOME and
// TRIQUAL_TRACKING_DB pointing into the temp dir; no test touches a real data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryDate, parseEntryDraft } from '../lib/entry-draft.mjs';
import { parseStatusSections } from '../lib/status-sections.mjs';
import { loadSqlite, openStore } from '../lib/store.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PLUGIN, 'bin', 'tracking.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NOT_IN_STORE = 'not in store mode: run triqual progress-init --store';

await loadSqlite();
const { DatabaseSync } = await import('node:sqlite');

const MD = `## 2026-10-11 — Add the thing
- **Stage/task:** Plan example-plan · T3
- **Done:** built it
  with a second line
- **Files:** a.mjs, b.mjs
- **Verification:** npm test passed
- **Commit:** ignored on add
- **Next:** T4
`;

// A clean environment: no inherited GIT_* repo selection, a temp HOME, no registry or data-dir redirects.
const cleanEnv = (home, extra = {}) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'TRIQUAL_REGISTRY_DIR', 'CM_REGISTRY_DIR']) delete env[k];
  return { ...env, ...extra };
};

// A temp dir with a repo (one commit), a HOME, a drafts dir and the store env. `mode` is 'store' (marked, with the
// database created) or 'committed' (progress.md at the root, no marker).
function withRepo(mode, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-trkcli-')));
  const repo = join(dir, 'repo');
  const home = join(dir, 'home');
  const drafts = join(dir, 'drafts');
  const dataDir = join(dir, 'data');
  for (const d of [repo, home, drafts]) mkdirSync(d);
  const dbEnv = { TRIQUAL_TRACKING_DB: join(dataDir, 'tracking.db') };
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git('commit', '-qm', 'initial');
  if (mode === 'store') {
    git('config', '--local', 'triqual.tracking', 'store');
    openStore({ home, env: dbEnv, create: true }).close();
  } else if (mode === 'committed') {
    writeFileSync(join(repo, 'progress.md'), '# Progress\n\n## 2026-09-27 — Older\n- **Done:** before\n');
    writeFileSync(join(repo, 'status.md'), '# Status\n');
    git('add', 'progress.md', 'status.md');
    git('commit', '-qm', 'track');
  }
  // Every path under .git with its size and mtime, the index (which any git command may refresh) left out.
  const gitListing = () => {
    const list = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const path = join(d, e.name);
        if (path === join(repo, '.git', 'index') || path === join(repo, '.git', 'index.lock')) continue;
        const st = statSync(path);
        list.push(`${path.slice(repo.length)} ${e.isDirectory() ? 'dir' : `${st.size} ${st.mtimeMs}`}`);
        if (e.isDirectory()) walk(path);
      }
    };
    walk(join(repo, '.git'));
    return list.sort();
  };
  const gitBaseline = gitListing();
  const run = (args, { extraEnv = {}, env = dbEnv } = {}) => spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo, env: cleanEnv(home, { ...env, ...extraEnv }), encoding: 'utf8',
  });
  const draft = (name, text) => {
    const path = join(drafts, name);
    writeFileSync(path, text);
    return path;
  };
  // Reads the store in this process: fn(store) with the store closed afterwards.
  const inStore = (fn) => {
    const store = openStore({ home, env: dbEnv });
    try { return fn(store); } finally { store.close(); }
  };
  const entries = () => inStore((s) => s.all('SELECT * FROM entries ORDER BY id'));
  try {
    return fn({ dir, repo, home, dataDir, git, run, draft, inStore, entries, dbEnv, gitListing, gitBaseline });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok = (r) => { assert.equal(r.status, 0, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
const refused = (r, pattern) => {
  assert.equal(r.status, 2, `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, pattern);
};

// ---- parseEntryDraft ----

test('a markdown draft gives its fields and its date', () => {
  const e = parseEntryDraft(MD, { strict: true });
  assert.deepEqual(e, {
    date: '2026-10-11',
    title: 'Add the thing',
    stage_task: 'Plan example-plan · T3',
    done: 'built it\n  with a second line',
    files: 'a.mjs, b.mjs',
    verification: 'npm test passed',
    next: 'T4',
    extra: [],
  });
});

test('a bullet runs until the next top-level bullet, sub-bullets and blank lines included', () => {
  const e = parseEntryDraft(`## 2026-10-11 — T
- **Stage/task:** off-plan
- **Done:** intro
  - nested one
  - nested two

  closing paragraph
- **Files:** f
- **Verification:** v
- **Next:** n
`, { strict: true });
  assert.equal(e.done, 'intro\n  - nested one\n  - nested two\n\n  closing paragraph');
  assert.equal(e.files, 'f');
});

test('a JSON draft gives its fields, with no date', () => {
  const e = parseEntryDraft(JSON.stringify({
    title: 'Json entry', stage_task: 'off-plan', done: 'd', files: 'f', verification: 'v', next: 'n',
  }), { strict: true });
  assert.deepEqual(e, {
    date: null, title: 'Json entry', stage_task: 'off-plan', done: 'd', files: 'f', verification: 'v', next: 'n', extra: [],
  });
});

test('strict refuses an extra field, naming it, in markdown and in JSON', () => {
  const md = parseEntryDraft(`${MD}- **Audit:** clean\n`, { strict: true });
  assert.match(md.error, /Audit/);
  const js = parseEntryDraft(JSON.stringify({
    title: 't', stage_task: 's', done: 'd', files: 'f', verification: 'v', next: 'n', audit: 'x',
  }), { strict: true });
  assert.match(js.error, /audit/);
});

test('strict refuses a missing or empty required field, naming its key', () => {
  const noNext = parseEntryDraft(MD.replace('- **Next:** T4\n', ''), { strict: true });
  assert.match(noNext.error, /\bnext\b/);
  const emptyDone = parseEntryDraft(MD.replace('built it\n  with a second line', ''), { strict: true });
  assert.match(emptyDone.error, /\bdone\b/);
  const noStage = parseEntryDraft(JSON.stringify({ title: 't', done: 'd', files: 'f', verification: 'v', next: 'n' }), { strict: true });
  assert.match(noStage.error, /\bstage_task\b/);
});

test('without strict, extra fields are listed and missing ones read as empty', () => {
  const e = parseEntryDraft(`${MD.replace('- **Next:** T4\n', '')}- **Audit:** clean\n`, { strict: false });
  assert.deepEqual(e.extra, ['Audit']);
  assert.equal(e.next, '');
  assert.equal(e.title, 'Add the thing');
});

test('any top-level "- **" line is a field boundary, formatted like a field or not', () => {
  for (const [bullet, name] of [['- **Audit**: clean', 'Audit'], ['- **Note** extra', 'Note'], ['- **Review** ', 'Review']]) {
    const strict = parseEntryDraft(`${MD}${bullet}\n`, { strict: true });
    assert.match(strict.error, new RegExp(`"${name}"`), bullet);
    // In the middle of the draft too: the bullet ends Done, it is not merged into it.
    const lax = parseEntryDraft(MD.replace('- **Files:**', `${bullet}\n- **Files:**`), { strict: false });
    assert.deepEqual(lax.extra, [name], bullet);
    assert.equal(lax.done, 'built it\n  with a second line', bullet);
    assert.equal(lax.next, 'T4', bullet);
  }
});

test('a field name spelled like an internal key is an extra field and never overwrites a field', () => {
  const draft = `${MD}- **stage_task:** hijacked\n`;
  const lax = parseEntryDraft(draft, { strict: false });
  assert.deepEqual(lax.extra, ['stage_task']);
  assert.equal(lax.stage_task, 'Plan example-plan · T3');
  assert.match(parseEntryDraft(draft, { strict: true }).error, /"stage_task"/);
});

test('an impossible heading date is refused in strict mode, naming date, and reads as null otherwise', () => {
  const bad = MD.replace('2026-10-11', '2026-13-45');
  assert.match(parseEntryDraft(bad, { strict: true }).error, /\bdate\b/);
  assert.match(parseEntryDraft(MD.replace('2026-10-11', '2026-02-30'), { strict: true }).error, /\bdate\b/);
  const lax = parseEntryDraft(bad, { strict: false });
  assert.equal(lax.date, null);
  assert.equal(lax.title, 'Add the thing');
  assert.equal(lax.next, 'T4');
  assert.equal(parseEntryDraft(MD.replace('2026-10-11', '2028-02-29'), { strict: true }).date, '2028-02-29');
});

test('a draft with no entry heading, a second dated heading or stray text is an error', () => {
  assert.match(parseEntryDraft('- **Done:** x\n', { strict: true }).error, /heading/);
  assert.match(parseEntryDraft(`${MD}\n## 2026-10-12 — Another\n- **Done:** x\n`, { strict: true }).error, /one entry/);
  assert.match(parseEntryDraft(MD.replace('- **Stage', 'stray prose\n- **Stage'), { strict: true }).error, /outside a field/);
  assert.match(parseEntryDraft('{ not json', { strict: true }).error, /JSON/);
});

// ---- parseStatusSections ----

const STATUS = `# Project Status

**Last updated:** today

## Summary

One.

## Distribution

Two.

\`\`\`
## not a heading
\`\`\`

## Roadmap

Three.

## Current task

Four.

## Open decisions

Five.

<!-- tasks:start -->
## Active plan

### plan — 0/1 done
- Next: T1
<!-- tasks:end -->
`;

test('status sections: the preamble first, then the sections in order, without the tasks block', () => {
  const sections = parseStatusSections(STATUS);
  assert.deepEqual(sections.map((s) => s.heading), ['preamble', 'Summary', 'Distribution', 'Roadmap', 'Current task', 'Open decisions']);
  assert.equal(sections[0].body, '# Project Status\n\n**Last updated:** today');
  assert.equal(sections[1].body, 'One.');
  assert.match(sections[2].body, /## not a heading/, 'a fenced code line is not a heading');
  assert.ok(!sections.some((s) => /tasks:|Active plan|0\/1 done/.test(`${s.heading}${s.body}`)));
});

test('status sections: a text with no heading is only a preamble, an empty one an empty preamble', () => {
  assert.deepEqual(parseStatusSections('just text\n'), [{ heading: 'preamble', body: 'just text' }]);
  assert.deepEqual(parseStatusSections(''), [{ heading: 'preamble', body: '' }]);
});

test('status sections: a repeated heading is an error naming it', () => {
  assert.throws(() => parseStatusSections('## A\n\nx\n\n## B\n\ny\n\n## A\n\nz\n'), /repeated heading "A"/);
  assert.throws(() => parseStatusSections('## preamble\n\nx\n'), /preamble/);
});

test('status sections: an unbalanced tasks block is an error', () => {
  assert.throws(() => parseStatusSections('## A\n<!-- tasks:start -->\nx\n'), /tasks/);
  assert.throws(() => parseStatusSections('## A\n<!-- tasks:end -->\n'), /tasks/);
});

// ---- tracking add ----

test('add records a pending entry for this worktree and prints its id', () => withRepo('store', ({ repo, run, draft, entries }) => {
  const r = ok(run(['add', draft('e.md', MD)]));
  assert.equal(r.stdout, 'entry 1\n');
  const [e] = entries();
  assert.equal(e.state, 'pending');
  assert.equal(e.commit_sha, null);
  assert.equal(e.title, 'Add the thing');
  assert.equal(e.stage_task, 'Plan example-plan · T3');
  assert.equal(e.done, 'built it\n  with a second line');
  assert.equal(e.next, 'T4');
  assert.equal(e.plan, 'example-plan');
  assert.equal(e.task_key, 'T3');
  assert.equal(e.git_dir, join(repo, '.git'));
  assert.ok(e.branch);
  assert.equal(e.original, null);
}));

test('add takes a JSON draft', () => withRepo('store', ({ run, draft, entries }) => {
  const json = { title: 'J', stage_task: 'off-plan', done: 'd', files: 'f', verification: 'v', next: 'n' };
  assert.equal(ok(run(['add', draft('e.json', JSON.stringify(json))])).stdout, 'entry 1\n');
  assert.equal(entries()[0].title, 'J');
}));

test('add refuses an extra field and a missing one with exit 2, naming them, and records nothing', () => withRepo('store', ({ run, draft, entries }) => {
  refused(run(['add', draft('a.md', `${MD}- **Audit:** clean\n`)]), /Audit/);
  refused(run(['add', draft('b.md', MD.replace('- **Next:** T4\n', ''))]), /\bnext\b/);
  refused(run(['add', join(draft('c.md', ''), '..', 'missing.md')]), /not found/);
  assert.deepEqual(entries(), []);
}));

test('add: pending by default, no_commit with --no-commit, committed with --commit and the resolved sha', () => withRepo('store', ({ git, run, draft, entries }) => {
  const d = draft('e.md', MD);
  ok(run(['add', d]));
  ok(run(['add', d, '--no-commit']));
  ok(run(['add', d, '--commit', 'HEAD']));
  const head = git('rev-parse', 'HEAD');
  const rows = entries();
  assert.deepEqual(rows.map((e) => [e.state, e.commit_sha]), [['pending', null], ['no_commit', null], ['committed', head]]);
  refused(run(['add', d, '--no-commit', '--commit', 'HEAD']), /--no-commit|--commit/);
  refused(run(['add', d, '--commit', 'no-such-rev']), /no-such-rev/);
  assert.equal(entries().length, 3, 'a refused add records nothing');
}));

test('add --corrects stores the corrected entry id; an unknown id is refused', () => withRepo('store', ({ run, draft, entries }) => {
  const d = draft('e.md', MD);
  ok(run(['add', d]));
  ok(run(['add', d, '--corrects', '1']));
  assert.deepEqual(entries().map((e) => e.corrects), [null, 1]);
  refused(run(['add', d, '--corrects', '99']), /99/);
  refused(run(['add', d, '--corrects', 'abc']), /--corrects/);
  assert.equal(entries().length, 2);
}));

test('the first add of the day creates today\'s snapshot, taken after the entry was written', () => withRepo('store', ({ dataDir, run, draft }) => {
  const today = new Date().toISOString().slice(0, 10);
  const file = join(dataDir, 'backups', `tracking-${today}.db`);
  assert.equal(existsSync(file), false);
  ok(run(['add', draft('e.md', MD)]));
  assert.ok(existsSync(file), 'the snapshot exists');
  const snap = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM entries').get().n, 1, 'the snapshot holds the new entry');
  } finally {
    snap.close();
  }
  ok(run(['add', draft('f.md', MD)]));
  assert.equal(readdirSync(join(dataDir, 'backups')).length, 1, 'one snapshot per day');
}));

test('add with the database absent is refused with the restore hint, and creates nothing', () => withRepo('store', ({ dir, run, draft }) => {
  const env = { TRIQUAL_TRACKING_DB: join(dir, 'elsewhere', 'tracking.db') };
  refused(run(['add', draft('e.md', MD)], { env }), /triqual tracking restore/);
  assert.equal(existsSync(join(dir, 'elsewhere')), false);
}));

// ---- the date an entry shows ----

// The calendar date of `at` in the time zone `timeZone`, computed by Intl, independent of the code under test.
const dateIn = (timeZone, at) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

test('entryDate: the draft\'s heading date, else the local date of the write across UTC midnight', () => {
  // 22:30 on 2026-10-11 in Buenos Aires (UTC-3) is already 2026-10-12 in UTC.
  const at = '2026-10-12T01:30:00Z';
  const code = `import { entryDate } from ${JSON.stringify(new URL('../lib/entry-draft.mjs', import.meta.url).href)};
    const at = new Date(${JSON.stringify(at)});
    console.log(JSON.stringify([entryDate({ date: null }, at), entryDate({ date: '2026-10-09' }, at)]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, TZ: 'America/Argentina/Buenos_Aires' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['2026-10-11', '2026-10-09'], 'the UTC date of the write is not shown');
  assert.equal(new Date(at).toISOString().slice(0, 10), '2026-10-12');
  assert.equal(typeof entryDate({ date: null }), 'string');
});

test('add stores the write time for ordering and the draft\'s own heading date for display, and --since filters on that date', () => withRepo('store', ({ run, draft, entries }) => {
  const before = Date.now();
  ok(run(['add', draft('old.md', MD.replace('2026-10-11', '2020-01-02'))]));
  const [row] = entries();
  assert.equal(row.entry_date, '2020-01-02');
  assert.ok(Date.parse(row.created_at) >= before - 1000 && Date.parse(row.created_at) <= Date.now() + 1000, 'created_at is the write time');
  assert.match(ok(run(['log'])).stdout, /^## 2020-01-02 — Add the thing$/m);
  assert.match(ok(run(['log', '--since', '2020-01-02'])).stdout, /Add the thing/);
  assert.equal(ok(run(['log', '--since', '2020-01-03'])).stdout, '', 'filtered on the shown date, not on the write time');
  assert.equal(JSON.parse(ok(run(['log', '--json'])).stdout)[0].entry_date, '2020-01-02');
}));

test('add of a JSON draft with no date shows the local date of the write, in the zone it runs in', () => withRepo('store', ({ run, draft, entries }) => {
  const json = JSON.stringify({ title: 'Json entry', stage_task: 'off-plan', done: 'd', files: 'f', verification: 'v', next: 'n' });
  // Two zones whose date differs from each other's for part of every UTC day: one of them is never on the UTC date.
  const zones = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'];
  for (const [i, zone] of zones.entries()) {
    const before = new Date();
    ok(run(['add', draft(`j${i}.json`, json)], { extraEnv: { TZ: zone } }));
    const after = new Date();
    const row = entries().at(-1);
    assert.ok([dateIn(zone, before), dateIn(zone, after)].includes(row.entry_date), `${zone}: ${row.entry_date}`);
  }
  const utcDates = entries().map((e) => e.created_at.slice(0, 10));
  assert.ok(entries().some((e, i) => e.entry_date !== utcDates[i]), 'the check can fail: one zone shows a date other than the UTC one');
}));

// ---- status set ----

test('status set stores the preamble and the sections in order, without the tasks block', () => withRepo('store', ({ run, draft, inStore }) => {
  const r = ok(run(['status', 'set', draft('s.md', STATUS)]));
  assert.match(r.stdout, /6 sections/);
  const rows = inStore((s) => s.all('SELECT position, heading, body FROM status ORDER BY position'));
  assert.deepEqual(rows.map((x) => [x.position, x.heading]), [
    [0, 'preamble'], [1, 'Summary'], [2, 'Distribution'], [3, 'Roadmap'], [4, 'Current task'], [5, 'Open decisions'],
  ]);
  assert.ok(!rows.some((x) => /tasks:|Active plan/.test(x.body)));
  // A second full set replaces them all.
  ok(run(['status', 'set', draft('s2.md', '# Other\n\n## Only\n\nbody\n')]));
  assert.deepEqual(inStore((s) => s.status(s.get('SELECT id FROM repos').id).map((x) => x.heading)), ['preamble', 'Only']);
}));

test('status set --section replaces one section only, from a draft with or without its heading', () => withRepo('store', ({ run, draft, inStore }) => {
  ok(run(['status', 'set', draft('s.md', STATUS)]));
  const before = inStore((s) => s.all('SELECT heading, body FROM status ORDER BY position'));
  ok(run(['status', 'set', '--section', 'Roadmap', draft('r.md', '## Roadmap\n\nnew roadmap\n')]));
  ok(run(['status', 'set', '--section', 'Summary', draft('m.md', 'new summary\n')]));
  const after = inStore((s) => s.all('SELECT heading, body FROM status ORDER BY position'));
  assert.deepEqual(after.map((x) => x.heading), before.map((x) => x.heading));
  for (const [i, row] of after.entries()) {
    const expected = { Roadmap: 'new roadmap', Summary: 'new summary' }[row.heading];
    assert.equal(row.body, expected ?? before[i].body, row.heading);
  }
  refused(run(['status', 'set', '--section', 'Nope', draft('n.md', 'x\n')]), /Nope/);
  refused(run(['status', 'set', '--section', 'Roadmap', draft('o.md', '## Other\n\nx\n')]), /Other/);
}));

test('status set --section changes the updated_at of the replaced section only', () => withRepo('store', ({ run, draft, inStore }) => {
  ok(run(['status', 'set', draft('s.md', STATUS)]));
  const stamp = (at) => inStore((s) => s.run('UPDATE status SET updated_at = ?', at));
  stamp('2000-01-01T00:00:00.000Z');
  ok(run(['status', 'set', '--section', 'Roadmap', draft('r.md', '## Roadmap\n\nnew roadmap\n')]));
  const rows = inStore((s) => s.all('SELECT heading, updated_at FROM status ORDER BY position'));
  for (const row of rows) {
    if (row.heading === 'Roadmap') assert.notEqual(row.updated_at, '2000-01-01T00:00:00.000Z', 'replaced');
    else assert.equal(row.updated_at, '2000-01-01T00:00:00.000Z', row.heading);
  }
}));

test('a flag used on the wrong command names the commands that take it', () => withRepo('store', ({ run, draft }) => {
  const e = draft('e.md', MD);
  refused(run(['add', e, '--replace']), /--replace applies to write spec and write plan only/);
  refused(run(['add', e, '--section', 'x']), /--section applies to status set only/);
  refused(run(['status', 'set', '--commit', 'HEAD', e]), /--commit applies to add only/);
  refused(run(['write', 'entry', e, '--section', 'x']), /--section applies to status set only/);
  refused(run(['write', 'entry', e, '--corrects', '1']), /--corrects applies to add only/);
  refused(run(['write', 'entry', e, '--replace']), /--replace applies to write spec and write plan only/);
}));

test('status set refuses a repeated heading with exit 2, naming it, and leaves the stored status', () => withRepo('store', ({ run, draft, inStore }) => {
  ok(run(['status', 'set', draft('s.md', STATUS)]));
  refused(run(['status', 'set', draft('d.md', '## A\n\nx\n\n## A\n\ny\n')]), /repeated heading "A"/);
  assert.equal(inStore((s) => s.all('SELECT heading FROM status').length), 6);
}));

// ---- tracking write in store mode ----

// The working tree and the git dir hold nothing the store-mode writes could have left.
function untouched({ repo, git, gitListing, gitBaseline }) {
  assert.deepEqual(gitListing(), gitBaseline, 'the git dir is unchanged (index apart)');
  assert.equal(git('status', '--porcelain'), '', 'the working tree is clean');
  for (const f of ['progress.md', 'status.md']) assert.equal(existsSync(join(repo, f)), false, f);
  assert.equal(existsSync(join(repo, '.git', 'methodology')), false, 'no local-mode directory');
}

test('write entry and write status are add and status set, and touch no file of the repository', () => withRepo('store', (ctx) => {
  const { run, draft, entries, inStore } = ctx;
  assert.equal(ok(run(['write', 'entry', draft('e.md', MD)])).stdout, 'entry 1\n');
  assert.equal(entries()[0].title, 'Add the thing');
  ok(run(['write', 'status', draft('s.md', STATUS)]));
  assert.equal(inStore((s) => s.all('SELECT heading FROM status').length), 6);
  untouched(ctx);
}));

test('write spec lands under the documents directory of the store, with nothing in the working tree', () => withRepo('store', (ctx) => {
  const { dataDir, run, draft, inStore } = ctx;
  const key = (() => { ok(run(['add', draft('e.md', MD)])); return inStore((s) => s.get('SELECT repo_key FROM repos').repo_key); })();
  const r = ok(run(['write', 'spec', draft('2026-10-11-thing-design.md', '# spec\n')]));
  const dest = join(dataDir, 'repos', key, 'specs', '2026-10-11-thing-design.md');
  assert.equal(r.stdout, `${dest}\n`);
  assert.equal(readFileSync(dest, 'utf8'), '# spec\n');
  untouched(ctx);
  refused(run(['write', 'spec', draft('2026-10-11-thing-design.md', '# other\n')]), /already exists/);
  ok(run(['write', 'spec', draft('2026-10-11-thing-design.md', '# other\n'), '--replace']));
  assert.equal(readFileSync(dest, 'utf8'), '# other\n');
}));

test('write plan in store mode lands in the documents directory, not in the working tree', () => withRepo('store', (ctx) => {
  const { run, draft } = ctx;
  const r = ok(run(['write', 'plan', draft('2026-10-11-p.md', '# plan\n\n### Task 1: A\n')]));
  assert.match(r.stdout.split('\n')[0], /\/repos\/[0-9a-f]{16}\/plans\/2026-10-11-p\.md$/);
  untouched(ctx);
}));

// ---- outside store mode ----

test('add and status set outside store mode exit 2 with the progress-init --store hint', () => {
  for (const mode of ['committed', null]) {
    withRepo(mode, ({ run, draft }) => {
      refused(run(['add', draft('e.md', MD)]), new RegExp(NOT_IN_STORE));
      refused(run(['status', 'set', draft('s.md', STATUS)]), new RegExp(NOT_IN_STORE));
    });
  }
});

test('write entry in a committed repository still writes progress.md', () => withRepo('committed', ({ repo, run, draft }) => {
  const r = ok(run(['write', 'entry', draft('e.md', '## 2026-10-11 — New\n- **Done:** x\n')]));
  assert.equal(r.stdout, `${join(repo, 'progress.md')}\n`);
  const text = readFileSync(join(repo, 'progress.md'), 'utf8');
  assert.ok(text.indexOf('## 2026-10-11 — New') < text.indexOf('## 2026-09-27 — Older'), 'the new entry is on top');
}));
