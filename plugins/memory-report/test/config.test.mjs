import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULTS, resolvePaths, loadConfig, saveConfig, allowProjects, denyProjects, insightsGate, blockTerms, unblockTerms,
  neverProjects, unneverProjects, markSetupDone, markSetupDeclined,
} from '../lib/config.mjs';
import { ensureDir, writeAtomic, readJson, appendLog, rotateLog } from '../lib/files.mjs';
import { isCovered } from '../lib/policy.mjs';
import { emptyRepos } from '../lib/repo.mjs';
import { withTempHome } from './helpers.mjs';

const put = (paths, value) => {
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, typeof value === 'string' ? value : JSON.stringify(value));
};
const mode = (p) => statSync(p).mode & 0o777;

test('resolvePaths honors each override env var', () => withTempHome(({ home, env, paths }) => {
  assert.equal(paths.home, home);
  assert.equal(paths.configFile, env.MEMORY_REPORT_CONFIG);
  assert.equal(paths.stateDir, env.MEMORY_REPORT_STATE_DIR);
  assert.equal(paths.claudeMemDir, env.MEMORY_REPORT_CLAUDE_MEM_DIR);
  assert.equal(paths.crashDir, env.MEMORY_REPORT_CRASH_DIR);
  assert.equal(paths.stateFile, join(env.MEMORY_REPORT_STATE_DIR, 'state.json'));
  assert.equal(paths.noticeFile, join(env.MEMORY_REPORT_STATE_DIR, 'notice.json'));
  assert.equal(paths.seenFile, join(env.MEMORY_REPORT_STATE_DIR, 'seen.json'));
  assert.equal(paths.lockFile, join(env.MEMORY_REPORT_STATE_DIR, 'run.lock'));
  assert.equal(paths.takeoverFile, join(env.MEMORY_REPORT_STATE_DIR, 'run.lock.takeover'));
  assert.equal(paths.logFile, join(env.MEMORY_REPORT_STATE_DIR, 'run.log'));
  assert.equal(paths.reportsDir, join(env.MEMORY_REPORT_STATE_DIR, 'reports'));
  assert.equal(paths.workDir, join(env.MEMORY_REPORT_STATE_DIR, 'memory-report-work'));
  const cm = env.MEMORY_REPORT_CLAUDE_MEM_DIR;
  assert.equal(paths.dbFile, join(cm, 'claude-mem.db'));
  assert.equal(paths.walFile, join(cm, 'claude-mem.db-wal'));
  assert.equal(paths.chromaFile, join(cm, 'chroma', 'chroma.sqlite3'));
  assert.equal(paths.settingsFile, join(cm, 'settings.json'));
  assert.equal(paths.syncStateFile, join(cm, 'chroma-sync-state.json'));
  assert.equal(paths.logsDir, join(cm, 'logs'));
}));

test('resolvePaths defaults live under the given home', () => withTempHome(({ home }) => {
  const p = resolvePaths({}, home);
  assert.equal(p.home, home);
  assert.equal(p.configFile, join(home, '.config', 'triqual', 'memory-report.json'));
  assert.equal(p.stateDir, join(home, '.local', 'state', 'triqual', 'memory-report'));
  assert.equal(p.claudeMemDir, join(home, '.claude-mem'));
  assert.equal(p.crashDir, join(home, 'Library', 'Logs', 'DiagnosticReports'));
  assert.equal(p.logFile, join(p.stateDir, 'run.log'));
  assert.equal(p.dbFile, join(home, '.claude-mem', 'claude-mem.db'));
}));

test('DEFAULTS match the spec table', () => {
  assert.deepEqual(DEFAULTS, {
    version: 1,
    allowlist: [],
    clientTerms: [],
    neverSend: [],
    suggestRoots: [],
    model: 'claude-haiku-5-5',
    claudeBin: 'claude',
    maxObservations: 600,
    maxCharsPerObservation: 600,
    intervalDays: 7,
    llmTimeoutMs: 600000,
  });
});

test('a missing file yields the defaults with no warnings', () => withTempHome(({ paths }) => {
  const r = loadConfig(paths);
  assert.deepEqual(r.config, DEFAULTS);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.unparsable, false);
  assert.equal(existsSync(paths.configFile), false);
}));

