import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startServer } from '../cli/ui.mjs';
import { BRAND } from '../lib/brand.mjs';
import { registerRepo } from '../lib/registry.mjs';
import { createLedger } from '../lib/ledger.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(PLUGIN, 'cli', 'ui.mjs');
const INDEX = join(PLUGIN, 'ui', 'index.html');
const APP = join(PLUGIN, 'ui', 'app.js');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const NOW = new Date('2026-09-27T12:00:00.000Z');
const CSP = "default-src 'self'";
const PROGRESS = '# Progress\n\n## 2026-09-27 — Fixture task\n- **Stage/task:** Plan sp2-tracking · T1\n- **Done:** it\n';
const STATUS = '# Status\n\n**Last updated:** 2026-09-27\n';
const TASKS = [
  { id: 'T1', title: 'Alpha', deps: [], skills: [] },
  { id: 'T2', title: 'Beta', deps: [], skills: [] },
];

// Every child runs with a temp HOME, no XDG_CONFIG_HOME and no inherited repo-selecting variables.
const cleanEnv = (home) => {
  const env = { ...process.env, HOME: home };
  for (const k of ['XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return env;
};

// A committed-mode repo (one commit on `main`) with progress.md, status.md and one active ledger (T1 done, T2 blocked),
// registered in the temp HOME's registry.
function makeRepo(dir, home, name) {
  const repo = join(dir, name);
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  const env = cleanEnv(home);
  const git = (...args) => execFileSync('git', [...ID, ...args], { cwd: repo, env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git('commit', '-qm', 'initial');
  writeFileSync(join(repo, 'progress.md'), PROGRESS);
  writeFileSync(join(repo, 'status.md'), STATUS);
  const ledger = createLedger({ plan: 'docs/plans/2026-09-27-p.md', spec: null, branch: 'main', tasks: TASKS, now: 'x' });
  Object.assign(ledger.tasks[0], { status: 'done', commits: ['abc1234'] });
  Object.assign(ledger.tasks[1], { status: 'blocked', reason: 'waiting on review' });
  writeFileSync(join(repo, 'docs', 'plans', '2026-09-27-p.tasks.json'), JSON.stringify(ledger));
  registerRepo(home, { root: repo, mode: 'committed', now: NOW });
  return repo;
}

// A temp dir with `home/` holding a registry with one fixture repo; removed afterwards.
async function withFixture(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    const repo = makeRepo(dir, home, 'alpha');
    await fn({ dir, home, repo });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// startServer on port 0 for the duration of fn.
async function withServer(home, fn) {
  const { server, url } = await startServer({ home });
  try {
    await fn({ url, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
}

// One HTTP request with full control over the Host header (`host: null` sends none).
function get(port, path, { method = 'GET', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const headers = host === null ? {} : { Host: host };
    const req = request({ host: '127.0.0.1', port, path, method, headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Like get, but the body stays a Buffer (no setEncoding), for binary assets.
function getBinary(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: `127.0.0.1:${port}` }, setHost: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const assertCommonHeaders = (r) => {
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
};

test('GET /api/snapshots returns the registered repos\' snapshots', () => withFixture(async ({ home, repo }) => {
  await withServer(home, async ({ port }) => {
    const r = await get(port, '/api/snapshots');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assertCommonHeaders(r);
    const snaps = JSON.parse(r.body);
    assert.equal(snaps.length, 1);
    const [s] = snaps;
    assert.equal(s.schema, `${BRAND.legacy.marketplace}/tracking-snapshot@1`);
    assert.deepEqual(s.repo, { name: 'alpha', root: repo, mode: 'committed', branch: 'main', shareable: false });
    assert.deepEqual(s.plans.map((p) => [p.name, p.done, p.total]), [['2026-09-27-p', 1, 2]]);
    assert.deepEqual(s.plans[0].tasks[1], { id: 'T2', title: 'Beta', status: 'blocked', reason: 'waiting on review', tier: null, effectiveTier: null, commits: [], skills: [] });
    assert.equal(s.status.text, STATUS);
    assert.deepEqual(s.progress.entries.map((e) => e.title), ['Fixture task']);
    // A query string does not change the route.
    assert.equal((await get(port, '/api/snapshots?x=1')).status, 200);
  });
}));

test('/api/snapshots skips a repo whose snapshot throws and still answers 200', () => withFixture(async ({ dir, home, repo }) => {
  const bad = makeRepo(dir, home, 'broken');
  rmSync(join(bad, 'status.md'));
  mkdirSync(join(bad, 'status.md')); // reading status.md throws EISDIR inside buildSnapshot
  await withServer(home, async ({ port }) => {
    const r = await get(port, '/api/snapshots');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body).map((s) => s.repo.root), [repo]);
  });
}));

test('/api/snapshots is an empty array with no registry', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-empty-')));
  try {
    await withServer(home, async ({ port }) => {
      const r = await get(port, '/api/snapshots');
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), []);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('GET / serves the page with the CSP header', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port, url }) => {
    assert.equal(url, `http://127.0.0.1:${port}/`);
    const r = await get(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html; charset=utf-8/);
    assertCommonHeaders(r);
    assert.equal(r.body, readFileSync(INDEX, 'utf8'));
    assert.match(r.body, /<script src="\/app\.js"/);
    // localhost:<port> is the other accepted Host.
    assert.equal((await get(port, '/', { host: `localhost:${port}` })).status, 200);
  });
}));

test('GET /app.js is served', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    const r = await get(port, '/app.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript; charset=utf-8/);
    assertCommonHeaders(r);
    assert.equal(r.body, readFileSync(APP, 'utf8'));
  });
}));

test('each allowlisted asset is served with its type', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    for (const [path, type, file] of [['/view.js', 'text/javascript; charset=utf-8', 'view.js'], ['/app.css', 'text/css; charset=utf-8', 'app.css']]) {
      const r = await get(port, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['content-type'], type, path);
      assertCommonHeaders(r);
      assert.equal(r.body, readFileSync(join(PLUGIN, 'ui', file), 'utf8'), path);
    }
  });
}));

