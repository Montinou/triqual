// The loopback review page of `triqual eval`: shows one sampled session at a time (the owner's messages, tool use,
// cost, context curve, stalls) and appends the owner's good/bad label to a labels file. It binds 127.0.0.1 only and
// refuses a request whose Host is not 127.0.0.1:<port> or localhost:<port> (DNS rebinding), a POST whose Origin is
// another site, and a POST without the per-run token header (CSRF). Transcript text is untrusted: every string that
// reaches the HTML goes through escapeHtml, and the page's CSP allows only its own nonce'd script.
// node: built-ins only. Consumes sample.jsonl rows { sessionId, project, file, stratum, usd, turns } by format.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prices.json'), 'utf8')).models;

const MAX_BODY = 16 * 1024;
const MAX_NOTE = 2000;
const MAX_SHOWN = 4000; // characters of one owner message the page shows
const LABELS = new Set(['good', 'bad']);

const n = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const priceOf = (model) => PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')] ?? null;

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const jsonLines = (file) => {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn or foreign line is skipped */ }
  }
  return rows;
};

// True when the file has content and its last byte is not a newline (a torn last line).
const endsMidLine = (file) => {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
  return text.length > 0 && !text.endsWith('\n');
};

// What the owner needs to judge one session, from its transcript.
export function sessionView(file) {
  const ownerMessages = [];
  const tools = new Map();
  const ctxCurve = [];
  const seen = new Set();
  const stalls = { stopHookBlocks: 0, toolErrors: 0 };
  let usd = 0;
  for (const rec of jsonLines(file)) {
    if (rec === null || typeof rec !== 'object') continue;
    if ((rec.type === 'stop_hook_summary' || rec.subtype === 'stop_hook_summary') && Array.isArray(rec.hookErrors) && rec.hookErrors.length > 0) {
      stalls.stopHookBlocks += 1;
    }
    const msg = rec.message;
    if (msg === null || typeof msg !== 'object') continue;
    const content = msg.content;
    if (rec.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === 'tool_result' && b.is_error === true) stalls.toolErrors += 1;
      }
      if (rec.isMeta === true) continue;
      if (typeof content === 'string') ownerMessages.push(content);
      else if (Array.isArray(content) && !content.some((b) => b?.type === 'tool_result')) {
        const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        if (text) ownerMessages.push(text);
      }
    } else if (rec.type === 'assistant' && msg.usage !== null && typeof msg.usage === 'object') {
      // One message is split into a record per content block: count every block's tools, the usage only once.
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') tools.set(b.name, (tools.get(b.name) ?? 0) + 1);
      }
      const id = `${msg.id ?? ''}\0${rec.requestId ?? ''}`;
      if (id !== '\0') { if (seen.has(id)) continue; seen.add(id); }
      const u = msg.usage;
      ctxCurve.push(n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens));
      const p = typeof msg.model === 'string' ? priceOf(msg.model) : null;
      if (p !== null) {
        const write = n(u.cache_creation_input_tokens);
        const write1h = Math.min(n(u.cache_creation?.ephemeral_1h_input_tokens), write);
        usd += (n(u.input_tokens) * p.input + n(u.output_tokens) * p.output + n(u.cache_read_input_tokens) * p.cacheRead
          + (write - write1h) * p.cacheWrite5m + write1h * p.cacheWrite1h) / 1e6;
      }
    }
  }
  return { firstPrompt: ownerMessages[0] ?? '', ownerMessages, toolCounts: Object.fromEntries(tools), usd, ctxCurve, stalls };
}

const CSS = `html{color-scheme:light}body{font:15px/1.5 system-ui,sans-serif;max-width:56rem;margin:1.5rem auto;padding:0 1rem;background:#fff;color:#1a1a1a}
h1{font-size:1.1rem}.meta{color:#666}.msg{background:#f3f3f5;border-radius:6px;padding:.6rem .8rem;margin:.5rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
button{font:inherit;padding:.4rem .9rem;margin-right:.4rem;cursor:pointer}textarea{width:100%;min-height:4rem;font:inherit;box-sizing:border-box}
svg{width:100%;height:60px}polyline{fill:none;stroke:currentColor;stroke-width:1.5}.status{min-height:1.5rem}
@media (prefers-color-scheme:dark){html{color-scheme:dark}body{background:#16161a;color:#e8e8ea}pre,.msg{background:#222228}.meta{color:#a0a0a8}}`;

