import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../lib/config.mjs';
import { readFileSync } from 'node:fs';
import { SECRET_PATTERNS, isCovered, contentVerdict, foldTerm, termHits, localDay, selectForInsights } from '../lib/policy.mjs';
import { emptyRepos } from '../lib/repo.mjs';

const TERMS = ['acme', 'globex', 'initech', 'umbrella'];
const cfg = (over = {}) => ({ ...structuredClone(DEFAULTS), allowlist: ['Delta Works', 'alpha'], clientTerms: [...TERMS], ...over });

// Runs fn with TZ set, restoring the previous value (or unsetting it) in a finally.
function withTz(tz, fn) {
  const had = Object.hasOwn(process.env, 'TZ');
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (had) process.env.TZ = prev;
    else delete process.env.TZ;
  }
}

// ---- isCovered ----

test('isCovered: exact name, worktree key and merged_into match; look-alikes do not', () => {
  const c = cfg();
  assert.equal(isCovered({ project: 'Delta Works', merged_into_project: null, cwd: null }, c, emptyRepos()), true);
  assert.equal(isCovered({ project: 'Delta Works/Delta Works-wt', merged_into_project: null, cwd: null }, c, emptyRepos()), true);
  assert.equal(isCovered({ project: 'Delta WorksX', merged_into_project: null, cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: 'delta works', merged_into_project: null, cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: 'other', merged_into_project: null, cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: 'other', merged_into_project: 'alpha', cwd: null }, c, emptyRepos()), true);
  assert.equal(isCovered({ project: 'other', merged_into_project: 'alphabet', cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: '', merged_into_project: null, cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: null, merged_into_project: null, cwd: null }, c, emptyRepos()), false);
});

test('isCovered: a neverSend name is never covered', () => {
  const c = cfg({ allowlist: ['alpha', 'secretproj'], neverSend: ['secretproj'] });
  assert.equal(isCovered({ project: 'secretproj', merged_into_project: null, cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: 'secretproj/wt', merged_into_project: null, cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: 'alpha', merged_into_project: 'secretproj', cwd: null }, c, emptyRepos()), false);
  assert.equal(isCovered({ project: 'alpha', merged_into_project: null, cwd: null }, c, emptyRepos()), true);
});

// ---- contentVerdict ----

const clean = { project: 'alpha', title: 'Fixed the parser', narrative: 'Plain text.', facts: '["one","two"]' };

test('contentVerdict: clean note is ok', () => {
  assert.equal(contentVerdict(clean, cfg()), 'ok');
  assert.equal(contentVerdict({ project: 'alpha', title: null, narrative: null, facts: null }, cfg()), 'ok');
});

test('contentVerdict: a client term in title, narrative, facts or project key gives client, case-insensitively', () => {
  const c = cfg({ allowlist: ['alpha', 'hooli'] });
  assert.equal(contentVerdict({ ...clean, title: 'Talk to ACME about it' }, c), 'client');
  assert.equal(contentVerdict({ ...clean, narrative: 'The Globex export broke' }, c), 'client');
  assert.equal(contentVerdict({ ...clean, facts: '["ok","uses Initech API"]' }, c), 'client');
  assert.equal(contentVerdict({ ...clean, project: 'hooli/acme-x' }, c), 'client');
});

test('contentVerdict: client terms win over secret patterns', () => {
  const s = 'sk' + '-' + 'a'.repeat(24);
  assert.equal(contentVerdict({ ...clean, title: 'acme ' + s }, cfg()), 'client');
});