test('fonts are served as decoded woff2', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    let total = 0;
    for (const [path, file] of [['/fonts/geist.woff2', 'geist'], ['/fonts/geist-mono.woff2', 'geist-mono'], ['/fonts/bricolage.woff2', 'bricolage']]) {
      const r = await getBinary(port, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['content-type'], 'font/woff2', path);
      assertCommonHeaders(r);
      assert.equal(r.body.subarray(0, 4).toString('latin1'), 'wOF2', path);
      assert.ok(r.body.equals(Buffer.from(readFileSync(join(PLUGIN, 'ui', 'fonts', `${file}.woff2.b64`), 'utf8'), 'base64')), path);
      total += r.body.length;
    }
    assert.ok(total < 400 * 1024, `fonts total ${total} bytes`);
  });
}));

test('paths outside the allowlist are 404', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    for (const path of ['/fonts/other.woff2', '/fonts/geist.woff2.b64', '/fonts/../app.js', '/ui/app.js', '/app.js/', '/OFL.txt', '/fonts/OFL.txt']) {
      const r = await get(port, path);
      assert.equal(r.status, 404, path);
      assert.equal(r.body, 'not found\n', path);
      assertCommonHeaders(r);
    }
  });
}));

test('OFL.txt names both fonts', () => {
  const ofl = readFileSync(join(PLUGIN, 'ui', 'fonts', 'OFL.txt'), 'utf8');
  assert.match(ofl, /Geist/);
  assert.match(ofl, /Bricolage Grotesque/);
  assert.match(ofl, /SIL Open Font License/i);
});

test('POST is 405, unknown path is 404', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const r = await get(port, '/api/snapshots', { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET');
      assertCommonHeaders(r);
    }
    for (const path of ['/nope', '/index.html', '/api', '/app.js/', '/../app.js', '/ui/app.js']) {
      const r = await get(port, path);
      assert.equal(r.status, 404, path);
      assertCommonHeaders(r);
    }
  });
}));

test('a foreign Host header is 403', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    const hosts = ['evil.example', `evil.example:${port}`, '127.0.0.1', 'localhost', `127.0.0.1:${port + 1}`,
      `127.0.0.1:${port}.evil.example`, `0.0.0.0:${port}`, null];
    for (const host of hosts) {
      for (const path of ['/', '/app.js', '/api/snapshots', '/nope']) {
        const r = await get(port, path, { host });
        assert.equal(r.status, 403, `${host} ${path}`);
        assertCommonHeaders(r);
        assert.doesNotMatch(r.body, /alpha|tracking-snapshot|<html/i, 'no data behind a foreign Host');
      }
    }
    // Checked before the method: a foreign POST is 403, not 405.
    assert.equal((await get(port, '/', { method: 'POST', host: 'evil.example' })).status, 403);
  });
}));