for (const [key, bad] of [
  ['allowlist', 'x'],
  ['allowlist', ['', 'a']],
  ['allowlist', ['acme/tools', 'github.com/mont*']],
  ['allowlist', ['github.com/*']],
  ['allowlist', ['https://github.com/acme/app']],
  ['neverSend', ['git@github.com:acme/app.git']],
  ['neverSend', ['gh-work/client-org/app']],
  ['clientTerms', 'acme'],
  ['clientTerms', ['acme', '']],
  ['neverSend', 'acme'],
  ['suggestRoots', ['']],
  ['maxObservations', 0],
  ['maxObservations', 1.5],
  ['model', ''],
]) {
  test(`invalid ${key} ${JSON.stringify(bad)} falls back with one warning, raw keeps it`, () => withTempHome(({ paths }) => {
    put(paths, { [key]: bad });
    const r = loadConfig(paths);
    assert.deepEqual(r.config[key], DEFAULTS[key]);
    assert.deepEqual(r.raw[key], bad);
    assert.deepEqual(r.invalidKeys, [key]);
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes(key), r.warnings[0]);
    assert.equal(r.unparsable, false);
  }));
}

for (const [key, bad] of [
  ['setupAt', 'not a date'],
  ['setupAt', 5],
  ['setupAt', ''],
  ['setupDeclinedAt', 'yesterday-ish'],
  ['setupDeclinedAt', null],
  ['noClientTermsAck', 'true'],
  ['noClientTermsAck', 1],
]) {
  test(`invalid ${key} ${JSON.stringify(bad)} stays absent from config with one warning and is in invalidKeys`, () => withTempHome(({ paths }) => {
    put(paths, { [key]: bad });
    const r = loadConfig(paths);
    assert.ok(!(key in r.config), `${key} must not appear in config`);
    assert.deepEqual(r.raw[key], bad);
    assert.deepEqual(r.invalidKeys, [key]);
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes(key), r.warnings[0]);
  }));
}

test('valid setup keys and an empty clientTerms load without warning', () => withTempHome(({ paths }) => {
  put(paths, { setupAt: '2026-10-07T10:00:00.000Z', setupDeclinedAt: '2026-10-08', noClientTermsAck: true, clientTerms: [], neverSend: [] });
  const r = loadConfig(paths);
  assert.equal(r.config.setupAt, '2026-10-07T10:00:00.000Z');
  assert.equal(r.config.setupDeclinedAt, '2026-10-08');
  assert.equal(r.config.noClientTermsAck, true);
  assert.deepEqual(r.config.clientTerms, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.invalidKeys, []);
}));

test('a missing file and an unparsable file report no invalidKeys', () => withTempHome(({ paths }) => {
  assert.deepEqual(loadConfig(paths).invalidKeys, []);
  put(paths, '{ nope');
  assert.deepEqual(loadConfig(paths).invalidKeys, []);
}));

test('several invalid keys are all listed in invalidKeys', () => withTempHome(({ paths }) => {
  put(paths, { allowlist: 'x', clientTerms: 'y', neverSend: 3 });
  const r = loadConfig(paths);
  assert.deepEqual([...r.invalidKeys].sort(), ['allowlist', 'clientTerms', 'neverSend']);
  assert.equal(r.warnings.length, 3);
}));

test('valid values are kept', () => withTempHome(({ paths }) => {
  put(paths, { allowlist: ['a b', 'é|x'], intervalDays: 3, model: 'm', unknown: { k: 1 } });
  const r = loadConfig(paths);
  assert.deepEqual(r.config.allowlist, ['a b', 'é|x']);
  assert.equal(r.config.intervalDays, 3);
  assert.equal(r.config.model, 'm');
  assert.deepEqual(r.warnings, []);
}));

test('an unparsable file yields the defaults, unparsable true and one warning', () => withTempHome(({ paths }) => {
  for (const text of ['{ nope', '[]', 'null', '']) {
    put(paths, text);
    const r = loadConfig(paths);
    assert.deepEqual(r.config, DEFAULTS, text);
    assert.equal(r.unparsable, true, text);
    assert.equal(r.warnings.length, 1, text);
  }
}));

test('loadConfig results never alias DEFAULTS', () => withTempHome(({ paths }) => {
  const r = loadConfig(paths);
  r.config.allowlist.push('mutated');
  r.config.clientTerms.push('mutated');
  assert.deepEqual(DEFAULTS.allowlist, []);
  assert.ok(!DEFAULTS.clientTerms.includes('mutated'));
}));

test('saveConfig keeps an unknown key, file mode 0600, dir mode 0700', () => withTempHome(({ paths }) => {
  saveConfig(paths, { ...DEFAULTS, futureKey: { a: 1 } });
  assert.equal(JSON.parse(readFileSync(paths.configFile, 'utf8')).futureKey.a, 1);
  assert.equal(mode(paths.configFile), 0o600);
  assert.equal(mode(dirname(paths.configFile)), 0o700);
  assert.equal(loadConfig(paths).raw.futureKey.a, 1);
}));

