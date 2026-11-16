import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { sessionView, startServer } from '../cli/lib/eval-serve.mjs';

const AUTH = 'test-auth-0123456789';
const HOSTILE = '<script>alert(1)</script> "quoted" </textarea>';

let root;
let sampleFile;
const servers = [];

const rec = (o) => JSON.stringify(o);
const assistant = (id, ts, tools, usage) => rec({
  type: 'assistant', timestamp: ts, requestId: `req-${id}`,
  message: {
    id: `msg-${id}`, model: 'claude-opus-4-8',
    content: tools.map((name, i) => ({ type: 'tool_use', id: `tu-${id}-${i}`, name, input: {} })),
    usage,
  },
});

before(() => {
  root = mkdtempSync(join(tmpdir(), 'eval-serve-'));
  const transcript = (name, prompt) => {
    const file = join(root, `${name}.jsonl`);
    writeFileSync(file, [
      rec({ type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: prompt } }),
      // a transcript splits one assistant message into one record per content block, each repeating the usage:
      // every block's tool is counted, the usage, context and cost once
      assistant('a1', '2026-11-01T10:00:05Z', ['Read'], { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 }),
      assistant('a1', '2026-11-01T10:00:05Z', ['Bash'], { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 }),
      rec({ type: 'user', timestamp: '2026-11-01T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-a1-0', is_error: true, content: 'boom' }] } }),
      rec({ type: 'user', isMeta: true, timestamp: '2026-11-01T10:00:07Z', message: { role: 'user', content: 'meta text' } }),
      rec({ type: 'system', subtype: 'stop_hook_summary', hookErrors: ['x'] }),
      rec({ type: 'system', subtype: 'stop_hook_summary', hookErrors: [] }),
      rec({ type: 'user', timestamp: '2026-11-01T10:00:08Z', message: { role: 'user', content: [{ type: 'text', text: 'second message' }] } }),
      assistant('a2', '2026-11-01T10:00:09Z', ['Read'], { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }),
      'not json',
    ].join('\n') + '\n');
    return file;
  };
  const rows = [
    { sessionId: 's1', project: '/p/one', file: transcript('s1', HOSTILE), stratum: 'random', usd: 1.5, turns: 2 },
    { sessionId: 's2', project: '/p/two', file: transcript('s2', 'second session prompt'), stratum: 'random', usd: 2, turns: 2 },
    { sessionId: 's3', project: '/p/three', file: transcript('s3', 'third session prompt'), stratum: 'top-cost', usd: 3, turns: 2 },
  ];
  sampleFile = join(root, 'sample.jsonl');
  writeFileSync(sampleFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
});

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function start(extra = {}) {
  const labelsFile = extra.labelsFile ?? join(root, `case-${n++}`, 'labels.jsonl');
  const server = await startServer({ sampleFile, labelsFile, port: 0, token: AUTH, ...extra });
  servers.push(server);
  return { ...server, labelsFile, port: Number(new URL(server.url).port) };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const post = (base, body, headers = {}) => fetch(`${base}/label`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-triqual-token': AUTH, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// fetch cannot override Host; node:http can.
const rawRequest = (port, { method = 'GET', path = '/', headers = {}, body }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('sessionView summarises a transcript', () => {
  const v = sessionView(join(root, 's2.jsonl'));
  assert.equal(v.firstPrompt, 'second session prompt');
  assert.deepEqual(v.ownerMessages, ['second session prompt', 'second message']);
  assert.deepEqual(v.toolCounts, { Read: 2, Bash: 1 });
  assert.deepEqual(v.ctxCurve, [1000, 1050]);
  assert.deepEqual(v.stalls, { stopHookBlocks: 1, toolErrors: 1 });
  // opus-4-8: 5 in, 25 out, 0.5 read, 6.25 write per million
  const usd = (100 * 5 + 10 * 25 + 900 * 6.25 + 50 * 5 + 20 * 25 + 1000 * 0.5) / 1e6;
  assert.ok(Math.abs(v.usd - usd) < 1e-12, `usd ${v.usd} vs ${usd}`);
});

test('binds to loopback only', async () => {
  const s = await start();
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
  assert.equal(s.address().address, '127.0.0.1');
});

test('a label is appended once', async () => {
  const s = await start();
  const base = s.url.replace(/\/$/, '');
  const first = await post(base, { sessionId: 's1', label: 'good', note: 'fine' });
  assert.equal(first.status, 200);
  const second = await post(base, { sessionId: 's1', label: 'bad', note: 'changed my mind' });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { already: true });
  const got = lines(s.labelsFile);
  assert.equal(got.length, 1);
  assert.equal(got[0].sessionId, 's1');
  assert.equal(got[0].label, 'good');
  assert.equal(got[0].note, 'fine');
  assert.ok(!Number.isNaN(Date.parse(got[0].at)));
  assert.equal(statSync(s.labelsFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(s.labelsFile, '..')).mode & 0o777, 0o700);
});

test('restart resumes after the last label', async () => {
  const s = await start();
  const base = s.url.replace(/\/$/, '');
  assert.match(await (await fetch(`${base}/`)).text(), /data-session="s1"/);
  await post(base, { sessionId: 's1', label: 'good', note: '' });
  await s.close();
  const again = await start({ labelsFile: s.labelsFile });
  const html = await (await fetch(`${again.url.replace(/\/$/, '')}/`)).text();
  assert.match(html, /data-session="s2"/);
  assert.doesNotMatch(html, /data-session="s1"/);
});

test('GET /session/:id shows that session, unknown id is 404', async () => {
  const s = await start();
  const base = s.url.replace(/\/$/, '');
  assert.match(await (await fetch(`${base}/session/s3`)).text(), /data-session="s3"/);
  assert.equal((await fetch(`${base}/session/nope`)).status, 404);
});

test('transcript text is escaped', async () => {
  const s = await start();
  const html = await (await fetch(`${s.url.replace(/\/$/, '')}/`)).text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
  assert.match(html, /&lt;\/textarea&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  assert.doesNotMatch(html, /<\/textarea> "?quoted/);
});

test('foreign Host is refused', async () => {
  const s = await start();
  const get = await rawRequest(s.port, { headers: { host: 'evil.example:80' } });
  assert.equal(get.status, 403);
  const wrongPort = await rawRequest(s.port, { headers: { host: `127.0.0.1:${s.port + 1}` } });
  assert.equal(wrongPort.status, 403);
  const body = JSON.stringify({ sessionId: 's1', label: 'good', note: '' });
  const p = await rawRequest(s.port, {
    method: 'POST', path: '/label', body,
    headers: { host: 'evil.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-triqual-token': AUTH },
  });
  assert.equal(p.status, 403);
  assert.deepEqual(lines(s.labelsFile), []);
  const ok = await rawRequest(s.port, { headers: { host: `localhost:${s.port}` } });
  assert.equal(ok.status, 200);
});

test('a foreign Origin is refused', async () => {
  const s = await start();
  const r = await post(s.url.replace(/\/$/, ''), { sessionId: 's1', label: 'good', note: '' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.deepEqual(lines(s.labelsFile), []);
});

test('missing token is refused', async () => {
  const s = await start();
  const base = s.url.replace(/\/$/, '');
  const body = JSON.stringify({ sessionId: 's1', label: 'good', note: '' });
  const none = await fetch(`${base}/label`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(none.status, 403);
  const wrong = await fetch(`${base}/label`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-triqual-token': 'wrong' }, body });
  assert.equal(wrong.status, 403);
  assert.deepEqual(lines(s.labelsFile), []);
});

test('oversized body is refused', async () => {
  const s = await start();
  const r = await post(s.url.replace(/\/$/, ''), { sessionId: 's1', label: 'good', note: 'x'.repeat(20 * 1024) });
  assert.equal(r.status, 413);
  assert.deepEqual(lines(s.labelsFile), []);
});

test('bad label value is refused', async () => {
  const s = await start();
  const base = s.url.replace(/\/$/, '');
  assert.equal((await post(base, { sessionId: 's1', label: 'meh', note: '' })).status, 400);
  assert.equal((await post(base, { sessionId: 's1', label: 'good', note: 'x'.repeat(2001) })).status, 400);
  assert.equal((await post(base, '{not json')).status, 400);
  assert.equal((await post(base, { sessionId: 's1', label: 'good', note: 5 })).status, 400);
  assert.deepEqual(lines(s.labelsFile), []);
});

test('an unknown session id is refused', async () => {
  const s = await start();
  const r = await post(s.url.replace(/\/$/, ''), { sessionId: 'nope', label: 'good', note: '' });
  assert.equal(r.status, 404);
  assert.deepEqual(lines(s.labelsFile), []);
});

test('a torn last line in labels.jsonl neither crashes nor swallows the next label', async () => {
  const labelsFile = join(root, `case-${n++}`, 'labels.jsonl');
  mkdirSync(join(labelsFile, '..'), { recursive: true });
  writeFileSync(labelsFile, `${JSON.stringify({ sessionId: 's1', label: 'good', note: '', at: '2026-11-01T00:00:00Z' })}\n{"sessionId":"s2","lab`);
  const s = await start({ labelsFile });
  const base = s.url.replace(/\/$/, '');
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-session="s2"/);
  const first = await post(base, { sessionId: 's2', label: 'bad', note: 'after the tear' });
  assert.deepEqual(await first.json(), { ok: true });
  const second = await post(base, { sessionId: 's2', label: 'good', note: 'again' });
  assert.deepEqual(await second.json(), { already: true });
  const parsed = [];
  for (const l of readFileSync(labelsFile, 'utf8').split('\n')) {
    try { parsed.push(JSON.parse(l)); } catch { /* the torn line stays, unparsed */ }
  }
  assert.deepEqual(parsed.map((r) => [r.sessionId, r.label, r.note]), [['s1', 'good', ''], ['s2', 'bad', 'after the tear']]);
});

// Cascade of the stylesheet the server actually serves, for one colour scheme. Every selector here is a single
// class or element, so specificity is equal and the later declaration wins.
function servedCascade(css, scheme) {
  const decls = [];
  const addRules = (text, dark) => {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].split(',').map((s) => s.trim())) {
        for (const d of m[2].split(';')) {
          const i = d.indexOf(':');
          if (i > 0) decls.push({ sel, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim(), dark });
        }
      }
    }
  };
  let rest = css;
  for (;;) {
    const at = rest.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
    if (!at) break;
    addRules(rest.slice(0, at.index), false);
    let depth = 1; let i = at.index + at[0].length;
    for (; i < rest.length && depth; i++) depth += rest[i] === '{' ? 1 : rest[i] === '}' ? -1 : 0;
    addRules(rest.slice(at.index + at[0].length, i - 1), true);
    rest = rest.slice(i);
  }
  addRules(rest, false);
  const active = decls.filter((d) => !d.dark || scheme === 'dark');
  const get = (sel, prop) => active.filter((d) => d.sel === sel && d.prop === prop).at(-1)?.value;
  return { decls, get };
}

const luminance = (hex) => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the served page is readable in the light and in the dark colour scheme', async () => {
  const s = await start();
  const html = await (await fetch(`${s.url.replace(/\/$/, '')}/`)).text();
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  const { decls, get } = servedCascade(css, 'dark');

  // A dark-scheme override must not be beaten by a later light rule for the same selector and property.
  for (const d of decls.filter((x) => x.dark)) {
    const later = decls.slice(decls.indexOf(d) + 1).filter((x) => !x.dark && x.sel === d.sel && x.prop === d.prop);
    assert.deepEqual(later, [], `light rule after the dark override of ${d.sel} { ${d.prop} }`);
  }

  for (const scheme of ['light', 'dark']) {
    const { get: val } = servedCascade(css, scheme);
    const bodyBg = val('body', 'background');
    const bodyFg = val('body', 'color');
    const msgBg = val('.msg', 'background');
    const msgFg = val('.msg', 'color') ?? bodyFg; // inherited when not set
    const metaFg = val('.meta', 'color');
    assert.ok(contrast(msgFg, msgBg) >= 4.5, `${scheme}: .msg text ${msgFg} on ${msgBg}`);
    assert.ok(contrast(metaFg, bodyBg) >= 4.5, `${scheme}: .meta text ${metaFg} on page ${bodyBg}`);
    assert.ok(contrast(metaFg, msgBg) >= 4.5, `${scheme}: .meta text ${metaFg} on .msg ${msgBg}`);
    // The note box and the buttons take the browser's own colours: they must follow the scheme.
    assert.equal(val('html', 'color-scheme'), scheme === 'dark' ? 'dark' : 'light', `${scheme}: form controls follow the scheme`);
  }
  assert.ok(luminance(get('.msg', 'background')) < 0.2, 'dark: .msg background is dark');
});