// One runtime-concatenated sample per spec 9 pattern, in spec order.
const SAMPLES = [
  'sk' + '-' + 'a'.repeat(24),
  'AI' + 'za' + 'b'.repeat(35),
  'gh' + 'p' + '_' + 'A'.repeat(36),
  'github' + '_pat_' + 'a'.repeat(25),
  'xo' + 'xb' + '-' + '1234567890ab',
  'AK' + 'IA' + 'A'.repeat(16),
  '-----' + 'BEGIN PRIVATE KEY',
  'Bear' + 'er ' + 'a'.repeat(30),
  'postgres' + '://' + 'user:' + 'hunter2' + '@host',
  'PASS' + 'WORD' + ' = ' + 'x'.repeat(14),
  'vck' + '_' + 'a'.repeat(24),
  'ey' + 'J' + 'a'.repeat(22) + '.' + 'b'.repeat(22),
  'sk' + '_live_' + 'a1B2c3D4e5F6g7H8i9',
];

test('SECRET_PATTERNS: one pattern per spec 9 item, none global, none with an inline modifier group', () => {
  assert.equal(SECRET_PATTERNS.length, SAMPLES.length);
  for (const re of SECRET_PATTERNS) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.global, false);
    assert.equal(re.sticky, false);
    assert.ok(!re.source.includes('(?i'), re.source);
  }
  assert.equal(SECRET_PATTERNS[9].flags, 'i');
});

test('SECRET_PATTERNS: each sample is matched by its own pattern', () => {
  SAMPLES.forEach((s, i) => assert.ok(SECRET_PATTERNS[i].test(s), `pattern ${i}`));
});

test('contentVerdict: every secret sample in title, narrative or facts gives secret', () => {
  for (const s of SAMPLES) {
    assert.equal(contentVerdict({ ...clean, title: `x ${s} y` }, cfg()), 'secret');
    assert.equal(contentVerdict({ ...clean, narrative: `x ${s} y` }, cfg()), 'secret');
    assert.equal(contentVerdict({ ...clean, facts: JSON.stringify([s]) }, cfg()), 'secret');
  }
});

test('contentVerdict: near misses are ok', () => {
  const near = [
    'the password is short', 'password: tiny', 'sk-short', 'sk' + '_live_' + 'short', 'Bearer shorttoken', 'ghp_tooshort',
    'http://example.com/path', 'AKIA123', 'no key here',
  ];
  for (const t of near) assert.equal(contentVerdict({ ...clean, narrative: t }, cfg()), 'ok', t);
});

test('contentVerdict: a secret in the project key alone is not a secret verdict', () => {
  assert.equal(contentVerdict({ ...clean, project: 'sk' + '-' + 'a'.repeat(24) }, cfg()), 'ok');
});

// ---- content filter bypasses (fix round 1) ----

test('contentVerdict: quoted and unquoted key-value secrets give secret; a short value stays ok', () => {
  const v = 'a1'.repeat(8); // 16 characters
  const k = 'api' + '_key';
  const forms = [
    `{"${k}": "${v}"}`, // JSON, double quotes
    `{'${k}': '${v}'}`, // JSON-like, single quotes
    `${'to' + 'ken'}: ${v}`, // YAML
    `${k.toUpperCase()}=${v}`, // env
    `"${'pass' + 'word'}":"${v}"`, // JSON without spaces
  ];
  for (const f of forms) assert.equal(contentVerdict({ ...clean, narrative: `cfg ${f} end` }, cfg()), 'secret', f);
  for (const f of forms) assert.equal(contentVerdict({ ...clean, facts: JSON.stringify([f]) }, cfg()), 'secret', f);
  const shortV = 'a1'.repeat(4); // 8 characters; a closing quote and brace count toward the 12, so stay well under
  for (const f of [`{"${k}": "${shortV}"}`, `${'to' + 'ken'}: ${shortV}`, `${k.toUpperCase()}=${shortV}`]) {
    assert.equal(contentVerdict({ ...clean, narrative: f }, cfg()), 'ok', f);
  }
});

