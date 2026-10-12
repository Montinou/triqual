import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, chmodSync, utimesSync, realpathSync,
  symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BRAND } from '../bin/lib/brand.mjs';
import {
  firstTableHeaderIndex, hasTopLevelKey, insertTopLevel, setTableKey, tableNames,
  removeTopLevelKey, removeTableKey, removeTable, editTomlFile,
} from '../bin/lib/toml-edit.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(TEST_DIR, 'fixtures', 'legacy', 'codex-config.toml'), 'utf8');
const FALLBACK = 'project_doc_fallback_filenames = ["CLAUDE.md"]';
const SUPERPOWERS = 'plugins."superpowers@openai-curated-remote"';
const CHANGED = 'config.toml changed during the edit';
const RESTORED = 'codex rejected the edited config; restored';

const lineIndex = (text, line) => text.split('\n').indexOf(line);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const mode = (p) => statSync(p).mode & 0o7777;

async function withConfig(fn) {
  // Canonical, so the file is not behind macOS's /var -> /private/var link unless a test adds one.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cm-toml-')));
  const file = join(dir, 'config.toml');
  writeFileSync(file, FIXTURE);
  chmodSync(file, 0o600);
  try {
    return await fn(dir, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Sets the mtime to a distinct past instant on every call, the way a concurrent writer would move it.
let ticks = 0;
function touch(file) {
  ticks += 1;
  const when = new Date(Date.UTC(2020, 0, 1) + ticks * 1000);
  utimesSync(file, when, when);
}

const addFallback = (text) => ({ text: insertTopLevel(text, [FALLBACK]), changes: ['project_doc_fallback_filenames'] });

test('the fixture is shaped like the real config.toml', () => {
  const lines = FIXTURE.split('\n');
  const headers = lines.filter((l) => l.startsWith('[') && !l.startsWith('[1') && !l.startsWith('[3'));
  assert.ok(lines[1].startsWith('model = '), 'bare keys come first');
  assert.equal(headers.at(-1), '[mcp_servers.claude-mem]');
  assert.ok(headers.some((h) => h.startsWith('[hooks.state."')));
  assert.equal(FIXTURE.includes(SUPERPOWERS), false);
  assert.ok(FIXTURE.includes('developer_note = """\n'));
  assert.ok(FIXTURE.includes('\n[not.a.header]\n'), 'a header-looking line inside the """ string');
  assert.ok(FIXTURE.includes('matrix = [\n[1, 2],'));
});

test('insertTopLevel puts project_doc_fallback_filenames before the first header, not in [mcp_servers.claude-mem]', () => {
  const out = insertTopLevel(FIXTURE, [FALLBACK]);
  assert.equal(out, FIXTURE.replace("'''\n\n[features]\n", `'''\n${FALLBACK}\n\n[features]\n`));
  assert.ok(lineIndex(out, FALLBACK) < firstTableHeaderIndex(out));
  assert.equal(out.slice(out.indexOf('[mcp_servers.claude-mem]')).includes('project_doc_fallback_filenames'), false);
  assert.equal(hasTopLevelKey(FIXTURE, 'project_doc_fallback_filenames'), false);
  assert.equal(hasTopLevelKey(out, 'project_doc_fallback_filenames'), true);
});

test('insertTopLevel appends when there is no header', () => {
  assert.equal(insertTopLevel('a = 1\n', ['b = 2', 'c = 3']), 'a = 1\nb = 2\nc = 3\n');
  assert.equal(insertTopLevel('', ['b = 2']), 'b = 2\n');
});

test('tableNames lists each table header normalized, skipping array tables and header-looking string lines', () => {
  const text = 'a = 1\n[ x . "y z" ]\nk = """\n[not.a.table]\n"""\n[[arr]]\n[w.\'q\'] # note\r\n';
  assert.deepEqual(tableNames(text), ['x."y z"', "w.'q'"]);
  assert.deepEqual(tableNames(''), []);
});

test('hasTopLevelKey sees only bare keys before the first header', () => {
  assert.equal(hasTopLevelKey(FIXTURE, 'model'), true);
  assert.equal(hasTopLevelKey(FIXTURE, 'notify'), true);
  assert.equal(hasTopLevelKey(FIXTURE, 'command'), false, 'a key of [mcp_servers.claude-mem]');
  assert.equal(hasTopLevelKey(FIXTURE, 'hooks'), false, 'a key of [features]');
  assert.equal(hasTopLevelKey('a = """\nb = 1\n"""\n[t]\n', 'b'), false, 'a line inside a string');
});

test('setTableKey adds [plugins."superpowers@openai-curated-remote"] enabled = false before the first header and reports was: null, createdTable: true', () => {
  const first = setTableKey(FIXTURE, SUPERPOWERS, 'enabled', 'false');
  assert.equal(first.was, null);
  assert.equal(first.createdTable, true);
  assert.equal(first.text, FIXTURE.replace('\n[features]\n', `\n[${SUPERPOWERS}]\nenabled = false\n\n[features]\n`));
  assert.equal(firstTableHeaderIndex(first.text), lineIndex(first.text, `[${SUPERPOWERS}]`));

  const second = setTableKey(first.text, SUPERPOWERS, 'enabled', 'false');
  assert.deepEqual(second, { text: first.text, was: 'false', createdTable: false });
});

test('setTableKey edits a key inside its own table span and reports the prior value', () => {
  const table = `plugins."methodology-codex@${BRAND.legacy.marketplace}"`; // the fixture is a pre-rename config
  const out = setTableKey(FIXTURE, table, 'enabled', 'false');
  assert.equal(out.was, 'true');
  assert.equal(out.createdTable, false);
  assert.equal(out.text, FIXTURE.replace(`[${table}]\nenabled = true\n`, `[${table}]\nenabled = false\n`));

  const commented = setTableKey('a = 1\n\n[t]\nk = 1 # note\n', 't', 'k', '2');
  assert.deepEqual(commented, { text: 'a = 1\n\n[t]\nk = 2 # note\n', was: '1', createdTable: false });
});

test('setTableKey adds a missing key at the span end, before the blank line and the next table\'s comment', () => {
  const table = 'projects."/tmp/placeholder-project"';
  const out = setTableKey(FIXTURE, table, 'note', '"x"');
  assert.deepEqual(
    out,
    {
      text: FIXTURE.replace('trust_level = "trusted"\n', 'trust_level = "trusted"\nnote = "x"\n'),
      was: null,
      createdTable: false,
    },
  );
});

test('reverts round-trip', () => {
  const created = setTableKey(FIXTURE, SUPERPOWERS, 'enabled', 'false');
  assert.equal(removeTable(created.text, SUPERPOWERS), FIXTURE);

  assert.equal(removeTopLevelKey(insertTopLevel(FIXTURE, [FALLBACK]), 'project_doc_fallback_filenames'), FIXTURE);

  for (const table of ['features', 'projects."/tmp/placeholder-project"', 'mcp_servers.claude-mem']) {
    const added = setTableKey(FIXTURE, table, 'multi_agent', 'true');
    assert.equal(added.createdTable, false, table);
    assert.notEqual(added.text, FIXTURE, table);
    assert.equal(removeTableKey(added.text, table, 'multi_agent'), FIXTURE, table);
  }

  // No header at all: the table is appended, and removing it gives the input back.
  for (const text of ['a = 1\n', 'a = 1', '']) {
    const added = setTableKey(text, 't', 'k', '1');
    assert.equal(added.createdTable, true);
    assert.equal(removeTable(added.text, 't'), text);
  }
});

test('a CRLF file gets CRLF lines and round-trips', () => {
  const crlf = FIXTURE.replaceAll('\n', '\r\n');
  const inserted = insertTopLevel(crlf, [FALLBACK]);
  assert.equal(inserted, insertTopLevel(FIXTURE, [FALLBACK]).replaceAll('\n', '\r\n'));
  assert.equal(removeTopLevelKey(inserted, 'project_doc_fallback_filenames'), crlf);
  const created = setTableKey(crlf, SUPERPOWERS, 'enabled', 'false');
  assert.equal(created.text, setTableKey(FIXTURE, SUPERPOWERS, 'enabled', 'false').text.replaceAll('\n', '\r\n'));
  assert.equal(setTableKey(created.text, SUPERPOWERS, 'enabled', 'false').was, 'false');
  assert.equal(removeTable(created.text, SUPERPOWERS), crlf);
});

test('reverts return the text unchanged when the target is absent', () => {
  assert.equal(removeTable(FIXTURE, SUPERPOWERS), FIXTURE);
  assert.equal(removeTable(FIXTURE, 'not.a.header'), FIXTURE, 'a header-looking line inside a string');
  assert.equal(removeTableKey(FIXTURE, 'features', 'missing'), FIXTURE);
  assert.equal(removeTableKey(FIXTURE, SUPERPOWERS, 'enabled'), FIXTURE);
  assert.equal(removeTopLevelKey(FIXTURE, 'project_doc_fallback_filenames'), FIXTURE);
  assert.equal(removeTopLevelKey(FIXTURE, 'command'), FIXTURE, 'a table key is not top-level');
});

test('removeTable keeps a comment that belongs to the next table', () => {
  const text = 'a = 1\n\n[t]\nk = 1\n\n# about u\n[u]\nx = 2\n';
  assert.equal(removeTable(text, 't'), 'a = 1\n\n# about u\n[u]\nx = 2\n');
});

test('headers inside """ strings and multi-line arrays are ignored', () => {
  assert.equal(firstTableHeaderIndex(FIXTURE), lineIndex(FIXTURE, '[features]'));
  assert.equal(firstTableHeaderIndex('a = """\n[x]\n"""\n[real]\n'), 3);
  assert.equal(firstTableHeaderIndex("a = '''\n[x]\n'''\n[real]\n"), 3);
  assert.equal(firstTableHeaderIndex('a = [\n[1],\n[[2]],\n]\n[real]\n'), 4);
  assert.equal(firstTableHeaderIndex('a = """ \\""" still open\n[x]\n"""\n[real]\n'), 3, 'an escaped quote');
  assert.equal(firstTableHeaderIndex('a = """x""""\n[real]\n'), 1, 'a closing run of four quotes');
  assert.equal(firstTableHeaderIndex('a = "[" # [\n[real]\n'), 1, 'brackets in a string and a comment');
  assert.equal(firstTableHeaderIndex('  [[arr]]\nx = 1\n'), 0, 'an indented array-of-tables header');
  assert.equal(firstTableHeaderIndex('a = 1\n'), -1);
  assert.equal(setTableKey(FIXTURE, 'not.a.header', 'k', '1').createdTable, true);
});

test('editTomlFile retries once on an mtime change, then fails without writing', async () => {
  await withConfig(async (dir, file) => {
    let calls = 0;
    const res = await editTomlFile(file, (text) => {
      calls += 1;
      if (calls === 1) touch(file);
      return addFallback(text);
    }, { validate: async () => true });
    assert.deepEqual(res, { changed: true, changes: ['project_doc_fallback_filenames'] });
    assert.equal(calls, 2);
    assert.equal(readFileSync(file, 'utf8'), insertTopLevel(FIXTURE, [FALLBACK]));
  });

  await withConfig(async (dir, file) => {
    let calls = 0;
    let validated = 0;
    const res = await editTomlFile(file, (text) => {
      calls += 1;
      touch(file);
      return addFallback(text);
    }, { validate: async () => { validated += 1; return true; } });
    assert.deepEqual(res, { changed: false, changes: ['project_doc_fallback_filenames'], error: CHANGED });
    assert.equal(calls, 2);
    assert.equal(validated, 0);
    assert.equal(readFileSync(file, 'utf8'), FIXTURE);
    assert.deepEqual(readdirSync(dir), ['config.toml']);
  });
});

test('editTomlFile writes nothing and skips validate when mutate changes nothing', async () => {
  await withConfig(async (dir, file) => {
    touch(file);
    const before = statSync(file, { bigint: true }).mtimeNs;
    let validated = 0;
    const res = await editTomlFile(file, (text) => ({ text, changes: [] }), {
      validate: async () => { validated += 1; return true; },
    });
    assert.deepEqual(res, { changed: false, changes: [] });
    assert.equal(validated, 0);
    assert.equal(statSync(file, { bigint: true }).mtimeNs, before);
  });
});

test('validate false restores the original bytes', async () => {
  await withConfig(async (dir, file) => {
    const before = sha(readFileSync(file));
    const logged = [];
    const saved = { ...console };
    for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = (...args) => logged.push(args);
    let seen = null;
    let res;
    try {
      res = await editTomlFile(file, addFallback, {
        validate: async () => { seen = readFileSync(file, 'utf8'); return false; },
      });
    } finally {
      Object.assign(console, saved);
    }
    assert.deepEqual(res, { changed: false, changes: ['project_doc_fallback_filenames'], error: RESTORED });
    assert.equal(seen, insertTopLevel(FIXTURE, [FALLBACK]), 'validate runs against the written edit');
    assert.equal(sha(readFileSync(file)), before);
    assert.deepEqual(logged, [], 'nothing is logged');
  });

  await withConfig(async (dir, file) => {
    const before = sha(readFileSync(file));
    const res = await editTomlFile(file, addFallback, { validate: async () => { throw new Error('codex failed'); } });
    assert.equal(res.error, RESTORED);
    assert.equal(sha(readFileSync(file)), before);
  });
});

test('a restore that fails returns an error without content and never throws', async () => {
  await withConfig(async (dir, file) => {
    let res;
    try {
      res = await editTomlFile(file, addFallback, {
        // The dir turns read-only after the write, so the restore's temp file cannot be created.
        validate: async () => { chmodSync(dir, 0o500); return false; },
      });
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.deepEqual(res, {
      changed: false, changes: ['project_doc_fallback_filenames'], error: 'codex rejected the edited config; restore failed',
    });
    assert.doesNotMatch(res.error, /placeholder|CLAUDE\.md/, 'no config content in the error');
  });
});

test('validate must resolve to the literal true', async () => {
  for (const verdict of [1, 'true', {}, [true]]) {
    await withConfig(async (dir, file) => {
      const res = await editTomlFile(file, addFallback, { validate: async () => verdict });
      assert.equal(res.error, RESTORED, JSON.stringify(verdict));
      assert.equal(readFileSync(file, 'utf8'), FIXTURE);
    });
  }
});

test('keeps file mode 0600', async () => {
  await withConfig(async (dir, file) => {
    const ok = await editTomlFile(file, addFallback, { validate: async () => true });
    assert.equal(ok.changed, true);
    assert.equal(mode(file), 0o600);
    await editTomlFile(file, (text) => ({ text: removeTopLevelKey(text, 'project_doc_fallback_filenames'), changes: [] }), {
      validate: async () => false,
    });
    assert.equal(mode(file), 0o600, 'after a restore too');
  });
});

test('no backup file is created', async () => {
  await withConfig(async (dir, file) => {
    const listing = readdirSync(dir).sort();
    await editTomlFile(file, addFallback, { validate: async () => true });
    assert.deepEqual(readdirSync(dir).sort(), listing);
    await editTomlFile(file, (text) => setTableKey(text, SUPERPOWERS, 'enabled', 'false'), {
      validate: async () => false,
    });
    assert.deepEqual(readdirSync(dir).sort(), listing);
  });
});

test('editTomlFile edits the real file behind a symlink', async () => {
  await withConfig(async (dir, file) => {
    const link = join(dir, 'link.toml');
    symlinkSync('config.toml', link);
    const res = await editTomlFile(link, addFallback, { validate: async () => true });
    assert.equal(res.changed, true);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(file, 'utf8'), insertTopLevel(FIXTURE, [FALLBACK]));
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'link.toml']);
  });
});
