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
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listResolved } from '../lib/registry.mjs';
import { buildSnapshot } from '../lib/snapshot.mjs';
import { loadSqlite } from '../lib/store.mjs';

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

// The snapshot of every registered repo that still resolves, each repo resolved once per poll. A repo whose snapshot
// throws is skipped, so one bad repo never fails the whole response. node:sqlite is loaded (once) only when a store
// repo is reached; a repo of any other mode never loads it, and a store repo whose database cannot be read is skipped.
async function snapshots(home) {
  const now = new Date();
  const out = [];
  for (const { tracking, shareable } of listResolved(home)) {
    try {
      if (tracking.mode === 'store') await loadSqlite();
      out.push(buildSnapshot(tracking, { now, shareable, home }));
    } catch {
      // skipped: unreadable tracking files, a vanished repo
    }
  }
  return out;
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

// Fixed bodies only: nothing from the request (path, Host, method) is ever written back. Returns a promise for the one
// route that reads the store (the others answer at once).
async function handle(req, res, { home, port, assets }) {
  const host = req.headers.host;
  if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return send(res, 403, TEXT, 'forbidden\n');
  if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, TEXT, 'forbidden\n');
  if (req.method !== 'GET') return send(res, 405, TEXT, 'method not allowed\n', { Allow: 'GET' });
  const path = (req.url ?? '').split('?')[0];
  if (Object.hasOwn(assets, path)) return send(res, 200, assets[path].type, assets[path].body);
  if (path === '/api/snapshots') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await snapshots(home)));
  return send(res, 404, TEXT, 'not found\n');
}

// Starts the dashboard on 127.0.0.1 (the only host it accepts) and resolves once it listens; port 0 picks a free one.
export function startServer({ home, port = 0, host = LOOPBACK }) {
  if (host !== LOOPBACK) return Promise.reject(new Error(`triqual ui binds ${LOOPBACK} only, not ${host}`));
  const assets = {};
  for (const [path, { file, type, base64 }] of Object.entries(ASSETS)) {
    const text = readFileSync(join(UI_DIR, file), 'utf8');
    assets[path] = { type, body: base64 ? Buffer.from(text, 'base64') : text };
  }
  return new Promise((resolve, reject) => {
    // requireHostHeader off: a request without Host reaches the handler, which answers 403 (not Node's bare 400).
    const server = createServer({ requireHostHeader: false }, (req, res) => {
      const fail = () => {
        if (!res.headersSent) send(res, 500, TEXT, 'internal error\n');
        else res.destroy();
      };
      handle(req, res, { home, port: server.address().port, assets }).catch(fail);
    });
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
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