test('contentVerdict: non-string facts, title and narrative are checked as JSON text', () => {
  const s = 'sk' + '-' + 'a'.repeat(24);
  assert.equal(contentVerdict({ ...clean, facts: ['one', 'uses Initech API'] }, cfg()), 'client');
  assert.equal(contentVerdict({ ...clean, facts: ['one', s] }, cfg()), 'secret');
  assert.equal(contentVerdict({ ...clean, facts: { note: 'acme' } }, cfg()), 'client');
  assert.equal(contentVerdict({ ...clean, title: { a: s } }, cfg()), 'secret');
  assert.equal(contentVerdict({ ...clean, narrative: ['umbrella'] }, cfg()), 'client');
  assert.equal(contentVerdict({ ...clean, facts: ['one', 'two'] }, cfg()), 'ok');
  assert.equal(contentVerdict({ project: 'alpha', title: undefined, narrative: null }, cfg()), 'ok');
});

test('contentVerdict: zero-width characters and fullwidth forms do not hide a client term or a secret', () => {
  assert.equal(contentVerdict({ ...clean, title: 'ac\u200Bme notes' }, cfg()), 'client');
  for (const zw of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']) {
    assert.equal(contentVerdict({ ...clean, narrative: `ac${zw}me` }, cfg()), 'client', JSON.stringify(zw));
  }
  assert.equal(contentVerdict({ ...clean, narrative: '\uFF21\uFF43\uFF4D\uFF45' }, cfg()), 'client');
  assert.equal(contentVerdict({ ...clean, facts: '["\uFF47\uFF4C\uFF4F\uFF42\uFF45\uFF58"]' }, cfg()), 'client');
  assert.equal(contentVerdict({ ...clean, project: 'init\u200Bech/x' }, cfg()), 'client');
  const s = 'sk' + '-' + 'a'.repeat(24);
  assert.equal(contentVerdict({ ...clean, narrative: `s\u200Bk-${'a'.repeat(24)}` }, cfg()), 'secret');
  assert.equal(contentVerdict({ ...clean, narrative: '\uFF54\uFF4F\uFF4B\uFF45\uFF4E: ' + 'a1'.repeat(8) }, cfg()), 'secret');
  assert.equal(contentVerdict({ ...clean, narrative: `plain ${s.slice(0, 5)}` }, cfg()), 'ok');
});

// ---- content filter hardening (fix round 2) ----

test('contentVerdict: default-ignorable characters (soft hyphen and others) do not hide a client term', () => {
  for (const ch of ['\u00AD', '\u034F', '\u180E', '\u2064', '\uFE0F', '\u3164']) {
    assert.equal(contentVerdict({ ...clean, narrative: `ac${ch}me` }, cfg()), 'client', JSON.stringify(ch));
  }
  assert.equal(contentVerdict({ ...clean, narrative: 'sk\u00AD-' + 'a'.repeat(24) }, cfg()), 'secret');
});

test('contentVerdict: \\uXXXX escapes in stored text are decoded before the checks', () => {
  assert.equal(contentVerdict({ ...clean, facts: '["ac\\u200Bme"]' }, cfg()), 'client'); // escaped zero-width space
  assert.equal(contentVerdict({ ...clean, facts: '["\\u0041cme"]' }, cfg()), 'client'); // escaped plain letter
  assert.equal(contentVerdict({ ...clean, facts: '["\\uD835\\uDC1Acme"]' }, cfg()), 'client'); // surrogate pair, math bold a
  assert.equal(contentVerdict({ ...clean, facts: '["\\uff41cme"]' }, cfg()), 'client'); // lowercase hex, fullwidth a
  assert.equal(contentVerdict({ ...clean, facts: '["s\\u006b-' + 'a'.repeat(24) + '"]' }, cfg()), 'secret');
  assert.equal(contentVerdict({ ...clean, facts: '["\\u00zz and \\u12"]' }, cfg()), 'ok'); // not escapes
});