test('responses never echo request data', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    const marker = 'zq-marker-7731';
    const cases = [
      await get(port, `/${marker}`),
      await get(port, `/${marker}`, { method: 'POST' }),
      await get(port, `/${marker}`, { host: `${marker}.example` }),
    ];
    for (const r of cases) {
      assert.ok(!r.body.includes(marker), r.body);
      assert.ok(!JSON.stringify(r.headers).includes(marker));
    }
  });
}));

test('startServer binds 127.0.0.1 only', () => withFixture(async ({ home }) => {
  const { server } = await startServer({ home });
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(startServer({ home, host: '0.0.0.0' }), /127\.0\.0\.1/);
}));

test('app.js never assigns innerHTML', () => {
  const app = readFileSync(APP, 'utf8');
  assert.doesNotMatch(app, /innerHTML\s*=/);
  assert.doesNotMatch(app, /outerHTML|insertAdjacentHTML|document\.write/);
});

test('index.html and app.js load no external resources and nothing CSP would block', () => {
  const index = readFileSync(INDEX, 'utf8');
  const app = readFileSync(APP, 'utf8');
  for (const [name, text] of [['index.html', index], ['app.js', app]]) {
    assert.doesNotMatch(text, /https?:\/\//, `${name} has no http(s) URL`);
  }
  // default-src 'self' blocks inline scripts, inline styles and style attributes.
  assert.doesNotMatch(index, /<style|\sstyle=|\son[a-z]+=/i);
  assert.deepEqual([...index.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script src="/app.js" defer>']);
  assert.match(app, /\/api\/snapshots/);
  assert.match(app, /5000/);
  assert.match(app, /prefers-color-scheme/);
});

// Starts the CLI and resolves with its printed URL once it is listening.
function startCli(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
      const m = /^triqual ui: (http:\/\/127\.0\.0\.1:(\d+)\/)\n/m.exec(stdout);
      if (m) resolve({ url: m[1], port: Number(m[2]) });
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${stdout}${stderr}`)));
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', resolve);
    child.kill('SIGINT');
  });
  return { child, ready, stop, output: () => ({ stdout, stderr }) };
}

test('triqual ui prints its URL; --open passes the URL as one argument to the opener', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-cli-')));
  const bin = join(dir, 'bin');
  const record = join(dir, 'opened.txt');
  mkdirSync(bin);
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s|' "$@" > '${record}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const cli = startCli(['--port', '0', '--open'], { ...cleanEnv(dir), PATH: bin });
  try {
    const { url, port } = await cli.ready;
    assert.equal((await get(port, '/app.js')).status, 200);
    for (let i = 0; i < 100 && !readIfExists(record); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(readFileSync(record, 'utf8'), `${url}|`);
  } finally {
    await cli.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--open with no opener installed keeps the server running', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-cli-')));
  mkdirSync(join(dir, 'empty'));
  const cli = startCli(['--open'], { ...cleanEnv(dir), PATH: join(dir, 'empty') });
  try {
    const { port } = await cli.ready;
    await new Promise((r) => setTimeout(r, 200)); // the spawn error arrives asynchronously
    assert.equal((await get(port, '/')).status, 200);
    assert.equal(cli.child.exitCode, null);
  } finally {
    await cli.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('triqual ui rejects a bad --port with exit 2', () => {
  for (const args of [['--port', 'abc'], ['--port', '70000'], ['--port', '-1'], ['--bogus'], ['extra']]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-bad-')));
    try {
      const r = execFileSyncStatus(args, cleanEnv(home));
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /usage: triqual ui \[--port N\] \[--open\]/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function execFileSyncStatus(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

// ---- final fix wave ----

test('each /api/snapshots poll resolves each registered repo once', () => withFixture(async ({ dir, home }) => {
  const bin = join(dir, 'fake-git');
  mkdirSync(bin);
  const log = join(dir, 'git.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await withServer(home, async ({ port }) => {
      writeFileSync(log, '');
      assert.equal((await get(port, '/api/snapshots')).status, 200);
      const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('--show-toplevel'));
      assert.equal(calls.length, 1, calls.join('\n'));
    });
  } finally {
    process.env.PATH = path;
  }
}));

// Runs app.js in a VM with a minimal DOM: `hidden` drives document.hidden; returns the fetch count and the hooks.
function loadApp({ hidden }) {
  const listeners = {};
  const timers = [];
  let fetches = 0;
  const node = () => ({
    append() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {}, className: '', textContent: '',
  });
  const document = {
    hidden,
    adoptedStyleSheets: [],
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    getElementById: () => node(),
    createElement: () => node(),
    createTextNode: () => node(),
  };
  const context = vm.createContext({
    document,
    CSSStyleSheet: class { replaceSync() {} },
    fetch: async () => { fetches++; return { ok: true, json: async () => [] }; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    Date,
  });
  vm.runInContext(readFileSync(APP, 'utf8'), context);
  return {
    document,
    fetches: () => fetches,
    fire: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
    tick: () => timers.splice(0).forEach((fn) => fn()),
  };
}

test('app.js polls only while the tab is visible and refreshes when it becomes visible again', async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const app = loadApp({ hidden: true });
  await flush();
  app.tick();
  await flush();
  assert.equal(app.fetches(), 0, 'no fetch while hidden');
  app.document.hidden = false;
  app.fire('visibilitychange');
  await flush();
  assert.equal(app.fetches(), 1, 'refreshes once visible');
  app.tick();
  await flush();
  assert.equal(app.fetches(), 2, 'keeps polling while visible');
  app.document.hidden = true;
  app.tick();
  await flush();
  assert.equal(app.fetches(), 2, 'stops polling once hidden');
});

test('triqual ui --help and -h print the usage and its flag lines, exit 0 and start no server', () => {
  for (const args of [['--help'], ['-h'], ['--port', '0', '--help']]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-help-')));
    try {
      // execFileSyncStatus waits for the exit: a started server would run until its 10 s timeout and fail this.
      const r = execFileSyncStatus(args, cleanEnv(home));
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      const lines = r.stdout.trimEnd().split('\n');
      assert.equal(lines[0], 'usage: triqual ui [--port N] [--open]', args.join(' '));
      assert.match(r.stdout, /^ +--port N +\S/m);
      assert.match(r.stdout, /^ +--open +\S/m);
      assert.doesNotMatch(r.stdout, /triqual ui:/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

// Runs app.js against a recording DOM and returns the tree it rendered for `snaps`.
async function renderTree(snaps) {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const make = (tag) => ({
    tag, className: '', textContent: '', children: [],
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    setAttribute() {}, addEventListener() {},
  });
  const root = make('main');
  const document = {
    hidden: false,
    adoptedStyleSheets: [],
    addEventListener() {},
    getElementById: (id) => (id === 'repos' ? root : make('span')),
    createElement: make,
    createTextNode: (text) => ({ ...make('#text'), textContent: text }),
  };
  const context = vm.createContext({
    document,
    CSSStyleSheet: class { replaceSync() {} },
    fetch: async () => ({ ok: true, json: async () => snaps }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    Date,
  });
  vm.runInContext(readFileSync(APP, 'utf8'), context);
  await flush();
  return root;
}

const flatten = (node) => [node, ...(node.children ?? []).flatMap(flatten)];

test('the status panel is titled "status" and a store-mode repo gets the store badge', async () => {
  const snap = (mode) => ({
    schema: `${BRAND.marketplace}/tracking-snapshot@1`,
    repo: { name: 'alpha', root: '/r/alpha', mode, branch: 'main', shareable: false },
    plans: [], status: { text: 'S' }, progress: { entries: [] },
  });
  const store = flatten(await renderTree([snap('store')]));
  const badges = store.filter((n) => /\bbadge\b/.test(n.className));
  assert.ok(badges.some((b) => b.textContent === 'store' && /\bstore\b/.test(b.className)), 'a badge with the store class says store');
  const summaries = store.filter((n) => n.tag === 'summary').map((n) => n.textContent);
  assert.ok(summaries.includes('status'), `the status summary reads "status": ${summaries.join(' | ')}`);
  assert.ok(!summaries.includes('status.md'));
  // The other modes keep their badge classes.
  const local = flatten(await renderTree([snap('local')])).filter((n) => /\bbadge\b/.test(n.className));
  assert.ok(local.some((b) => b.textContent === 'local' && /\blocal\b/.test(b.className) && !/\bstore\b/.test(b.className)));
  const committed = flatten(await renderTree([snap('committed')])).filter((n) => /\bbadge\b/.test(n.className));
  assert.ok(committed.some((b) => b.textContent === 'committed' && !/\b(local|store)\b/.test(b.className)));
  assert.match(readFileSync(APP, 'utf8'), /\.badge\.store\s*\{/, 'the stylesheet styles .badge.store');
});
