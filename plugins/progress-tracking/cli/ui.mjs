#!/usr/bin/env node
// `triqual ui [--port N] [--open]`: the local, read-only tracking dashboard (spec Addendum D.4). A node:http server bound
// to 127.0.0.1 serves one page (`GET /`), its scripts (`GET /app.js`, `GET /view.js`), its stylesheet (`GET /app.css`),
// three bundled fonts (`GET /fonts/geist.woff2`, `/fonts/geist-mono.woff2`, `/fonts/bricolage.woff2`) and the snapshots
// of every registered repo (`GET /api/snapshots`). Assets come from a fixed allowlist (ASSETS), each read once at start;
// no request path ever reaches the filesystem. Any other method is 405 and any other path 404. A Host header other than
// `127.0.0.1:<port>` or `localhost:<port>` (a missing one included) is 403, which guards against DNS rebinding. Every
// response carries `Content-Security-Policy: default-src 'self'` and `Cache-Control: no-store`, and none echoes
// request data. Exit codes: 0 for --help/-h (usage only, no server), 2 bad arguments, 1 the server cannot listen;
// otherwise it runs until Ctrl-C.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listResolved } from '../lib/registry.mjs';
import { branchOf, buildSnapshot } from '../lib/snapshot.mjs';
import { loadSqlite, storePaths } from '../lib/store.mjs';

export const DEFAULT_PORT = 47800;
const LOOPBACK = '127.0.0.1';
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const USAGE = 'usage: triqual ui [--port N] [--open]';
const HELP = `${USAGE}
  --port N    listen on port N (0-65535; default 47800)
  --open      also open the URL in the default browser
  -h, --help  print this help`;
const COMMON_HEADERS = {
  'Content-Security-Policy': "default-src 'self'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const TEXT = 'text/plain; charset=utf-8';
// The only files the server serves, by request path. `base64` entries are stored as base64 text (so the fonts survive
// the repo's content gate) and decoded once at start.
const ASSETS = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/theme.js': { file: 'theme.js', type: 'text/javascript; charset=utf-8' },
  '/view.js': { file: 'view.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/fonts/geist.woff2': { file: 'fonts/geist.woff2.b64', type: 'font/woff2', base64: true },
  '/fonts/geist-mono.woff2': { file: 'fonts/geist-mono.woff2.b64', type: 'font/woff2', base64: true },
  '/fonts/bricolage.woff2': { file: 'fonts/bricolage.woff2.b64', type: 'font/woff2', base64: true },
};

// A hub owns the cached repo/branch resolution and one lazy watch for every connected viewer.
export function createHub({ home, heartbeatMs = 60000, throttleMs = 1000, watchDir, build = buildSnapshot }) {
  const dataDir = watchDir === undefined ? storePaths({ home, env: process.env })?.dataDir : watchDir;
  const subscribers = new Set();
  let repos, watcher, heartbeat, timer, baseline, latest;
  let building = false, dirty = false, closed = false, lastPush = -Infinity;
  const refresh = () => { repos = listResolved(home).map(repo => ({ ...repo, branch: branchOf(repo.tracking.repoRoot) })); };
  refresh();
  const fingerprint = () => JSON.stringify(['tracking.db', 'tracking.db-wal', 'sessions.db', 'sessions.db-wal'].map(name => {
    try {
      const { mtimeMs, size } = statSync(join(dataDir, name));
      return name.endsWith('-wal') && size === 0 ? null : [mtimeMs, size];
    } catch { return null; }
  }));
  const snapshots = async () => {
    const now = new Date();
    const out = [];
    let sessions = [], db;
    let notes = new Map();
    try {
      if (dataDir && existsSync(join(dataDir, 'sessions.db'))) {
        const { readSessions } = await import('../lib/sessions.mjs');
        await loadSqlite();
        const { DatabaseSync } = await import('node:sqlite');
        db = new DatabaseSync(join(dataDir, 'sessions.db'), { readOnly: true });
        sessions = readSessions(db, { since: now.getTime() - 2 * 60 * 60 * 1000, now: now.getTime() });
      }
    } catch { /* optional activity never prevents tracking snapshots */ }
    finally { db?.close(); }
    if (sessions.length) {
      const { readNotes } = await import('../lib/claude-mem-notes.mjs');
      notes = readNotes([...new Set(sessions.map(row => row.sessionId))], { home });
    }
    for (const { tracking, shareable, branch } of repos) {
      try {
        if (tracking.mode === 'store') await loadSqlite();
        out.push({ ...await build(tracking, { now, shareable, home, branch }),
          sessions: sessions.filter(row => row.repoRoot === tracking.repoRoot).map(row => ({
            ...row, notes: notes.get(`${row.sessionId}\u0000${row.agentId}`) || [],
          })),
        });
      } catch { /* one unreadable repo never fails the whole list */ }
    }
    return out;
  };
  const schedule = () => {
    if (!subscribers.size || closed || building || timer) return;
    const wait = Math.max(0, lastPush + throttleMs - Date.now());
    timer = setTimeout(() => { timer = null; push(); }, wait);
  };
  const push = async () => {
    if (!subscribers.size || closed || building) return;
    building = true; dirty = false;
    // Save before reads: a concurrent write must remain dirty for the trailing push.
    baseline = fingerprint();
    try {
      latest = await snapshots();
      lastPush = Date.now();
      for (const send of subscribers) send(latest);
    } finally { building = false; if (dirty) schedule(); }
  };
  const watchStore = () => {
    if (watcher || !dataDir || !subscribers.size) return;
    try {
      watcher = watch(dataDir, (_event, file) => {
        if (!subscribers.size || !/^(tracking|sessions)\.db/.test(String(file))) return;
        if (fingerprint() !== baseline) { dirty = true; schedule(); }
      });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch { /* missing directory: retry on the next heartbeat */ }
  };
  const stop = () => {
    clearInterval(heartbeat); clearTimeout(timer); heartbeat = timer = null;
    watcher?.close(); watcher = null; latest = undefined;
  };
  return {
    snapshots,
    subscribe(send) {
      if (closed) return () => {};
      const first = subscribers.size === 0;
      subscribers.add(send);
      if (first) {
        watchStore();
        heartbeat = setInterval(() => { refresh(); watchStore(); dirty = true; schedule(); }, heartbeatMs);
        // A new connection gets an immediate snapshot, independently of a previous connection's throttle.
        lastPush = -Infinity; push();
      } else if (latest !== undefined) send(latest);
      return () => { subscribers.delete(send); if (!subscribers.size) stop(); };
    },
    close() { closed = true; subscribers.clear(); stop(); },
  };
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

// Fixed bodies only: nothing from the request (path, Host, method) is ever written back. Returns a promise for the one
// route that reads the store (the others answer at once).
async function handle(req, res, { port, assets, hub, streams }) {
  const host = req.headers.host;
  if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return send(res, 403, TEXT, 'forbidden\n');
  if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, TEXT, 'forbidden\n');
  if (req.method !== 'GET') return send(res, 405, TEXT, 'method not allowed\n', { Allow: 'GET' });
  const path = (req.url ?? '').split('?')[0];
  if (Object.hasOwn(assets, path)) return send(res, 200, assets[path].type, assets[path].body);
  if (path === '/api/snapshots') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await hub.snapshots()));
  if (path === '/api/events') {
    res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    streams.add(res);
    const unsubscribe = hub.subscribe(data => res.write(`data: ${JSON.stringify(data)}\n\n`));
    res.on('close', () => { unsubscribe(); streams.delete(res); });
    return;
  }
  return send(res, 404, TEXT, 'not found\n');
}