test('contentVerdict: accents on a client term do not hide it, in either direction', () => {
  assert.equal(contentVerdict({ ...clean, narrative: 'acm\u00E9' }, cfg()), 'client'); // precomposed
  assert.equal(contentVerdict({ ...clean, narrative: 'acm' + 'e\u0301' }, cfg()), 'client'); // combining
  assert.equal(contentVerdict({ ...clean, project: 'x/Umbr\u00E9lla' }, cfg()), 'client');
  assert.equal(contentVerdict({ ...clean, narrative: 'the cafe' }, cfg({ clientTerms: ['caf\u00E9'] })), 'client'); // accent on the term
  assert.equal(contentVerdict({ ...clean, narrative: 'plain text' }, cfg({ clientTerms: ['caf\u00E9'] })), 'ok');
});

test('contentVerdict: a "=>" separator is a key-value secret', () => {
  const k = 'api' + '_key';
  const v = 'a1'.repeat(8);
  for (const f of [`'${k}' => '${v}'`, `"${k}"=>"${v}"`, `${'to' + 'ken'} => ${v}`]) {
    assert.equal(contentVerdict({ ...clean, narrative: f }, cfg()), 'secret', f);
  }
  assert.equal(contentVerdict({ ...clean, narrative: `'${k}' => 'short'` }, cfg()), 'ok');
});

test('contentVerdict: a client term that canonicalises to empty is dropped, not a match-all', () => {
  const c = cfg({ clientTerms: ['\u200B', '\u00AD\u2060', 'acme'] });
  assert.equal(contentVerdict(clean, c), 'ok');
  assert.equal(contentVerdict({ ...clean, title: 'about Acme' }, c), 'client');
  assert.equal(contentVerdict(clean, cfg({ clientTerms: ['\u200B'] })), 'ok');
});

test('contentVerdict: a multi-word client term matches across any run of whitespace, in every field and in the term', () => {
  const c = cfg({ clientTerms: ['acme corp'] });
  for (const gap of ['\n', '  ', '\t', ' \r\n ', ' ', ' ']) {
    const split = `acme${gap}corp`;
    assert.equal(contentVerdict({ ...clean, title: `The ${split} migration` }, c), 'client', `title ${JSON.stringify(gap)}`);
    assert.equal(contentVerdict({ ...clean, narrative: `ran ${split} job` }, c), 'client', `narrative ${JSON.stringify(gap)}`);
    assert.equal(contentVerdict({ ...clean, facts: JSON.stringify(['x', split]) }, c), 'client', `facts ${JSON.stringify(gap)}`);
    assert.equal(contentVerdict({ ...clean, project: `x/${split}` }, c), 'client', `project ${JSON.stringify(gap)}`);
  }
  // facts stored as ASCII JSON carry the newline as a literal \n escape inside the string: that is not whitespace text.
  assert.equal(contentVerdict({ ...clean, facts: JSON.stringify(['Acme\nCorp']) }, c), 'client');
  // the term itself may be written with extra whitespace
  assert.equal(contentVerdict({ ...clean, title: 'Acme Corp' }, cfg({ clientTerms: ['acme \n  corp'] })), 'client');
  // different words stay different
  assert.equal(contentVerdict({ ...clean, title: 'acmecorp and acme inc' }, c), 'ok');
});

test('contentVerdict: a term starting with n, r or t after a backslash still matches (Windows paths, JSON-escaped backslashes)', () => {
  assert.equal(contentVerdict({ ...clean, facts: '["path C:\\\\nimbus-driver"]' }, cfg({ clientTerms: ['nimbus'] })), 'client');
  assert.equal(contentVerdict({ ...clean, narrative: 'edited C:\\clients\\tesla\\repo' }, cfg({ clientTerms: ['tesla', 'nike'] })), 'client');
  assert.equal(contentVerdict({ ...clean, narrative: 'see C:\\work\\nike' }, cfg({ clientTerms: ['tesla', 'nike'] })), 'client');
  assert.equal(contentVerdict({ ...clean, narrative: 'C:\\work\\reports' }, cfg({ clientTerms: ['reports'] })), 'client');
  // a literal backslash-n inside stored facts JSON still reads as a space between words
  assert.equal(contentVerdict({ ...clean, facts: '["Acme\\nCorp"]' }, cfg({ clientTerms: ['acme corp'] })), 'client');
  assert.equal(contentVerdict({ ...clean, facts: '["Acme\\tCorp\\r"]' }, cfg({ clientTerms: ['acme corp'] })), 'client');
  // a clean note with a Windows path and no term stays ok
  assert.equal(contentVerdict({ ...clean, narrative: 'edited C:\\work\\tools\\repo and C:\\new\\run' }, cfg({ clientTerms: ['acme corp', 'tesla'] })), 'ok');
});