test('allowProjects adds once, trims, and creates the file with only the keys it changes', () => withTempHome(({ paths }) => {
  assert.deepEqual(allowProjects(paths, ['a', ' b ', 'a']), ['a', 'b']);
  assert.deepEqual(allowProjects(paths, ['b', 'c']), ['a', 'b', 'c']);
  const saved = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  assert.deepEqual(saved, { version: 1, allowlist: ['a', 'b', 'c'] });
  assert.ok(!('clientTerms' in saved) && !('neverSend' in saved));
  assert.equal(mode(paths.configFile), 0o600);
}));

test('after allow on a fresh home the file holds no clientTerms and loadConfig still returns the defaults', () => withTempHome(({ paths }) => {
  allowProjects(paths, ['x']);
  assert.equal(readFileSync(paths.configFile, 'utf8'), '{\n  "version": 1,\n  "allowlist": [\n    "x"\n  ]\n}\n');
  const loaded = loadConfig(paths);
  assert.deepEqual(loaded.config, { ...DEFAULTS, allowlist: ['x'] });
  assert.deepEqual(loaded.config.clientTerms, DEFAULTS.clientTerms);
  assert.deepEqual(loaded.config.neverSend, DEFAULTS.neverSend);
  assert.deepEqual(loaded.warnings, []);
}));

test('denyProjects removes and reports missing names', () => withTempHome(({ paths }) => {
  allowProjects(paths, ['a', 'b']);
  assert.deepEqual(denyProjects(paths, ['a', 'zzz']), { list: ['b'], missing: ['zzz'] });
  assert.deepEqual(loadConfig(paths).config.allowlist, ['b']);
}));

test('denyProjects on a missing file creates nothing', () => withTempHome(({ paths }) => {
  assert.deepEqual(denyProjects(paths, ['a']), { list: [], missing: ['a'] });
  assert.equal(existsSync(paths.configFile), false);
}));

test('allow and deny refuse an unparsable file and leave its bytes alone', () => withTempHome(({ paths }) => {
  put(paths, '{ not json');
  for (const fn of [() => allowProjects(paths, ['x']), () => denyProjects(paths, ['x'])]) {
    assert.throws(fn, { message: `config file is not valid JSON: ${paths.configFile}` });
  }
  assert.equal(readFileSync(paths.configFile, 'utf8'), '{ not json');
}));

test('allowProjects refuses an invalid allowlist and leaves the file alone (repo-identity spec 4.5)', () => withTempHome(({ paths }) => {
  put(paths, { clientTerms: [], allowlist: 'x' });
  const before = readFileSync(paths.configFile, 'utf8');
  assert.throws(() => allowProjects(paths, ['p']), { message: 'allowlist is invalid; fix the config first' });
  assert.equal(readFileSync(paths.configFile, 'utf8'), before);
}));

test('allowProjects preserves the raw value of other invalid keys', () => withTempHome(({ paths }) => {
  put(paths, { suggestRoots: [''], neverSend: 'x', allowlist: ['a'] });
  assert.deepEqual(allowProjects(paths, ['p']), ['a', 'p']);
  const saved = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  assert.deepEqual(saved.suggestRoots, ['']);
  assert.equal(saved.neverSend, 'x');
  assert.deepEqual(saved.allowlist, ['a', 'p']);
}));

test('files: ensureDir 0700, writeAtomic 0600 without leftovers, readJson null on missing or bad', () => withTempHome(({ home }) => {
  const dir = join(home, 'x', 'y');
  ensureDir(dir);
  assert.equal(mode(dir), 0o700);
  const f = join(dir, 'a.json');
  writeAtomic(f, '{"a":1}');
  writeAtomic(f, '{"a":2}');
  assert.equal(mode(f), 0o600);
  assert.deepEqual(readJson(f), { a: 2 });
  assert.equal(readJson(join(dir, 'nope.json')), null);
  writeFileSync(join(dir, 'bad.json'), '{x');
  assert.equal(readJson(join(dir, 'bad.json')), null);
  assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'bad.json'], 'no temp file is left behind');
}));

test('appendLog writes one line per event, mode 0600, creating the state dir', () => withTempHome(({ paths }) => {
  appendLog(paths, 'start');
  appendLog(paths, 'fail', 'reason=x\nsecond line');
  const lines = readFileSync(paths.logFile, 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z start$/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z fail reason=x second line$/);
  assert.equal(lines[2], '');
  assert.equal(mode(paths.logFile), 0o600);
  assert.equal(mode(paths.stateDir), 0o700);
}));