const SCRIPT = `
const HEADER = 'x-triqual-token';
const body = document.body;
const status = document.getElementById('status');
const note = document.getElementById('note');
async function send(label) {
  status.textContent = 'saving...';
  try {
    const res = await fetch('/label', { method: 'POST', headers: { 'content-type': 'application/json', [HEADER]: body.dataset.auth },
      body: JSON.stringify({ sessionId: body.dataset.session, label, note: note.value }) });
    if (!res.ok) { status.textContent = 'refused (' + res.status + ')'; return; }
    location.href = '/';
  } catch (e) { status.textContent = 'failed: ' + e.message; }
}
document.getElementById('good').addEventListener('click', () => send('good'));
document.getElementById('bad').addEventListener('click', () => send('bad'));
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.activeElement === note) { if (e.key === 'Escape') note.blur(); return; }
  if (e.key === 'g') send('good'); else if (e.key === 'b') send('bad'); else if (e.key === 'n') { e.preventDefault(); note.focus(); }
});`;

const spark = (curve) => {
  if (curve.length < 2) return '';
  const max = Math.max(...curve) || 1;
  const pts = curve.map((v, i) => `${((i / (curve.length - 1)) * 300).toFixed(1)},${(58 - (v / max) * 56).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="context size per turn"><polyline points="${pts}"/></svg>`;
};

const shell = (nonce, inner, attrs = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session review</title><style nonce="${nonce}">${CSS}</style></head>
<body${attrs}>${inner}</body></html>`;

function sessionPage(row, view, error, token, nonce, index, total, labeled) {
  const msgs = view.ownerMessages.map((m) => `<div class="msg">${escapeHtml(m.length > MAX_SHOWN ? `${m.slice(0, MAX_SHOWN)}…` : m)}</div>`).join('');
  const tools = Object.entries(view.toolCounts).map(([k, v]) => `${escapeHtml(k)} ×${v}`).join(', ') || 'none';
  const inner = `<h1>Session ${escapeHtml(row.sessionId)} <span class="meta">(${index + 1} of ${total}${labeled ? ', already labeled' : ''})</span></h1>
<p class="meta">project ${escapeHtml(row.project ?? 'unknown')} · stratum ${escapeHtml(row.stratum ?? '')} · $${view.usd.toFixed(2)} · ${view.ctxCurve.length} turns · stop-hook blocks ${view.stalls.stopHookBlocks} · tool errors ${view.stalls.toolErrors}</p>
${error ? `<p class="meta">transcript unreadable: ${escapeHtml(error)}</p>` : ''}
<p class="meta">tools: ${tools}</p>${spark(view.ctxCurve)}
<h2>Owner messages</h2>${msgs || '<p class="meta">none</p>'}
<p><button id="good" type="button">Good (g)</button><button id="bad" type="button">Bad (b)</button> <span class="meta">note: n</span></p>
<textarea id="note" maxlength="${MAX_NOTE}" placeholder="note (optional)"></textarea><p id="status" class="status" role="status"></p>
<script nonce="${nonce}">${SCRIPT}</script>`;
  return shell(nonce, inner, ` data-session="${escapeHtml(row.sessionId)}" data-auth="${escapeHtml(token)}"`);
}

const donePage = (nonce, total) => shell(nonce, `<h1>All ${total} sessions are labeled.</h1>`);

const digest = (s) => createHash('sha256').update(String(s)).digest();

export async function startServer({ sampleFile, labelsFile, port = 0, token }) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('startServer needs a token');
  const tokenDigest = digest(token);
  const rows = jsonLines(sampleFile).filter((r) => r !== null && typeof r === 'object' && typeof r.sessionId === 'string');
  const byId = new Map(rows.map((r) => [r.sessionId, r]));
  const labeledIds = () => new Set(jsonLines(labelsFile).filter((l) => typeof l?.sessionId === 'string').map((l) => l.sessionId));
  let allowedHosts = new Set();
  let allowedOrigins = new Set();

  const send = (res, status, type, text, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(text);
  };
  const sendJson = (res, status, obj, extra) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra);
  const sendPage = (res, status, build) => {
    const nonce = randomBytes(16).toString('base64');
    send(res, status, 'text/html; charset=utf-8', build(nonce), {
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
  };

  const showSession = (res, row) => {
    let view = { firstPrompt: '', ownerMessages: [], toolCounts: {}, usd: 0, ctxCurve: [], stalls: { stopHookBlocks: 0, toolErrors: 0 } };
    let error = '';
    try { view = sessionView(row.file); } catch (e) { error = e?.code ?? 'error'; }
    const done = labeledIds();
    sendPage(res, 200, (nonce) => sessionPage(row, view, error, token, nonce, rows.findIndex((r) => r.sessionId === row.sessionId), rows.length, done.has(row.sessionId)));
  };

  const readBody = (req, res, then) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      sendJson(res, 413, { error: 'body too large' }, { connection: 'close' });
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; sendJson(res, 413, { error: 'body too large' }, { connection: 'close' }); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) then(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { /* the client went away */ });
  };

  const postLabel = (req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) { sendJson(res, 403, { error: 'foreign origin' }); return; }
    const given = req.headers['x-triqual-token'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), tokenDigest)) { sendJson(res, 403, { error: 'bad token' }); return; }
    readBody(req, res, (text) => {
      let b;
      try { b = JSON.parse(text); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      if (b === null || typeof b !== 'object' || Array.isArray(b)) { sendJson(res, 400, { error: 'invalid body' }); return; }
      if (!LABELS.has(b.label)) { sendJson(res, 400, { error: 'label must be good or bad' }); return; }
      const note = b.note ?? '';
      if (typeof note !== 'string' || note.length > MAX_NOTE) { sendJson(res, 400, { error: `note must be a string of at most ${MAX_NOTE} characters` }); return; }
      if (typeof b.sessionId !== 'string' || !byId.has(b.sessionId)) { sendJson(res, 404, { error: 'unknown session' }); return; }
      // Read, check and append run in one synchronous step, so two requests cannot both append the same id.
      if (labeledIds().has(b.sessionId)) { sendJson(res, 200, { already: true }); return; }
      mkdirSync(dirname(labelsFile), { recursive: true, mode: 0o700 });
      // A torn last line (no final newline) would swallow this label: start a fresh line first.
      const lead = endsMidLine(labelsFile) ? '\n' : '';
      appendFileSync(labelsFile, `${lead}${JSON.stringify({ sessionId: b.sessionId, label: b.label, note, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      sendJson(res, 200, { ok: true });
    });
  };

  const server = createServer((req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host)) { sendJson(res, 403, { error: 'foreign host' }); return; }
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'POST' && path === '/label') { postLabel(req, res); return; }
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' }); return; }
      if (path === '/') {
        const done = labeledIds();
        const next = rows.find((r) => !done.has(r.sessionId));
        if (next) showSession(res, next); else sendPage(res, 200, (nonce) => donePage(nonce, rows.length));
        return;
      }
      const m = /^\/session\/([^/]+)$/.exec(path);
      let id = null;
      try { id = m ? decodeURIComponent(m[1]) : null; } catch { /* malformed escape: no such session */ }
      if (id !== null && byId.has(id)) { showSession(res, byId.get(id)); return; }
      sendJson(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, resolve);
  });
  const actual = server.address().port;
  allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${actual}`, `http://localhost:${actual}`]);

  return {
    url: `http://127.0.0.1:${actual}/`,
    address: () => server.address(),
    close: () => new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