test('contentVerdict: a whitespace-only client term is dropped, not a match-all', () => {
  assert.equal(contentVerdict(clean, cfg({ clientTerms: [' ', '\n\t', '​ ​'] })), 'ok');
  assert.equal(contentVerdict({ ...clean, title: 'about Acme' }, cfg({ clientTerms: [' ', 'acme'] })), 'client');
});

// ---- localDay ----

test('localDay formats local time as YYYY-MM-DD', () => {
  withTz('UTC', () => assert.equal(localDay(Date.UTC(2026, 9, 7, 23, 59)), '2026-10-07'));
  withTz('America/Argentina/Buenos_Aires', () => {
    assert.equal(localDay(Date.UTC(2026, 9, 8, 2, 30)), '2026-10-07'); // 23:30 local
    assert.equal(localDay(Date.UTC(2026, 9, 8, 3, 30)), '2026-10-08'); // 00:30 local
  });
  withTz('UTC', () => assert.equal(localDay(Date.UTC(2026, 0, 5)), '2026-01-05'));
});

// ---- selectForInsights ----

const DAY = 86400000;
const D0 = Date.UTC(2026, 9, 1); // 2026-10-01 00:00 UTC
let nextId = 1;
const row = (day, hour, over = {}) => ({
  id: nextId++, project: 'alpha', merged_into_project: null, agent_id: null,
  created_at_epoch: D0 + day * DAY + hour * 3600000, type: 'note', title: 't', narrative: 'n', facts: '[]', ...over,
});
const win3 = { startMs: D0, endMs: D0 + 3 * DAY };
const byDay = (rows) => rows.map((r) => localDay(r.created_at_epoch));

test('selectForInsights: out-of-window and uncovered rows are not candidates', () => withTz('UTC', () => {
  const rows = [
    row(0, 1), row(1, 1),
    row(-1, 23), // before the window
    row(3, 0), // at endMs: outside the half-open window
    row(1, 2, { project: 'stranger' }),
    row(1, 3, { project: 'stranger', merged_into_project: 'alpha' }), // covered through the merge
  ];
  const r = selectForInsights(rows, cfg(), win3, emptyRepos());
  assert.equal(r.counts.candidates, 3);
  assert.equal(r.counts.sent, 3);
  assert.equal(r.selected.length, 3);
}));

test('selectForInsights: a row exactly at startMs is in the window', () => withTz('UTC', () => {
  const r = selectForInsights([row(0, 0)], cfg(), win3, emptyRepos());
  assert.equal(r.counts.candidates, 1);
  assert.equal(r.selected.length, 1);
}));

test('selectForInsights: subagent rows are counted and never selected; dropped rows are counted', () => withTz('UTC', () => {
  const rows = [
    row(0, 1), row(0, 2, { agent_id: 'a1' }), row(1, 1, { agent_id: 'a2' }),
    row(1, 2, { title: 'about Acme' }),
    row(1, 3, { narrative: 'key ' + 'sk' + '-' + 'z'.repeat(24) }),
    row(2, 1), row(2, 2, { agent_id: 'a3', title: 'acme' }),
  ];
  const r = selectForInsights(rows, cfg(), win3, emptyRepos());
  assert.deepEqual(r.counts, { candidates: 7, subagent: 3, client: 1, secret: 1, sent: 2, overBudget: 0 });
  assert.ok(r.selected.every((x) => x.agent_id === null));
}));