test('rotateLog: a log over 256 KiB keeps only its last 64 KiB, cut at a line boundary, mode 0600', () => withTempHome(({ paths }) => {
  ensureDir(paths.stateDir);
  const lines = Array.from({ length: 6000 }, (_, i) => `2026-10-07T00:00:00.000Z line-${String(i).padStart(5, '0')} ${'x'.repeat(40)}`);
  writeFileSync(paths.logFile, `${lines.join('\n')}\n`);
  assert.ok(statSync(paths.logFile).size > 256 * 1024);
  assert.equal(rotateLog(paths), true);
  const kept = readFileSync(paths.logFile, 'utf8');
  assert.ok(Buffer.byteLength(kept) <= 64 * 1024, `kept ${Buffer.byteLength(kept)} bytes`);
  assert.ok(Buffer.byteLength(kept) > 64 * 1024 - 200, 'it keeps as much of the tail as whole lines allow');
  assert.ok(kept.endsWith(`${lines.at(-1)}\n`), 'the newest line survives');
  const first = kept.split('\n')[0];
  assert.ok(lines.includes(first), 'it starts at a whole line, not mid-line');
  assert.equal(mode(paths.logFile), 0o600);
  assert.deepEqual(readdirSync(paths.stateDir), ['run.log'], 'no temp file is left behind');
}));

test('rotateLog: a small or missing log is left alone', () => withTempHome(({ paths }) => {
  assert.equal(rotateLog(paths), false);
  assert.equal(existsSync(paths.logFile), false);
  appendLog(paths, 'start');
  const before = readFileSync(paths.logFile, 'utf8');
  assert.equal(rotateLog(paths), false);
  assert.equal(readFileSync(paths.logFile, 'utf8'), before);
}));

// ---- insightsGate ----

const R1 = 'Not set up: insights are off until you run the memory-report setup (ask Claude: "set up memory-report").';
const R2 = 'Setup incomplete: insights are off until you finish the memory-report setup (ask Claude: "set up memory-report").';
const ready = (over = {}) => ({ ...structuredClone(DEFAULTS), setupAt: '2026-10-07T10:00:00.000Z', allowlist: ['acme/tools'], clientTerms: ['acme'], ...over });

test('insightsGate opens when set up, allowlisted, valid and with an effective term', () => {
  assert.deepEqual(insightsGate(ready(), []), { open: true, reason: null, failing: [] });
  assert.deepEqual(insightsGate(ready()), { open: true, reason: null, failing: [] }, 'invalidKeys is optional');
});

test('insightsGate rule 1: no setupAt gives R1 and failing setup', () => {
  const { setupAt, ...config } = ready();
  assert.deepEqual(insightsGate(config, []), { open: false, reason: R1, failing: ['setup'] });
});

test('insightsGate rule 1: a later setupDeclinedAt gives R1; an earlier one does not', () => {
  assert.deepEqual(
    insightsGate(ready({ setupDeclinedAt: '2026-10-07T10:00:01.000Z' }), []),
    { open: false, reason: R1, failing: ['setup'] },
  );
  assert.equal(insightsGate(ready({ setupDeclinedAt: '2026-10-07T09:59:59.000Z' }), []).open, true);
  assert.equal(insightsGate(ready({ setupDeclinedAt: '2026-10-07T10:00:00.000Z' }), []).open, true, 'equal is not later');
});

test('insightsGate rule 1: an unparsable setupAt counts as not set up', () => {
  assert.deepEqual(insightsGate(ready({ setupAt: 'garbage' }), []), { open: false, reason: R1, failing: ['setup'] });
});

test('insightsGate rule 2: an empty allowlist gives R2 and failing allowlist', () => {
  assert.deepEqual(insightsGate(ready({ allowlist: [] }), []), { open: false, reason: R2, failing: ['allowlist'] });
});

test('insightsGate rule 3: allowlist, clientTerms or neverSend in invalidKeys gives R2 and failing invalid', () => {
  for (const key of ['allowlist', 'clientTerms', 'neverSend']) {
    const r = insightsGate(ready(), [key]);
    assert.equal(r.open, false, key);
    assert.equal(r.reason, R2, key);
    assert.ok(r.failing.includes('invalid'), key);
  }
  assert.deepEqual(insightsGate(ready(), ['model', 'suggestRoots', 'setupAt']), { open: true, reason: null, failing: [] });
});

test('insightsGate rule 3: an invalid setupDeclinedAt closes the gate (R2 with a valid setupAt, R1 without one)', () => {
  assert.deepEqual(insightsGate(ready(), ['setupDeclinedAt']), { open: false, reason: R2, failing: ['invalid'] });
  const { setupAt, ...unset } = ready();
  assert.deepEqual(insightsGate(unset, ['setupDeclinedAt']), { open: false, reason: R1, failing: ['setup', 'invalid'] });
});