// Starts the dashboard on 127.0.0.1 (the only host it accepts) and resolves once it listens; port 0 picks a free one.
export function startServer({ home, port = 0, host = LOOPBACK, heartbeatMs, throttleMs, watchDir, build }) {
  if (host !== LOOPBACK) return Promise.reject(new Error(`triqual ui binds ${LOOPBACK} only, not ${host}`));
  const assets = {};
  for (const [path, { file, type, base64 }] of Object.entries(ASSETS)) {
    const text = readFileSync(join(UI_DIR, file), 'utf8');
    assets[path] = { type, body: base64 ? Buffer.from(text, 'base64') : text };
  }
  const hub = createHub({ home, heartbeatMs, throttleMs, watchDir, build });
  const streams = new Set();
  return new Promise((resolve, reject) => {
    // requireHostHeader off: a request without Host reaches the handler, which answers 403 (not Node's bare 400).
    const server = createServer({ requireHostHeader: false }, (req, res) => {
      const fail = () => {
        if (!res.headersSent) send(res, 500, TEXT, 'internal error\n');
        else res.destroy();
      };
      handle(req, res, { port: server.address().port, assets, hub, streams }).catch(fail);
    });
    const close = server.close.bind(server);
    server.close = (...args) => { hub.close(); for (const stream of streams) stream.end(); return close(...args); };
    server.once('error', err => { hub.close(); reject(err); });
    server.listen(port, LOOPBACK, () => {

      resolve({ server, url: `http://${LOOPBACK}:${server.address().port}/` });
    });
  });
}

// Opens `url` in the default browser: `open` on macOS, `xdg-open` elsewhere, with an argument array (never a shell).
// Any failure, a missing command included, is ignored.
function openBrowser(url) {
  try {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignored: opening the browser is a convenience
  }
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv, options: { port: { type: 'string' }, open: { type: 'boolean' } }, allowPositionals: true, strict: true,
  });
  if (positionals.length) throw new Error(`unexpected argument ${positionals[0]}`);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!/^\d+$/.test(values.port ?? '0') || !Number.isInteger(port) || port > 65535) throw new Error('--port must be 0-65535');
  return { port, open: values.open === true };
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  let started;
  try {
    try {
      started = await startServer({ home: homedir(), port: opts.port });
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || argv.includes('--port') || argv.some((arg) => arg.startsWith('--port='))) throw err;
      started = await startServer({ home: homedir(), port: 0 });
    }
  } catch (err) {
    process.stderr.write(`triqual ui: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`triqual ui: ${started.url}\n`);
  if (opts.open) openBrowser(started.url);
  const stop = () => {
    started.server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2));
}