test('selectForInsights: budget 6 over 3 days gives 2 per day', () => withTz('UTC', () => {
  const rows = [];
  for (let d = 0; d < 3; d++) for (let h = 1; h <= 5; h++) rows.push(row(d, h));
  const r = selectForInsights(rows, cfg({ maxObservations: 6 }), win3, emptyRepos());
  assert.equal(r.selected.length, 6);
  assert.deepEqual(byDay(r.selected), ['2026-10-01', '2026-10-01', '2026-10-02', '2026-10-02', '2026-10-03', '2026-10-03']);
  assert.deepEqual(r.counts, { candidates: 15, subagent: 0, client: 0, secret: 0, sent: 6, overBudget: 9 });
}));

test('selectForInsights: slots fill newest first within a day', () => withTz('UTC', () => {
  const rows = [row(0, 1), row(0, 2), row(0, 3)];
  const r = selectForInsights(rows, cfg({ maxObservations: 2 }), { startMs: D0, endMs: D0 + DAY }, emptyRepos());
  assert.deepEqual(r.selected.map((x) => x.created_at_epoch), [rows[1].created_at_epoch, rows[2].created_at_epoch]);
}));

test('selectForInsights: budget 7 over 3 days gives the remainder to the newest day', () => withTz('UTC', () => {
  const rows = [];
  for (let d = 0; d < 3; d++) for (let h = 1; h <= 5; h++) rows.push(row(d, h));
  const r = selectForInsights(rows, cfg({ maxObservations: 7 }), win3, emptyRepos());
  const days = byDay(r.selected);
  assert.equal(days.filter((x) => x === '2026-10-01').length, 2);
  assert.equal(days.filter((x) => x === '2026-10-02').length, 2);
  assert.equal(days.filter((x) => x === '2026-10-03').length, 3);
}));

test('selectForInsights: a day with one row gives its spare slot to the newest day with spare rows', () => withTz('UTC', () => {
  const rows = [row(0, 1)];
  for (let h = 1; h <= 5; h++) rows.push(row(1, h), row(2, h));
  const r = selectForInsights(rows, cfg({ maxObservations: 6 }), win3, emptyRepos());
  const days = byDay(r.selected);
  assert.equal(days.filter((x) => x === '2026-10-01').length, 1);
  assert.equal(days.filter((x) => x === '2026-10-02').length, 2);
  assert.equal(days.filter((x) => x === '2026-10-03').length, 3);
  assert.equal(r.counts.sent, 6);
  assert.equal(r.counts.overBudget, 5);
}));

test('selectForInsights: days without rows leave their whole quota to the days that have rows', () => withTz('UTC', () => {
  const rows = [];
  for (let h = 1; h <= 10; h++) rows.push(row(0, h)); // newest days 2026-10-02 and 10-03 are empty
  const r = selectForInsights(rows, cfg({ maxObservations: 6 }), win3, emptyRepos());
  assert.equal(r.selected.length, 6);
  assert.equal(r.counts.overBudget, 4);
  const r2 = selectForInsights(rows, cfg({ maxObservations: 7 }), win3, emptyRepos());
  assert.equal(r2.selected.length, 7);
}));

test('selectForInsights: spare slots stop when candidates run out', () => withTz('UTC', () => {
  const rows = [row(0, 1), row(1, 1), row(2, 1), row(2, 2)];
  const r = selectForInsights(rows, cfg({ maxObservations: 600 }), win3, emptyRepos());
  assert.equal(r.selected.length, 4);
  assert.equal(r.counts.overBudget, 0);
}));