test('loading a config with an invalid setupDeclinedAt closes the gate end to end, and a valid one does not', () => withTempHome(({ paths }) => {
  put(paths, { version: 1, setupAt: '2026-10-07T10:00:00.000Z', setupDeclinedAt: 'yesterday-ish', allowlist: ['acme/tools'], clientTerms: ['acme'] });
  const bad = loadConfig(paths);
  assert.deepEqual(bad.invalidKeys, ['setupDeclinedAt']);
  assert.equal(insightsGate(bad.config, bad.invalidKeys).reason, R2);
  put(paths, { version: 1, setupAt: '2026-10-07T10:00:00.000Z', setupDeclinedAt: '2026-10-01', allowlist: ['acme/tools'], clientTerms: ['acme'] });
  const good = loadConfig(paths);
  assert.equal(insightsGate(good.config, good.invalidKeys).open, true);
}));

test('insightsGate rule 4: no effective term and no acknowledgment gives R2 and failing terms', () => {
  assert.deepEqual(insightsGate(ready({ clientTerms: [] }), []), { open: false, reason: R2, failing: ['terms'] });
  assert.deepEqual(insightsGate(ready({ clientTerms: [' '] }), []), { open: false, reason: R2, failing: ['terms'] });
  assert.deepEqual(insightsGate(ready({ clientTerms: ['\u200B'] }), []), { open: false, reason: R2, failing: ['terms'] });
  assert.deepEqual(insightsGate(ready({ clientTerms: ['\u00AD\u2060\uFEFF', ' \u200D '] }), []), { open: false, reason: R2, failing: ['terms'] });
  assert.equal(insightsGate(ready({ clientTerms: ['\u200B', 'acme'] }), []).open, true, 'one effective term is enough');
});

test('insightsGate rule 4: a term that folds to nothing the way contentVerdict folds it does not count (Ruling 4)', () => {
  // A lone combining mark and a literal backslash-u escape of a zero-width character (alone, doubled, or mixed with a mark
  // and whitespace) all vanish under the content filter's folding, so they would block nothing.
  const degenerate = ['\u0301', '\\u200b', '\\u200B\\u2060', ' \u0301 ', '\\ufeff', '\u0301\u200B'];
  for (const term of degenerate) {
    assert.deepEqual(insightsGate(ready({ clientTerms: [term] }), []), { open: false, reason: R2, failing: ['terms'] }, JSON.stringify(term));
  }
  assert.equal(insightsGate(ready({ clientTerms: ['\u0301', '\\u200b', 'acme'] }), []).open, true, 'one effective term is enough');
  assert.equal(insightsGate(ready({ clientTerms: ['\u0301'], noClientTermsAck: true }), []).open, true, 'the acknowledgment still opens it');
});

test('insightsGate rule 4: noClientTermsAck true opens it, other values do not', () => {
  assert.deepEqual(insightsGate(ready({ clientTerms: [], noClientTermsAck: true }), []), { open: true, reason: null, failing: [] });
  assert.equal(insightsGate(ready({ clientTerms: [' '], noClientTermsAck: true }), []).open, true);
  assert.equal(insightsGate(ready({ clientTerms: [], noClientTermsAck: false }), []).open, false);
  assert.equal(insightsGate(ready({ clientTerms: [], noClientTermsAck: 'true' }), []).open, false);
});

test('insightsGate lists every failing rule, and R1 wins over R2 when rule 1 fails', () => {
  const { setupAt, ...config } = ready({ allowlist: [], clientTerms: [] });
  assert.deepEqual(insightsGate(config, ['neverSend']), { open: false, reason: R1, failing: ['setup', 'allowlist', 'invalid', 'terms'] });
  assert.deepEqual(insightsGate(ready({ allowlist: [], clientTerms: [] }), ['neverSend']), { open: false, reason: R2, failing: ['allowlist', 'invalid', 'terms'] });
});

test('insightsGate does not mutate its arguments', () => {
  const config = ready();
  const before = structuredClone(config);
  const invalid = ['allowlist'];
  insightsGate(config, invalid);
  assert.deepEqual(config, before);
  assert.deepEqual(invalid, ['allowlist']);
});

// ---- term and never-send edits ----

const savedOf = (paths) => JSON.parse(readFileSync(paths.configFile, 'utf8'));

test('blockTerms trims, drops empties, de-duplicates case-insensitively and writes only version and clientTerms on a fresh home', () => withTempHome(({ paths }) => {
  assert.deepEqual(blockTerms(paths, [' Acme ', 'acme', 'ACME', '  ', 'globex']), ['Acme', 'globex']);
  assert.deepEqual(blockTerms(paths, ['GLOBEX', 'initech']), ['Acme', 'globex', 'initech']);
  assert.deepEqual(savedOf(paths), { version: 1, clientTerms: ['Acme', 'globex', 'initech'] });
  assert.equal(mode(paths.configFile), 0o600);
}));