test('selectForInsights: selected is sorted oldest first', () => withTz('UTC', () => {
  const rows = [row(2, 5), row(0, 3), row(1, 2), row(0, 1), row(2, 1)];
  const r = selectForInsights(rows, cfg({ maxObservations: 600 }), win3, emptyRepos());
  const t = r.selected.map((x) => x.created_at_epoch);
  assert.deepEqual(t, [...t].sort((a, b) => a - b));
}));

test('selectForInsights: counts add up and the input is not mutated', () => withTz('UTC', () => {
  const rows = [
    row(0, 1), row(0, 2), row(0, 3), row(1, 1, { agent_id: 'x' }), row(1, 2, { title: 'umbrella' }),
    row(1, 3, { facts: '["' + 'AK' + 'IA' + 'B'.repeat(16) + '"]' }), row(2, 1), row(2, 2), row(2, 3),
  ];
  const copy = structuredClone(rows);
  const r = selectForInsights(rows, cfg({ maxObservations: 4 }), win3, emptyRepos());
  const c = r.counts;
  assert.equal(c.candidates, c.subagent + c.client + c.secret + c.sent + c.overBudget);
  assert.equal(c.sent, r.selected.length);
  assert.equal(c.sent, 4);
  assert.deepEqual(rows, copy);
}));

test('selectForInsights: a window from 23:00 to 01:00 local counts two days (Buenos Aires)', () => withTz('America/Argentina/Buenos_Aires', () => {
  // 23:00 local on 2026-10-06 is 02:00 UTC on 10-07.
  const startMs = Date.UTC(2026, 9, 7, 2, 0);
  const endMs = startMs + 2 * 3600000;
  const mk = (ms) => row(0, 0, { created_at_epoch: ms });
  const rows = [mk(startMs + 600000), mk(startMs + 1200000), mk(startMs + 3600000 + 600000), mk(startMs + 3600000 + 1200000)];
  const r = selectForInsights(rows, cfg({ maxObservations: 2 }), { startMs, endMs }, emptyRepos());
  assert.deepEqual(byDay(r.selected), ['2026-10-06', '2026-10-07']); // 1 per day, so two days
  assert.equal(r.counts.sent, 2);
  assert.equal(r.counts.overBudget, 2);
}));

test('selectForInsights: a window inside one local day counts one day; an empty input is all zeros', () => withTz('UTC', () => {
  const r = selectForInsights([], cfg(), win3, emptyRepos());
  assert.deepEqual(r.counts, { candidates: 0, subagent: 0, client: 0, secret: 0, sent: 0, overBudget: 0 });
  assert.deepEqual(r.selected, []);
}));

// ---- a literal term next to an incomplete or look-alike \u escape ----

test('contentVerdict: a literal client term after a \\u plus hex digits is still caught (the decode must not eat it)', () => {
  const c = cfg({ clientTerms: ['acme', 'cadexo'] });
  // `\u12ac` decodes to one character and used to swallow the "ac" of "acme"; `\u0cad` the "cad" of "cadexo".
  assert.equal(contentVerdict({ ...clean, narrative: 'x\\u12acme y' }, c), 'client');
  assert.equal(contentVerdict({ ...clean, title: '\\u0cadexo' }, c), 'client');
  assert.equal(contentVerdict({ ...clean, facts: JSON.stringify(['\\u00acme']) }, c), 'client');
});

test('contentVerdict: a secret written only as \\uXXXX escapes is caught on the raw text', () => {
  const secret = `password: "${'\\u0070'.repeat(3)}`; // decodes to three characters, below the 12 the pattern needs
  assert.equal(contentVerdict({ ...clean, narrative: secret }, cfg()), 'secret');
  assert.equal(contentVerdict({ ...clean, facts: JSON.stringify([secret]) }, cfg()), 'secret');
});

// Deterministic xorshift so a failure reproduces.
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

test('contentVerdict: random noise around a literal client term never hides it', () => {
  const rand = prng(20261007);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const hex = '0123456789abcdefABCDEF';
  const hexRun = (n) => Array.from({ length: n }, () => pick([...hex])).join('');
  const pieces = [
    () => '\\u' + hexRun(Math.floor(rand() * 4)), // \u plus 0-3 hex digits: an incomplete escape
    () => '\\u' + hexRun(4), // a complete escape
    () => hexRun(1 + Math.floor(rand() * 4)),
    () => pick([' ', '  ', '\n', '\\n', '\\t', '\\\\', '"', '[', ']', ',', ':', '/', '-']),
    () => pick(['x', 'Zz', 'ñ', 'é', '字', 'abc', '_']),
  ];
  const noise = () => Array.from({ length: Math.floor(rand() * 4) }, () => pick(pieces)()).join('');
  const terms = ['acme', 'cadexo', 'globex', 'acme corp', 'initech'];
  const c = cfg({ clientTerms: terms });
  for (let i = 0; i < 2000; i += 1) {
    const term = pick(terms);
    const text = noise() + pick([term, term.toUpperCase()]) + noise();
    for (const field of ['title', 'narrative', 'facts']) {
      assert.equal(contentVerdict({ ...clean, [field]: text }, c), 'client', JSON.stringify({ field, text }));
    }
  }
});

// ---- foldTerm (Ruling 4) -------------------------------------------------------------------------------------------

test('foldTerm: the folded string contentVerdict compares on; empty when the term folds to nothing', () => {
  assert.equal(foldTerm('Acme  Corp'), 'acme corp');
  assert.equal(foldTerm('  Caf\u00E9 '), 'cafe');
  assert.equal(foldTerm('A\u200BCME'), 'acme');
  assert.equal(foldTerm('\\u0041cme'), 'acme', 'a literal escape is decoded like in the content check');
  for (const empty of ['', ' ', '\u0301', '\u200B', '\\u200b', '\\u200B\\u2060', ' \u0301\u200B ', '\\ufeff', '\\u0301']) {
    assert.equal(foldTerm(empty), '', JSON.stringify(empty));
  }
  for (const notText of [undefined, null, 5, {}, []]) assert.equal(foldTerm(notText), '', String(notText));
});

test('foldTerm: a term that folds to nothing matches no text in contentVerdict either', () => {
  const obs = { project: 'p', title: 'e\u0301 \u200B plain', narrative: 'text', facts: '[]' };
  for (const term of ['\u0301', '\\u200b']) assert.equal(contentVerdict(obs, { clientTerms: [term] }), 'ok', JSON.stringify(term));
});

// ---- termHits (the client-term comparison, shared with the public export check) ----------------------------------------

test('termHits: a term matches a text in any folding contentVerdict applies', () => {
  const term = ['glob', 'ex'].join('');
  for (const text of ['The GLOBEX export', 'glo\u200Bbex', 'g\u00ADlobex', '\uFF47\uFF4C\uFF4F\uFF42\uFF45\uFF58', '\\u0067lobex', 'gl\u00F4bex']) {
    assert.equal(termHits(text, [term]), true, JSON.stringify(text));
  }
  assert.equal(termHits('see globe here', [term]), false);
  assert.equal(termHits('Acme\\ncorp here', ['acme corp']), true, 'a literal \\n reads as a space');
  assert.equal(termHits('C:\\nvidia', ['nvidia']), true, 'a literal occurrence survives the escape folding');
});

test('termHits: no match, no terms, and terms that fold to nothing never hit', () => {
  assert.equal(termHits('plain text', ['other']), false);
  assert.equal(termHits('plain text', []), false);
  assert.equal(termHits('plain text', ['', ' ', '\u200B', '\u0301', '\\u200b']), false);
  assert.equal(termHits('plain text', ['other', '\u200B', 'plain']), true);
});

test('policy.mjs does not import config.mjs (no cycle)', () => {
  const source = readFileSync(new URL('../lib/policy.mjs', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]\.\/config\.mjs['"]/.test(source));
});