test('blockTerms clears noClientTermsAck when it adds a term, and keeps it when nothing is added', () => withTempHome(({ paths }) => {
  put(paths, { version: 1, setupAt: '2026-10-07T10:00:00.000Z', noClientTermsAck: true, clientTerms: ['acme'], other: 7 });
  blockTerms(paths, ['ACME', '  ']);
  assert.equal(savedOf(paths).noClientTermsAck, true, 'a duplicate or empty term adds nothing');
  blockTerms(paths, ['globex']);
  assert.deepEqual(savedOf(paths), { version: 1, setupAt: '2026-10-07T10:00:00.000Z', clientTerms: ['acme', 'globex'], other: 7 });
  put(paths, { version: 1, noClientTermsAck: true });
  blockTerms(paths, ['initech']);
  assert.deepEqual(savedOf(paths), { version: 1, clientTerms: ['initech'] });
}));

test('unblockTerms removes case-insensitively and reports missing terms', () => withTempHome(({ paths }) => {
  blockTerms(paths, ['Acme', 'globex']);
  assert.deepEqual(unblockTerms(paths, ['ACME', ' umbrella ', 'umbrella', '']), { list: ['globex'], missing: ['umbrella'] });
  assert.deepEqual(loadConfig(paths).config.clientTerms, ['globex']);
  assert.deepEqual(unblockTerms(paths, ['globex']), { list: [], missing: [] });
  assert.deepEqual(savedOf(paths).clientTerms, []);
}));

test('unblockTerms on a missing file creates nothing, and writes nothing when no term matched', () => withTempHome(({ paths }) => {
  assert.deepEqual(unblockTerms(paths, ['a']), { list: [], missing: ['a'] });
  assert.equal(existsSync(paths.configFile), false);
  blockTerms(paths, ['acme']);
  const before = readFileSync(paths.configFile, 'utf8');
  assert.deepEqual(unblockTerms(paths, ['zzz']), { list: ['acme'], missing: ['zzz'] });
  assert.equal(readFileSync(paths.configFile, 'utf8'), before);
}));

test('neverProjects adds trimmed names once; unneverProjects removes and reports missing', () => withTempHome(({ paths }) => {
  assert.deepEqual(neverProjects(paths, ['acme-home', ' initech ', 'acme-home', ' ']), ['acme-home', 'initech']);
  assert.deepEqual(neverProjects(paths, ['initech', 'umbrella']), ['acme-home', 'initech', 'umbrella']);
  assert.deepEqual(savedOf(paths), { version: 1, neverSend: ['acme-home', 'initech', 'umbrella'] });
  assert.deepEqual(unneverProjects(paths, ['initech', 'zzz']), { list: ['acme-home', 'umbrella'], missing: ['zzz'] });
  assert.deepEqual(loadConfig(paths).config.neverSend, ['acme-home', 'umbrella']);
}));

test('unneverProjects on a missing file creates nothing', () => withTempHome(({ paths }) => {
  assert.deepEqual(unneverProjects(paths, ['a']), { list: [], missing: ['a'] });
  assert.equal(existsSync(paths.configFile), false);
}));

test('block and never edits keep every other key, including unknown ones and other lists', () => withTempHome(({ paths }) => {
  put(paths, { version: 1, allowlist: ['acme/tools'], futureKey: { a: 1 }, setupAt: '2026-10-07T10:00:00.000Z' });
  blockTerms(paths, ['acme']);
  neverProjects(paths, ['acme-home']);
  assert.deepEqual(savedOf(paths), {
    version: 1, allowlist: ['acme/tools'], futureKey: { a: 1 }, setupAt: '2026-10-07T10:00:00.000Z', clientTerms: ['acme'], neverSend: ['acme-home'],
  });
}));

test('block, unblock, never and unnever refuse an unparsable file and leave its bytes alone', () => withTempHome(({ paths }) => {
  put(paths, '{ not json');
  for (const fn of [
    () => blockTerms(paths, ['x']), () => unblockTerms(paths, ['x']), () => neverProjects(paths, ['x']), () => unneverProjects(paths, ['x']),
    () => markSetupDone(paths, { noClientTerms: false, nowIso: '2026-10-07T10:00:00.000Z' }),
    () => markSetupDeclined(paths, { nowIso: '2026-10-07T10:00:00.000Z' }),
  ]) {
    assert.throws(fn, { message: `config file is not valid JSON: ${paths.configFile}` });
  }
  assert.equal(readFileSync(paths.configFile, 'utf8'), '{ not json');
}));

// ---- setup markers ----

test('markSetupDone on a fresh home writes only version and setupAt', () => withTempHome(({ paths }) => {
  markSetupDone(paths, { noClientTerms: false, nowIso: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { version: 1, setupAt: '2026-10-07T10:00:00.000Z' });
  assert.equal(mode(paths.configFile), 0o600);
}));

test('markSetupDone with noClientTerms writes noClientTermsAck true; without it removes the key and setupDeclinedAt', () => withTempHome(({ paths }) => {
  markSetupDone(paths, { noClientTerms: true, nowIso: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { version: 1, setupAt: '2026-10-07T10:00:00.000Z', noClientTermsAck: true });
  put(paths, { version: 1, setupDeclinedAt: '2026-10-06T00:00:00.000Z', noClientTermsAck: true, allowlist: ['acme/tools'] });
  markSetupDone(paths, { noClientTerms: false, nowIso: '2026-10-07T11:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { version: 1, allowlist: ['acme/tools'], setupAt: '2026-10-07T11:00:00.000Z' });
  put(paths, { version: 1, setupDeclinedAt: '2026-10-06T00:00:00.000Z' });
  markSetupDone(paths, { noClientTerms: true, nowIso: '2026-10-07T12:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { version: 1, setupAt: '2026-10-07T12:00:00.000Z', noClientTermsAck: true });
}));

test('markSetupDeclined writes setupDeclinedAt only, keeping setupAt and every other key', () => withTempHome(({ paths }) => {
  markSetupDeclined(paths, { nowIso: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { version: 1, setupDeclinedAt: '2026-10-07T10:00:00.000Z' });
  put(paths, { version: 1, setupAt: '2026-10-01T00:00:00.000Z', allowlist: ['acme/tools'], noClientTermsAck: true });
  markSetupDeclined(paths, { nowIso: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(savedOf(paths), {
    version: 1, setupAt: '2026-10-01T00:00:00.000Z', allowlist: ['acme/tools'], noClientTermsAck: true, setupDeclinedAt: '2026-10-07T10:00:00.000Z',
  });
  assert.equal(insightsGate(loadConfig(paths).config, []).open, false, 'a later decline closes the gate');
}));

test('setup then block: the gate follows the saved file end to end', () => withTempHome(({ paths }) => {
  allowProjects(paths, ['acme/tools']);
  markSetupDone(paths, { noClientTerms: false, nowIso: '2026-10-07T10:00:00.000Z' });
  let loaded = loadConfig(paths);
  assert.equal(insightsGate(loaded.config, loaded.invalidKeys).reason, R2);
  blockTerms(paths, ['acme']);
  loaded = loadConfig(paths);
  assert.deepEqual(insightsGate(loaded.config, loaded.invalidKeys), { open: true, reason: null, failing: [] });
}));

// ---- repository and owner entries (repo-identity spec 4.1, 4.5) ----

test('repository, owner and name entries load without warning on both lists', () => withTempHome(({ paths }) => {
  const entries = ['acme/tools', 'Acme Tools', 'github.com/acme/app', 'GitHub.com/Acme/*', 'gitlab.com/group/sub/*', 'acme.visualstudio.com/*'];
  put(paths, { allowlist: entries, neverSend: entries });
  const r = loadConfig(paths);
  assert.deepEqual(r.invalidKeys, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.config.allowlist, entries);
  assert.deepEqual(r.config.neverSend, entries);
}));

test('an invalid entry in allowlist or neverSend closes the gate end to end', () => withTempHome(({ paths }) => {
  const base = { setupAt: '2026-10-07T10:00:00.000Z', clientTerms: ['acme'], allowlist: ['acme/tools'] };
  put(paths, base);
  let loaded = loadConfig(paths);
  assert.equal(insightsGate(loaded.config, loaded.invalidKeys).open, true);
  for (const over of [{ allowlist: ['acme/tools', 'github.com/mont*'] }, { neverSend: ['client-x', 'https://github.com/acme/app'] }]) {
    put(paths, { ...base, ...over });
    loaded = loadConfig(paths);
    const gate = insightsGate(loaded.config, loaded.invalidKeys);
    assert.equal(gate.open, false, JSON.stringify(over));
    assert.ok(gate.failing.includes('invalid'), JSON.stringify(over));
  }
}));

test('an invalid never-send list keeps its valid entries as stored; the key stays invalid (Ruling 9)', () => withTempHome(({ paths }) => {
  const neverSend = ['client-x', 'github.com/mont*', 'GitHub.com/Acme/App', 7];
  put(paths, { version: 1, allowlist: ['client-x'], neverSend });
  const loaded = loadConfig(paths);
  assert.deepEqual(loaded.invalidKeys, ['neverSend']);
  assert.equal(loaded.warnings.length, 1);
  assert.deepEqual(loaded.raw.neverSend, neverSend);
  assert.deepEqual(loaded.config.neverSend, ['client-x', 'GitHub.com/Acme/App']);
  assert.equal(isCovered({ project: 'client-x', merged_into_project: null, cwd: null }, loaded.config, emptyRepos()), false);
  assert.equal(insightsGate(loaded.config, loaded.invalidKeys).open, false);
}));

test('a never-send that is not an array, and an invalid allowlist, still fall back to []', () => withTempHome(({ paths }) => {
  put(paths, { version: 1, allowlist: ['keep', 'github.com/*'], neverSend: 'client-x' });
  const loaded = loadConfig(paths);
  assert.deepEqual(loaded.config.neverSend, []);
  assert.deepEqual(loaded.config.allowlist, []);
  assert.deepEqual(loaded.invalidKeys, ['allowlist', 'neverSend']);
}));

test('every add refuses while its key is invalid, nothing written; setup markers still work', () => withTempHome(({ paths }) => {
  const raw = { version: 1, allowlist: ['keep', 'github.com/*'], neverSend: ['client-x', 'github.com/mont*'], clientTerms: ['acme', 'globex', ''] };
  put(paths, raw);
  const before = readFileSync(paths.configFile, 'utf8');
  assert.throws(() => allowProjects(paths, ['p']), { message: 'allowlist is invalid; fix the config first' });
  assert.throws(() => neverProjects(paths, ['newname']), { message: 'neverSend is invalid; fix the config first' });
  assert.throws(() => blockTerms(paths, ['initech']), { message: 'clientTerms is invalid; fix the config first' });
  assert.equal(readFileSync(paths.configFile, 'utf8'), before);
  markSetupDeclined(paths, { nowIso: '2026-10-07T10:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { ...raw, setupDeclinedAt: '2026-10-07T10:00:00.000Z' });
  markSetupDone(paths, { noClientTerms: false, nowIso: '2026-10-07T11:00:00.000Z' });
  assert.deepEqual(savedOf(paths), { ...raw, setupAt: '2026-10-07T11:00:00.000Z' });
}));

test('allowProjects and neverProjects refuse an entry the adding rules refuse, and write nothing', () => withTempHome(({ paths }) => {
  for (const entry of ['mont*', 'github.com/mont*', 'github.com/*/x', 'github.com/*', '*', 'notes/*', 'gh-work/client-org/app', 'https://github.com/acme/app']) {
    for (const fn of [allowProjects, neverProjects]) {
      assert.throws(() => fn(paths, ['ok', entry]), { message: `not a valid entry: ${entry}` }, entry);
      assert.equal(existsSync(paths.configFile), false, entry);
    }
  }
}));

test('removing from an invalid list takes the exact stored string and keeps every other entry', () => withTempHome(({ paths }) => {
  put(paths, { version: 1, neverSend: ['client-x', 'client-y', 'github.com/mont*'], clientTerms: ['acme', 'globex', ''] });
  assert.deepEqual(unneverProjects(paths, ['github.com/mont*', 'nothing-here']), { list: ['client-x', 'client-y'], missing: ['nothing-here'] });
  assert.deepEqual(unblockTerms(paths, ['ACME']), { list: ['globex', ''], missing: [] });
  assert.deepEqual(savedOf(paths), { version: 1, neverSend: ['client-x', 'client-y'], clientTerms: ['globex', ''] });
}));

test('removing falls back to the normalized form only when no stored string matches exactly', () => withTempHome(({ paths }) => {
  put(paths, { version: 1, allowlist: ['GitHub.com/Acme/App', 'github.com/acme/app', 'GitHub.com/Acme/Tools', 'github.com/acme/*'] });
  assert.deepEqual(denyProjects(paths, ['GitHub.com/Acme/App']), { list: ['github.com/acme/app', 'GitHub.com/Acme/Tools', 'github.com/acme/*'], missing: [] });
  assert.deepEqual(denyProjects(paths, ['GITHUB.com/acme/APP.git']), { list: ['GitHub.com/Acme/Tools', 'github.com/acme/*'], missing: [] });
  const normalized = new Map([['https://github.com/acme/tools.git', 'github.com/acme/tools']]);
  assert.deepEqual(denyProjects(paths, ['https://github.com/acme/tools.git'], { normalized }), { list: ['github.com/acme/*'], missing: [] });
}));

// ---- final fix M4 (Ruling 10 N1) ----

test('final fix M4: an invalid never-send array warns that it keeps its valid entries; a non-array and other keys use the default', () => withTempHome(({ paths }) => {
  put(paths, { neverSend: ['client-x', 'github.com/mont*'], allowlist: ['github.com/*'] });
  const r = loadConfig(paths);
  assert.deepEqual(r.config.neverSend, ['client-x']);
  assert.deepEqual(r.warnings, ['invalid config key: allowlist; using default', 'invalid config key: neverSend; keeping its valid entries']);
  put(paths, { neverSend: 'client-x' });
  assert.deepEqual(loadConfig(paths).warnings, ['invalid config key: neverSend; using default']);
}));
