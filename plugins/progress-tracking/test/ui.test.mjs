import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from '../cli/ui.mjs';
import * as uiServer from '../cli/ui.mjs';
import { BRAND } from '../lib/brand.mjs';
import { registerRepo } from '../lib/registry.mjs';
import { createLedger } from '../lib/ledger.mjs';
import { openSessions, record } from '../lib/sessions.mjs';
import { storePaths } from '../lib/store.mjs';
const { DatabaseSync } = await import('node:sqlite');

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
function get(port, path, { method = 'GET', host = `127.0.0.1:${port}`, fetchSite } = {}) {
  return new Promise((resolve, reject) => {
    const headers = host === null ? {} : { Host: host };
    if (fetchSite !== undefined) headers['Sec-Fetch-Site'] = fetchSite;
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
    assert.deepEqual(s.plans[0].tasks[1], { id: 'T2', title: 'Beta', status: 'blocked', since: null, reason: 'waiting on review', tier: null, effectiveTier: null, commits: [], skills: [] });
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
    assert.match(r.body, /<script type="module" src="\/app\.js">/);
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

test('app.js and view.js never build markup from data', () => {
  for (const file of ['app.js', 'view.js']) {
    const text = readFileSync(join(PLUGIN, 'ui', file), 'utf8');
    assert.doesNotMatch(text, /innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write/, file);
    // Only the SVG namespace string is a URL.
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org\/2000\/svg\b)/, `${file} has no http(s) URL`);
  }
});

test('index.html loads no external resources and nothing CSP would block', () => {
  const index = readFileSync(INDEX, 'utf8');
  const app = readFileSync(APP, 'utf8');
  assert.doesNotMatch(index, /https?:\/\//, 'index.html has no http(s) URL');
  // default-src 'self' blocks inline scripts, inline styles and style attributes.
  assert.doesNotMatch(index, /<style|\sstyle=|\son[a-z]+=/i);
  assert.deepEqual([...index.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script src="/theme.js">', '<script type="module" src="/app.js">']);
  assert.match(index, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(app, /\/api\/events/);
  assert.match(app, /new EventSource/);
});

test('app.css is CSP-safe and covers the page', () => {
  const css = readFileSync(join(PLUGIN, 'ui', 'app.css'), 'utf8');
  assert.doesNotMatch(css, /https?:\/\//, 'no http(s) URL');
  assert.doesNotMatch(css, /@import/);
  const urls = [...css.matchAll(/url\(\s*([^)]*?)\s*\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
  assert.deepEqual([...new Set(urls)].sort(), ['/fonts/bricolage.woff2', '/fonts/geist-mono.woff2', '/fonts/geist.woff2']);
  // No url() other than the three fonts, and the radial-gradient dot grid needs none.
  assert.equal(urls.length, 3, 'one url() per @font-face');
  assert.equal(css.match(/@font-face/g)?.length, 3);
  assert.match(css, /font-display:\s*swap/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.equal([...css].filter((c) => c === '{').length, [...css].filter((c) => c === '}').length, 'balanced braces');
  // Every class app.js emits is styled (statuses: s-<status> for each of the six).
  const classes = [
    'top', 'brand', 'tag', 'repo-pill', 'live', 'live-dot', 'tabs', 'ptab', 'hero', 'hero-date', 'hero-title', 'headline',
    'current', 'count', 'rail', 'cell', 'bar', 'pulse', 'cell-id', 'legend', 'panel', 'plan', 'tasks', 'chips', 'chip', 'trow',
    't-glyph', 't-id', 't-title', 't-status', 't-tier', 't-reason', 'highlight', 'entries', 'entry', 'entry-h', 'entry-body',
    'status-panel', 'card', 'card-tag', 'code', 'banner', 'banner-tag', 'banner-title', 'banner-text', 'hero-reason', 'empty',
    'intro', 'logo',
  ];
  for (const name of classes) assert.ok(css.includes(`.${name}`), `.${name} is styled`);
  for (const status of ['in_progress', 'in_review', 'blocked', 'pending', 'done', 'dropped']) {
    assert.ok(css.includes(`.s-${status}`), `.s-${status} is styled`);
  }
  // The stagger and the phone adaptation of the spec.
  assert.match(css, /animation-delay:\s*calc\(var\(--i\) \* 40ms\)/);
  assert.match(css, /flex-wrap:\s*wrap/);
});

// app.js appends the state card straight under #app, as a div, like the board root. A selector scoped by the tag alone
// (`#app > div`, specificity 1,0,1) would beat `.card` and turn the card into the board's two-column grid.
test('the board grid rules do not apply to the state card', () => {
  const css = readFileSync(join(PLUGIN, 'ui', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const boardRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selectors: m[1].split(',').map((x) => x.trim()), body: m[2] }))
    .filter((r) => r.selectors.some((x) => /^#app\s*>\s*div\b/.test(x)));
  assert.ok(boardRules.length >= 3, 'the board grid rules are found');
  for (const { selectors, body } of boardRules) {
    for (const sel of selectors.filter((x) => /^#app\s*>\s*div\b/.test(x))) {
      assert.match(sel, /^#app\s*>\s*div:not\(\.card\)/, `"${sel}" must exclude the state card`);
    }
    if (/\bdisplay:\s*grid\b/.test(body)) assert.ok(selectors.every((x) => /:not\(\.card\)/.test(x)), 'the grid is for the board only');
  }
  assert.match(css, /\.card\s*\{[^}]*display:\s*flex/, 'the card lays itself out as a flex column');
});

// Repo controls wrap inside the header; plan-tab counts stay whole.
test('the repo list fits the phone width and the tab count stays whole', () => {
  const css = readFileSync(join(PLUGIN, 'ui', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyOf = (selector) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((x) => x.trim()).includes(selector)).map((m) => m[2]).join(';');
  const slot = bodyOf('#repo-slot');
  assert.match(slot, /\bmin-width:\s*0\b/, '#repo-slot can shrink below its content');
  assert.match(slot, /\bmax-width:\s*100%/, '#repo-slot never exceeds the header');
  assert.match(slot, /\bdisplay:\s*block\b/, '#repo-slot is a box with a definite width, not an inline span');
  assert.match(bodyOf('.repo-list'), /flex-wrap:\s*wrap/, 'repo buttons wrap to the slot');
  assert.match(bodyOf('.repo-pill'), /max-width:\s*100%/, 'repo controls fit their slot');
  const count = bodyOf('.ptab span:last-child');
  assert.match(count, /\bwhite-space:\s*nowrap/, 'the tab count is not split');
  assert.match(count, /\boverflow-wrap:\s*normal/, 'overflow-wrap: anywhere is off for the count');
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

test('each /api/snapshots request uses the cached registered repos', () => withFixture(async ({ dir, home }) => {
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
      assert.equal(calls.length, 0, calls.join('\n'));
    });
  } finally {
    process.env.PATH = path;
  }
}));

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

// ---- renderer ----

// A recording stub DOM: just enough of the browser for mount(), with the calls the tests assert on kept on the nodes.
function stubNode(tag) {
  const attrs = {};
  const listeners = {};
  const node = {
    tag, children: [], className: '', textContent: '', attrs, listeners, open: false, value: '', scrolls: 0, focuses: 0, focusOptions: [],
    style: { vars: {}, setProperty(name, value) { this.vars[name] = value; } },
    classList: {
      add: (c) => { if (!node.classList.contains(c)) node.className = `${node.className} ${c}`.trim(); },
      remove: (c) => { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains: (c) => node.className.split(/\s+/).includes(c),
    },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    fire(type) { (listeners[type] ?? []).forEach((fn) => fn()); },
    append(...kids) { node.children.push(...kids); },
    prepend(...kids) { node.children.unshift(...kids); },
    replaceChildren(...kids) { node.children = kids; },
    scrollIntoView() { node.scrolls++; },
    focus(options) { node.focuses++; node.focusOptions.push(options); },
  };
  return node;
}

const flatten = (node) => [node, ...(node.children ?? []).flatMap(flatten)];
const hasClass = (node, cls) => node.className.split(/\s+/).includes(cls);
const textOf = (node) => [node.textContent, ...node.children.map(textOf)].join('');
const byClass = (root, cls) => flatten(root).filter((n) => hasClass(n, cls));
const byKey = (root, key) => flatten(root).find((n) => n.attrs['data-key'] === key);

// mount() against a stub document, a fake EventSource and captured highlight timers.
async function mountApp({ snaps = [], hidden = false, failing = false } = {}) {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const els = Object.fromEntries(['top', 'repo-slot', 'updated', 'banner', 'app'].map((id) => [id, stubNode('div')]));
  const listeners = {};
  const document = {
    hidden,
    documentElement: { dataset: {} },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    getElementById: (id) => els[id] ?? null,
    createElement: stubNode,
    createElementNS: (ns, tag) => Object.assign(stubNode(tag), { ns }),
    createTextNode: (text) => Object.assign(stubNode('#text'), { textContent: text }),
  };
  const timers = [];
  let fetches = 0;
  let time = Date.UTC(2026, 9, 26, 12, 0, 0);
  let stream;
  const state = { data: snaps, failing, closed: false };
  class EventSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 1; stream = this; }
    addEventListener(type, fn) { this[type] = fn; }
  }
  const message = async () => {
    time += 1000;
    if (stream) {
      stream.readyState = state.closed ? EventSource.CLOSED : 1;
      if (state.failing) stream.error?.({});
      else stream.message?.({ data: JSON.stringify(state.data) });
    }
    await flush();
  };
  const env = {
    document,
    localStorage: { getItem: (key) => state[key] ?? null, setItem: (key, value) => { state[key] = value; } },
    EventSource,
    fetch: async () => { fetches++; throw new Error('reconnecting is forbidden'); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    now: () => new Date(time),
  };
  const { mount } = await import(pathToFileURL(APP).href);
  mount(env);
  await message();
  return {
    document, els, state, stream: () => stream, message, advance: (ms) => { time += ms; }, fetches: () => fetches, settle: flush,
    fire: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
    // Runs the live timers set with `ms` (any when omitted); the others stay.
    tick: async (ms) => {
      for (const t of timers) {
        if (t.live && (ms === undefined || t.ms === ms)) {
          t.live = false;
          t.fn();
        }
      }
      await flush();
    },
    root: () => els.app.children[0],
    hero: () => byClass(els.app, 'hero-title').map(textOf),
    rows: () => byClass(els.app, 'trow'),
  };
}

const task = (id, status, extra = {}) => ({ id, title: `Task ${id}`, status, reason: null, tier: null, effectiveTier: null, commits: [], skills: [], ...extra });
const plan = (name, state, tasks) => ({ name, state, tasks, total: tasks.length, done: tasks.filter((t) => t.status === 'done').length });
const BODY = '- **Stage/task:** Plan x · T1\n- **Done:** did it\n- **Verification:** ran it\n- **Next:** ship it\n';
const entry = (i, body = BODY) => ({ date: '2026-10-26', title: `Entry ${i}`, stageTask: `Plan x · T${i}`, body });
const snap = (name, plans, { mode = 'store', branch = 'main', entries = [] } = {}) => ({
  schema: `${BRAND.marketplace}/tracking-snapshot@1`,
  repo: { name, root: `/r/${name}`, mode, branch, shareable: false },
  plans, status: { text: `status of ${name}` }, progress: { entries }, generatedAt: '2026-10-26T12:00:00.000Z',
});
const ALPHA_PLANS = () => [
  plan('2026-10-10-alpha-earlier', 'done', [task('T1', 'done'), task('T2', 'done'), task('T3', 'done')]),
  plan('2026-10-20-alpha-work', 'active', [task('T1', 'done'), task('T2', 'in_progress'), task('T3', 'pending'), task('T4', 'blocked', { reason: 'waiting' })]),
];
const BETA_PLANS = () => [plan('2026-10-22-beta-work', 'active', [task('T1', 'pending'), task('T2', 'pending')])];
const TWO_REPOS = () => [snap('alpha', ALPHA_PLANS(), { entries: [entry(1)] }), snap('beta', BETA_PLANS())];

test('importing app.js in node mounts nothing', async () => {
  assert.equal(globalThis.document, undefined);
  const mod = await import(pathToFileURL(APP).href);
  assert.equal(typeof mod.mount, 'function');
});

test('mount opens /api/events and renders the first message', async () => {
  const app = await mountApp({ snaps: TWO_REPOS(), hidden: true });
  assert.equal(app.stream()?.url, '/api/events');
  assert.deepEqual(app.hero(), ['alpha work']);
  assert.equal(app.fetches(), 0);
});

test('app.js no longer polls /api/snapshots', async () => {
  const source = readFileSync(APP, 'utf8');
  assert.doesNotMatch(source, /fetch|REFRESH_MS|visibilitychange/);
  const html = readFileSync(INDEX, 'utf8');
  assert.match(html, /<noscript>[\s\S]*\/api\/events/);
});

test('renders the default plan of the first repo', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  assert.deepEqual(app.hero(), ['alpha work']);
  assert.equal(byClass(app.els.app, 'cell').length, 4);
  assert.deepEqual(byClass(app.els.app, 'cell').map((c) => c.style.vars['--i']), [0, 1, 2, 3]);
  assert.deepEqual(byClass(app.els.app, 'pulse').length, 1, 'the in_progress cell pulses');
  assert.deepEqual(byClass(app.els.app, 'hero-date').map(textOf), ['2026-10-20']);
  assert.deepEqual(byClass(app.els.app, 'current').map(textOf), ['▸ T2']);
  assert.match(textOf(byClass(app.els.app, 'headline')[0]), /1 in progress/);
  assert.match(textOf(byClass(app.els.app, 'count')[0]), /1\/4/);
  // Open filter: the done task is hidden, blocked comes first.
  assert.deepEqual(app.rows().map((r) => textOf(byClass(r, 't-id')[0])), ['T2']);
  // Plan tabs: active first, short name with the full name in title.
  const tabs = byClass(app.els.app, 'ptab');
  assert.deepEqual(tabs.map((t) => t.attrs.title), ['2026-10-20-alpha-work', '2026-10-10-alpha-earlier']);
  assert.match(textOf(tabs[0]), /^alpha-work1\/4$/);
});

test('repo list shows the mode and branch with selectable buttons', async () => {
  const one = await mountApp({ snaps: [snap('alpha', ALPHA_PLANS(), { mode: 'store', branch: 'main' })] });
  const pill = byClass(one.els['repo-slot'], 'repo-pill');
  assert.equal(pill.length, 1);
  assert.equal(pill[0].tag, 'button');
  assert.match(textOf(pill[0]), /alpha/);
  assert.match(textOf(pill[0]), /store/);
  assert.match(textOf(pill[0]), /main/);
  assert.equal(flatten(one.els['repo-slot']).filter((n) => n.tag === 'select').length, 0);
  const two = await mountApp({ snaps: TWO_REPOS() });
  assert.deepEqual(byClass(two.els['repo-slot'], 'repo-item').map((n) => n.attrs['data-key']), ['repo:/r/alpha', 'repo:/r/beta']);
  assert.equal(byKey(two.els['repo-slot'], 'repo:/r/alpha').attrs['aria-pressed'], 'true');
  // The brand sits first in the header and holds the logo SVG.
  const brand = one.els.top.children[0];
  assert.ok(hasClass(brand, 'brand'));
  assert.ok(flatten(brand).some((n) => n.tag === 'svg' && n.ns === 'http://www.w3.org/2000/svg'));
});

test('the status panel is a folded details titled Status', async () => {
  const app = await mountApp({ snaps: [snap('alpha', ALPHA_PLANS())] });
  const [panel] = byClass(app.els.app, 'status-panel');
  assert.equal(panel.tag, 'details');
  assert.equal(panel.open, false);
  assert.deepEqual(panel.children.filter((n) => n.tag === 'summary').map(textOf), ['Status']);
  assert.equal(textOf(panel.children.find((n) => n.tag === 'pre')), 'status of alpha');
});

test("a later message re-renders and keeps the viewer's selection", async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  byKey(app.els['repo-slot'], 'repo:/r/beta').fire('click');
  assert.deepEqual(app.hero(), ['beta work']);
  const again = byKey(app.els['repo-slot'], 'repo:/r/beta');
  assert.equal(again.attrs['aria-pressed'], 'true');
  assert.equal(again.focuses, 1, 'focus returns to the rebuilt repo button');
  byKey(app.els['repo-slot'], 'repo:/r/alpha').fire('click');
  assert.deepEqual(app.hero(), ['alpha work']);
  byKey(app.els.app, 'plan:2026-10-10-alpha-earlier').fire('click');
  assert.deepEqual(app.hero(), ['alpha earlier']);
  assert.equal(app.rows().length, 0, 'nothing is open in a finished plan');
  byKey(app.els.app, 'chip:all').fire('click');
  assert.equal(app.rows().length, 3);
  assert.equal(byKey(app.els.app, 'chip:all').focuses, 1, 'focus moves to the new chip');
  const before = app.root();
  app.state.data = TWO_REPOS().map((repo) => ({ ...repo, status: { text: 'new status' } }));
  await app.message();
  assert.notEqual(app.root(), before);
  assert.deepEqual(app.hero(), ['alpha earlier']);
  assert.equal(byKey(app.els.app, 'chip:all').attrs['aria-pressed'], 'true');
  assert.equal(app.fetches(), 0, 'viewer actions never fetch');
});

test('picking a plan or switching repo resets the filter and the open entry', async () => {
  const entries = [entry(1), entry(2)];
  const app = await mountApp({ snaps: [snap('alpha', ALPHA_PLANS(), { entries }), snap('beta', BETA_PLANS())] });
  byKey(app.els.app, 'chip:all').fire('click');
  byKey(app.els.app, 'entry:1').fire('click');
  assert.equal(byKey(app.els.app, 'entry:1').attrs['aria-expanded'], 'true');
  byKey(app.els.app, 'plan:2026-10-10-alpha-earlier').fire('click');
  assert.equal(byKey(app.els.app, 'chip:open').attrs['aria-pressed'], 'true');
  assert.equal(byKey(app.els.app, 'entry:0').attrs['aria-expanded'], 'true');
  byKey(app.els.app, 'chip:all').fire('click');
  byKey(app.els['repo-slot'], 'repo:/r/beta').fire('click');
  assert.equal(byKey(app.els.app, 'chip:open').attrs['aria-pressed'], 'true');
});

test('intro only on the first data render', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  assert.ok(hasClass(app.root(), 'intro'));
  byKey(app.els.app, 'chip:all').fire('click');
  assert.ok(!hasClass(app.root(), 'intro'), 'a viewer action does not replay it');
  app.state.data = [snap('alpha', [plan('2026-10-20-alpha-work', 'active', [task('T1', 'done')])]), snap('beta', BETA_PLANS())];
  await app.message();
  assert.equal(app.fetches(), 0);
  assert.deepEqual(app.hero(), ['alpha work']);
  assert.ok(!hasClass(app.root(), 'intro'), 'new data does not either');
});

test('a message with unchanged data in the same minute keeps the tree, and one a minute later re-renders', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  const before = app.root();
  app.state.data = TWO_REPOS().map((s) => ({ ...s, generatedAt: '2026-10-26T12:00:05.000Z' }));
  await app.message();
  assert.equal(app.fetches(), 0);
  assert.equal(app.root(), before);
  app.advance(60000);
  await app.message();
  assert.notEqual(app.root(), before);
});

test('the time is written by messages only, so a viewer action never blanks it', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  const first = app.els.updated.textContent;
  assert.match(first, /updated \d\d:\d\d:\d\d/);
  byKey(app.els.app, 'chip:all').fire('click');
  assert.equal(app.els.updated.textContent, first);
  await app.message();
  assert.notEqual(app.els.updated.textContent, first);
  assert.match(app.els.updated.textContent, /updated \d\d:\d\d:\d\d/);
});

test('rail cell click highlights its row', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  assert.equal(app.rows().length, 1);
  byKey(app.els.app, 'cell:T1').fire('click');
  assert.equal(byKey(app.els.app, 'chip:all').attrs['aria-pressed'], 'true', 'the filter widens to All');
  const lit = app.rows().filter((r) => hasClass(r, 'highlight'));
  assert.deepEqual(lit.map((r) => textOf(byClass(r, 't-id')[0])), ['T1']);
  assert.equal(lit[0].scrolls, 1);
  assert.equal(app.rows().reduce((n, r) => n + r.scrolls, 0), 1);
  assert.equal(byKey(app.els.app, 'cell:T1').focuses, 1);
  // A cell whose row is already visible keeps the filter.
  byKey(app.els.app, 'chip:open').fire('click');
  byKey(app.els.app, 'cell:T3').fire('click');
  assert.equal(byKey(app.els.app, 'chip:open').attrs['aria-pressed'], 'true');
  assert.equal(app.rows().filter((r) => hasClass(r, 'highlight')).length, 1);
  // The highlight ends after 1600 ms.
  await app.tick(1600);
  assert.equal(app.rows().filter((r) => hasClass(r, 'highlight')).length, 0);
  assert.equal(app.fetches(), 0);
});

test('focus is restored without scrolling, after a message render and after the highlight timer', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  // A message with changed data rebuilds the tree; the focused keyed control gets focus back on its new node.
  const chip = byKey(app.els.app, 'chip:all');
  app.document.activeElement = chip;
  app.state.data = [snap('alpha', [plan('2026-10-20-alpha-work', 'active', [task('T1', 'done')])]), snap('beta', BETA_PLANS())];
  await app.message();
  const chipAfterPoll = byKey(app.els.app, 'chip:all');
  assert.notEqual(chipAfterPoll, chip);
  assert.equal(chipAfterPoll.focuses, 1, 'message render returns focus');
  assert.deepEqual(chipAfterPoll.focusOptions, [{ preventScroll: true }]);
  // The highlight timer re-renders after the row was scrolled to; focus must not drag the page back to the cell.
  app.state.data = TWO_REPOS();
  await app.message();
  const cell = byKey(app.els.app, 'cell:T1');
  cell.fire('click');
  const clicked = byKey(app.els.app, 'cell:T1');
  assert.deepEqual(clicked.focusOptions, [{ preventScroll: true }], 'the click render');
  app.document.activeElement = clicked;
  await app.tick(1600);
  const afterTimer = byKey(app.els.app, 'cell:T1');
  assert.notEqual(afterTimer, clicked);
  assert.deepEqual(afterTimer.focusOptions, [{ preventScroll: true }], 'the highlight-timer render');
});

test('status panel stays open', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  const [panel] = byClass(app.els.app, 'status-panel');
  panel.open = true;
  panel.fire('toggle');
  byKey(app.els.app, 'chip:all').fire('click');
  const [next] = byClass(app.els.app, 'status-panel');
  assert.notEqual(next, panel);
  assert.equal(next.open, true);
});

test('entries: five at most, the first open; pressed and expanded states are attributes', async () => {
  const entries = Array.from({ length: 8 }, (_, i) => entry(i + 1));
  entries[1] = entry(2, 'free text without labelled lines');
  const app = await mountApp({ snaps: [snap('alpha', ALPHA_PLANS(), { entries })] });
  const nodes = byClass(app.els.app, 'entry');
  assert.equal(nodes.length, 5);
  const heads = byClass(app.els.app, 'entry-h');
  assert.deepEqual(heads.map((h) => h.attrs['aria-expanded']), ['true', 'false', 'false', 'false', 'false']);
  assert.match(textOf(heads[0]), /Entry 1/);
  assert.match(textOf(heads[0]), /Plan x · T1/);
  const body = textOf(byClass(nodes[0], 'entry-body')[0]);
  assert.match(body, /Done did it/);
  assert.match(body, /Verification ran it/);
  assert.match(body, /Next ship it/);
  assert.equal(byClass(app.els.app, 'entry-body').length, 1);
  // Opening another entry closes the first; one without labelled lines shows its body.
  byKey(app.els.app, 'entry:1').fire('click');
  assert.deepEqual(byClass(app.els.app, 'entry-h').map((h) => h.attrs['aria-expanded']), ['false', 'true', 'false', 'false', 'false']);
  assert.equal(textOf(byClass(app.els.app, 'entry-body')[0]), 'free text without labelled lines');
  assert.equal(byClass(app.els.app, 'entry-body')[0].children[0].tag, 'pre');
  byKey(app.els.app, 'entry:1').fire('click');
  assert.equal(byClass(app.els.app, 'entry-body').length, 0, 'clicking the open entry closes it');
  const pressed = flatten(app.els.app).filter((n) => n.attrs['aria-pressed'] === 'true');
  assert.deepEqual(pressed.map((n) => n.attrs['data-key']), ['plan:2026-10-20-alpha-work', 'chip:running']);
});

test('a selected plan that disappears falls back to the default plan', async () => {
  const app = await mountApp({ snaps: [snap('alpha', ALPHA_PLANS())] });
  byKey(app.els.app, 'plan:2026-10-10-alpha-earlier').fire('click');
  assert.deepEqual(app.hero(), ['alpha earlier']);
  app.state.data = [snap('alpha', [ALPHA_PLANS()[1]])];
  await app.message();
  assert.deepEqual(app.hero(), ['alpha work']);
});

test('a message that fails keeps the last render and keeps reconnecting', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  const before = app.root();
  app.state.failing = true;
  await app.message();
  assert.equal(app.fetches(), 0);
  assert.equal(app.root(), before);
  app.state.failing = false;
  await app.message();
  assert.equal(app.fetches(), 0);
});

// ---- states ----

const codeOf = (root) => flatten(root).filter((n) => n.tag === 'code').map(textOf);
const bannerText = (app) => textOf(app.els.banner);

test('no repos card', async () => {
  const app = await mountApp({ snaps: [] });
  assert.equal(app.els.app.children.length, 1);
  const cards = byClass(app.els.app, 'card');
  assert.equal(cards.length, 1);
  assert.equal(app.els.app.children[0], cards[0]);
  assert.match(textOf(cards[0]), /No repos registered yet/);
  assert.deepEqual(codeOf(cards[0]), ['/progress-tracking:progress-init']);
  assert.equal(app.els['repo-slot'].children.length, 0);
  assert.equal(bannerText(app), '');
});

test('no plans card', async () => {
  const app = await mountApp({ snaps: [snap('alpha', [], { branch: null })] });
  const cards = byClass(app.els.app, 'card');
  assert.equal(app.els.app.children.length, 1);
  assert.equal(cards.length, 1);
  assert.match(textOf(cards[0]), /No plans yet/);
  assert.deepEqual(codeOf(cards[0]), ['triqual tracking write plan']);
  const pill = byClass(app.els['repo-slot'], 'repo-pill')[0];
  assert.match(textOf(pill), /alpha/);
  assert.match(textOf(pill), /detached HEAD/);
});

test('a state card gives way to the board when data arrives', async () => {
  const app = await mountApp({ snaps: [] });
  assert.equal(byClass(app.els.app, 'card').length, 1);
  app.state.data = [snap('alpha', ALPHA_PLANS())];
  await app.message();
  assert.equal(byClass(app.els.app, 'card').length, 0);
  assert.deepEqual(app.hero(), ['alpha work']);
});

test('connection lost keeps the last tree', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  const before = [...app.els.app.children];
  assert.ok(before.length > 0);
  assert.equal(bannerText(app), '');
  app.state.failing = true;
  await app.message();
  assert.deepEqual(app.els.app.children, before);
  assert.ok(app.els.app.children.every((c, i) => c === before[i]));
  assert.ok(hasClass(app.els.banner, 'banner'));
  assert.match(bannerText(app), /Cannot reach the local server/);
  assert.match(bannerText(app), /reconnect[\s\S]*last good data stays on screen/i);
  assert.deepEqual(codeOf(app.els.banner), ['triqual ui --open']);
  // Still reconnecting, banner stays while it keeps failing.
  await app.message();
  assert.equal(app.fetches(), 0);
  assert.match(bannerText(app), /Cannot reach the local server/);
});

test('a first load that fails shows the banner and no card', async () => {
  const app = await mountApp({ snaps: TWO_REPOS(), failing: true });
  assert.equal(app.els.app.children.length, 0, 'no data yet, so neither the board nor the empty-state cards');
  assert.match(bannerText(app), /Cannot reach the local server/);
  app.state.failing = false;
  await app.message();
  assert.deepEqual(app.hero(), ['alpha work']);
  assert.equal(bannerText(app), '');
});

test('an error shows the banner and a later message clears it', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  app.state.failing = true;
  await app.message();
  assert.ok(bannerText(app).length > 0);
  const failedAt = app.els.updated.textContent;
  app.state.failing = false;
  await app.message();
  assert.equal(bannerText(app), '');
  assert.equal(app.els.banner.children.length, 0);
  assert.ok(!hasClass(app.els.banner, 'banner'), 'the banner class goes with the banner');
  assert.notEqual(app.els.updated.textContent, failedAt);
  assert.match(app.els.updated.textContent, /updated \d\d:\d\d:\d\d/);
});

test('a closed EventSource asks the viewer to reload', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  app.state.failing = true;
  app.state.closed = true;
  await app.message();
  assert.match(bannerText(app), /reload/i);
});

test('a render that throws shows the banner, keeps the last tree and is retried by the next message', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  const before = app.els.app.children[0];
  const broken = TWO_REPOS();
  broken[0].plans = 'not a list';
  app.state.data = broken;
  await app.message();
  assert.equal(app.els.app.children[0], before, 'the stale tree is not replaced by half a render');
  assert.ok(hasClass(app.els.banner, 'banner'));
  assert.match(bannerText(app), /last good data stays on screen/);
  // The same bad data is tried again, not skipped as "unchanged".
  await app.message();
  assert.ok(hasClass(app.els.banner, 'banner'));
  // Good data renders and clears the banner.
  app.state.data = [snap('alpha', [plan('2026-10-20-alpha-fresh', 'active', [task('T1', 'pending')])])];
  await app.message();
  assert.deepEqual(app.hero(), ['alpha fresh']);
  assert.equal(bannerText(app), '');
});

test('blocked current', async () => {
  const blocked = plan('2026-10-20-alpha-work', 'active', [task('T1', 'done'), task('T2', 'blocked', { reason: 'Waiting on owner' })]);
  const app = await mountApp({ snaps: [snap('alpha', [blocked])] });
  assert.deepEqual(byClass(app.els.app, 'current').map(textOf), ['▸ T2 blocked']);
  const hero = byClass(app.els.app, 'hero')[0];
  assert.deepEqual(byClass(hero, 'hero-reason').map(textOf), ['Waiting on owner']);
});

test('blocked current without a reason shows no reason line; a normal current never does', async () => {
  const bare = plan('2026-10-20-alpha-work', 'active', [task('T1', 'done'), task('T2', 'blocked')]);
  const a = await mountApp({ snaps: [snap('alpha', [bare])] });
  assert.deepEqual(byClass(a.els.app, 'current').map(textOf), ['▸ T2 blocked']);
  assert.equal(byClass(a.els.app, 'hero-reason').length, 0);
  const b = await mountApp({ snaps: [snap('alpha', ALPHA_PLANS())] });
  assert.equal(byClass(b.els.app, 'hero-reason').length, 0, 'T4 is blocked but T2 is in progress');
});

test('nothing open', async () => {
  const finished = plan('2026-10-20-alpha-work', 'done', [task('T1', 'done'), task('T2', 'done')]);
  const app = await mountApp({ snaps: [snap('alpha', [finished])] });
  assert.equal(app.rows().length, 0);
  const empty = byClass(app.els.app, 'empty');
  assert.equal(empty.length, 1);
  assert.equal(textOf(empty[0]), 'Nothing here. Every task in this plan is done.');
  byKey(app.els.app, 'chip:all').fire('click');
  assert.equal(byClass(app.els.app, 'empty').length, 0, 'the message goes once rows show');
  assert.equal(app.rows().length, 2);
});

test('nothing open in a plan with open work left elsewhere is not "all done"', async () => {
  const app = await mountApp({ snaps: [snap('alpha', [plan('2026-10-20-alpha-work', 'active', [])])] });
  assert.equal(textOf(byClass(app.els.app, 'empty')[0]), 'Nothing here. This plan has no tasks yet.');
  const dropped = plan('2026-10-21-alpha-drop', 'active', [task('T1', 'done'), task('T2', 'dropped')]);
  const b = await mountApp({ snaps: [snap('alpha', [dropped])] });
  assert.equal(textOf(byClass(b.els.app, 'empty')[0]), 'Nothing here. No task in this plan is open.');
});

test('a rail with more than 20 tasks drops the glyph and id of its cells', async () => {
  const many = plan('2026-10-20-big', 'active', Array.from({ length: 21 }, (_, i) => task(`T${i + 1}`, 'pending')));
  const app = await mountApp({ snaps: [snap('alpha', [many])] });
  assert.equal(byClass(app.els.app, 'cell').length, 21);
  assert.equal(byClass(app.els.app, 'cell-id').length, 0);
  assert.ok(byClass(app.els.app, 'bar').every((b) => b.textContent === ''));
});


test('a cross-site Sec-Fetch-Site request is 403', () => withFixture(async ({ home }) => {
  await withServer(home, async ({ port }) => {
    const denied = await get(port, '/', { fetchSite: 'cross-site' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body, 'forbidden\n');
    assert.equal((await get(port, '/', { fetchSite: 'same-origin' })).status, 200);
    assert.equal((await get(port, '/')).status, 200);
  });
}));

test('DEFAULT_PORT is 47800', () => {
  assert.equal(uiServer.DEFAULT_PORT, 47800);
});

test('triqual ui without --port falls back to a free port when 47800 is taken', async (t) => {
  const occupied = createNetServer();
  try {
    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(47800, '127.0.0.1', resolve);
    });
  } catch (err) {
    t.skip(`cannot occupy port 47800: ${err.code}`);
    return;
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pt-ui-fallback-')));
  const cli = startCli([], cleanEnv(home));
  try {
    const { port } = await cli.ready;
    assert.notEqual(port, 47800);
    assert.equal((await get(port, '/')).status, 200);
    assert.equal(cli.child.exitCode, null);
  } finally {
    await cli.stop();
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});


test('GET /theme.js is served as javascript', async () => {
  await withFixture(async ({ home }) => withServer(home, async ({ port }) => {
    const response = await get(port, '/theme.js');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /javascript/);
  }));
});

test('index.html loads theme.js in head before app.css', () => {
  const html = readFileSync(INDEX, 'utf8');
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert.match(head, /<script src="\/theme.js"><\/script>/);
  assert.ok(head.indexOf('/theme.js') < head.indexOf('/app.css'));
});

test('app.css defines both data-theme palettes', () => {
  const css = readFileSync(join(PLUGIN, 'ui/app.css'), 'utf8');
  assert.match(css, /:root\[data-theme="light"\]\s*\{/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{/);
  assert.match(css, /prefers-color-scheme: light/);
});

test('mounting renders three theme buttons and clicking Dark sets data-theme=dark and stores the key', async () => {
  const app = await mountApp();
  const buttons = byClass(app.els.top, 'theme-button');
  assert.deepEqual(buttons.map(textOf), ['System', 'Light', 'Dark']);
  buttons[2].fire('click');
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.state['triqual-ui:theme'], 'dark');
  assert.deepEqual(buttons.map((b) => b.attrs['aria-pressed']), ['false', 'false', 'true']);
  buttons[0].fire('click');
  assert.equal(app.document.documentElement.dataset.theme, undefined);
  assert.equal(app.state['triqual-ui:theme'], 'system');
});

// ---- cached server and SSE ----
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function openStream(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/events', agent: false }, res => {
      const messages = []; let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        let end;
        while ((end = text.indexOf('\n\n')) >= 0) {
          const frame = text.slice(0, end); text = text.slice(end + 2);
          if (frame.startsWith('data: ')) messages.push({ at: Date.now(), data: JSON.parse(frame.slice(6)) });
        }
      });
      resolve({ res, messages, close() { req.destroy(); res.destroy(); } });
    });
    req.on('error', reject); req.end();
  });
}
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) assert.fail('timed out waiting for stream'); await delay(10); }
}
async function withLive(home, options, fn) {
  const { server } = await startServer({ home, ...options });
  let stream;
  try { stream = await openStream(server.address().port); await fn(stream, server); }
  finally { stream?.close(); await new Promise(resolve => server.close(resolve)); }
}

test('/api/events sends the snapshot list on connect with event-stream headers', () => withFixture(async ({ home, repo }) => {
  await withLive(home, {}, async ({ res, messages }) => {
    assert.equal(res.statusCode, 200); assert.match(res.headers['content-type'], /^text\/event-stream/);
    assertCommonHeaders({ headers: res.headers });
    await until(() => messages.length); assert.equal(messages[0].data[0].repo.root, repo);
  });
}));

test('no snapshot build happens with no client connected', () => withFixture(async ({ home }) => {
  let builds = 0;
  const { server } = await startServer({ home, heartbeatMs: 30, build() { builds++; return {}; } });
  try { await delay(100); assert.equal(builds, 0); }
  finally { await new Promise(resolve => server.close(resolve)); }
}));

test('a tracking add reaches an open stream within 2 s', () => withFixture(async ({ dir, home, repo }) => {
  const previous = process.env.TRIQUAL_TRACKING_DB;
  process.env.TRIQUAL_TRACKING_DB = join(dir, 'data', 'tracking.db');
  execFileSync(process.execPath, [join(PLUGIN, 'cli', 'progress-init.mjs'), '--store', '--accept-unparsed'], { cwd: repo, env: cleanEnv(home), stdio: 'pipe' });
  const draft = join(dir, 'entry.json');
  const add = title => {
    writeFileSync(draft, JSON.stringify({ title, stage_task: 'fixture', done: 'fixture', files: 'none', verification: 'fixture', next: 'none' }));
    execFileSync(process.execPath, [join(PLUGIN, 'cli', 'tracking.mjs'), 'add', draft, '--no-commit'], { cwd: repo, env: cleanEnv(home), stdio: 'pipe' });
  };
  try {
    add('before');
    await withLive(home, { heartbeatMs: 10000, throttleMs: 30 }, async ({ messages }) => {
      await until(() => messages.length); add('after');
      await until(() => messages.some(m => m.data[0].progress.entries.some(e => e.title === 'after')));
    });
  } finally { if (previous === undefined) delete process.env.TRIQUAL_TRACKING_DB; else process.env.TRIQUAL_TRACKING_DB = previous; }
}));

test('a burst of changes yields at most one push per throttle window and a final push', () => withFixture(async ({ dir, home }) => {
  const watchDir = join(dir, 'watch'); mkdirSync(watchDir);
  let builds = 0; const times = [];
  const hub = uiServer.createHub({ home, watchDir, throttleMs: 70, heartbeatMs: 10000, build() { builds++; return {}; } });
  const unsub = hub.subscribe(() => times.push(Date.now()));
  try {
    await until(() => times.length === 1);
    for (let i = 0; i < 9; i++) { writeFileSync(join(watchDir, 'tracking.db'), String(i).repeat(i + 1)); await delay(15); }
    await delay(120);
    assert.ok(times.length >= 2); assert.equal(times.length, builds);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 65, times.join(','));
    assert.ok(times.at(-1) >= times[0] + 130, 'trailing push follows the last change');
  } finally { unsub(); hub.close(); }
}));

test('a closed client is unsubscribed', () => withFixture(async ({ home }) => {
  let builds = 0;
  await withLive(home, { heartbeatMs: 40, build() { builds++; return {}; } }, async stream => {
    await until(() => stream.messages.length); stream.close(); await delay(25);
    const before = builds; await delay(130); assert.equal(builds, before);
  });
}));

test('with a client connected and no writes there is no push after the first', () => withFixture(async ({ dir, home }) => {
  const watchDir = join(dir, 'watch'); mkdirSync(watchDir);
  // Reading empty WALs must not create a self-triggered push loop.
  const hub = uiServer.createHub({ home, watchDir, heartbeatMs: 10000, throttleMs: 30, build() {
    writeFileSync(join(watchDir, 'tracking.db-wal'), ''); rmSync(join(watchDir, 'tracking.db-wal'));
    return {};
  } });
  const messages = []; const stop = hub.subscribe(x => messages.push(x));
  try { await until(() => messages.length); await delay(100); assert.equal(messages.length, 1); }
  finally { stop(); hub.close(); }
}));

test('a missing data directory gives a 200 stream with heartbeat pushes only', () => withFixture(async ({ dir, home }) => {
  await withLive(home, { watchDir: join(dir, 'missing'), heartbeatMs: 60, throttleMs: 20 }, async ({ res, messages }) => {
    assert.equal(res.statusCode, 200); await until(() => messages.length >= 2);
    assert.ok(messages[1].at - messages[0].at >= 45);
  });
}));

for (const name of ['a push does not re-resolve repos, the heartbeat does', 'no git rev-parse --abbrev-ref runs on a push, only on the heartbeat']) test(name, () => withFixture(async ({ dir, home }) => {
  const bin = join(dir, 'git-bin'); mkdirSync(bin);
  const log = join(dir, 'git-calls');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  const watchDir = join(dir, 'watch'); mkdirSync(watchDir);
  try {
    await withLive(home, { watchDir, heartbeatMs: 400, throttleMs: 20 }, async ({ messages }) => {
      await until(() => messages.length); writeFileSync(log, '');
      writeFileSync(join(watchDir, 'tracking.db'), 'changed'); await until(() => messages.length === 2);
      assert.doesNotMatch(readFileSync(log, 'utf8'), /--show-toplevel/);
      assert.doesNotMatch(readFileSync(log, 'utf8'), /--abbrev-ref/);
      await until(() => messages.length >= 3);
      assert.match(readFileSync(log, 'utf8'), /--show-toplevel/);
      assert.match(readFileSync(log, 'utf8'), /--abbrev-ref/);
    });
  } finally { process.env.PATH = oldPath; }
}));


test('a write during a build triggers a throttled trailing push', () => withFixture(async ({ dir, home }) => {
  const watchDir = join(dir, 'watch'); mkdirSync(watchDir);
  let release; let builds = 0;
  const times = [];
  const hub = uiServer.createHub({ home, watchDir, heartbeatMs: 10000, throttleMs: 80, async build() {
    builds++;
    if (builds === 1) await new Promise(resolve => { release = resolve; });
    return {};
  } });
  const stop = hub.subscribe(() => times.push(Date.now()));
  try {
    await until(() => release);
    writeFileSync(join(watchDir, 'tracking.db'), 'concurrent write');
    await delay(100); release();
    await until(() => times.length >= 2);
    assert.equal(builds, 2);
    assert.ok(times[1] - times[0] >= 75, times.join(','));
  } finally { release?.(); stop(); hub.close(); }
}));


test('with three repos and one in-progress task the page opens on that repo and the Now strip shows the task', async () => {
  const app = await mountApp({ snaps: [snap('idle', BETA_PLANS()), ...TWO_REPOS()] });
  assert.deepEqual(app.hero(), ['alpha work']);
  assert.match(textOf(byClass(app.els.app, 'now-strip')[0]), /alpha.*T2.*Task T2.*0 agents/);
  assert.match(textOf(byClass(app.els.app, 'now-strip')[0]), /waiting on you: 1/);
});

test("clicking another repo's Now chip switches repo and plan", async () => {
  const beta = snap('beta', [plan('beta-active', 'active', [task('T8', 'in_progress', { since: Date.UTC(2026, 9, 26, 11) })])]);
  const app = await mountApp({ snaps: [...TWO_REPOS().slice(0, 1), beta] });
  byKey(app.els.app, 'now:/r/alpha:2026-10-20-alpha-work:T2').fire('click');
  assert.deepEqual(app.hero(), ['alpha work']);
  byKey(app.els.app, 'now:/r/beta:beta-active:T8').fire('click');
  assert.deepEqual(app.hero(), ['beta active']);
  assert.ok(hasClass(app.rows()[0], 'highlight'));
  assert.equal(app.rows()[0].attrs['data-id'], 'T8');
});

test('Nothing running shows when no task is in progress', async () => {
  const app = await mountApp({ snaps: [snap('beta', BETA_PLANS())] });
  assert.match(textOf(byClass(app.els.app, 'now-strip')[0]), /Nothing running/);
  assert.equal(byKey(app.els.app, 'chip:open').attrs['aria-pressed'], 'true');
});

test('idle repos are folded', async () => {
  const app = await mountApp({ snaps: [snap('idle', BETA_PLANS()), ...TWO_REPOS()] });
  const details = byClass(app.els['repo-slot'], 'idle-repos')[0];
  assert.equal(details.tag, 'details'); assert.equal(details.open, false);
  assert.equal(textOf(details.children[0]), '2 idle');
  assert.deepEqual(byClass(app.els['repo-slot'], 'repo-item').map((n) => n.attrs['data-key']), ['repo:/r/alpha', 'repo:/r/idle', 'repo:/r/beta']);
});

test('a later push never changes the selected repo', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  byKey(app.els['repo-slot'], 'repo:/r/beta').fire('click');
  app.state.data = [...TWO_REPOS(), snap('busy', [plan('busy', 'active', [task('T9', 'in_progress', { since: Date.UTC(2026, 9, 26, 12) })])])];
  await app.message(); assert.deepEqual(app.hero(), ['beta work']);
});

test('a planless selected repo keeps the global Now strip and navigation', async () => {
  const app = await mountApp({ snaps: [...TWO_REPOS(), snap('empty', [])] });
  byKey(app.els['repo-slot'], 'repo:/r/empty').fire('click');
  assert.match(textOf(app.els.app), /No plans yet/);
  const strip = byClass(app.els.app, 'now-strip');
  assert.equal(strip.length, 1);
  assert.match(textOf(strip[0]), /waiting on you: 1/);
  byKey(app.els.app, 'now:/r/alpha:2026-10-20-alpha-work:T2').fire('click');
  assert.deepEqual(app.hero(), ['alpha work']);
  assert.ok(hasClass(app.rows().find((row) => row.attrs['data-id'] === 'T2'), 'highlight'));
});

test('a selected repo returns after a transient snapshot omission', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  byKey(app.els['repo-slot'], 'repo:/r/beta').fire('click');
  app.state.data = TWO_REPOS().slice(0, 1);
  await app.message();
  assert.deepEqual(app.hero(), ['alpha work']);
  app.state.data = TWO_REPOS();
  await app.message();
  assert.deepEqual(app.hero(), ['beta work']);
});

test('the default filter is running', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  assert.equal(byKey(app.els.app, 'chip:running').attrs['aria-pressed'], 'true');
  assert.deepEqual(app.rows().map((r) => r.attrs['data-id']), ['T2']);
});


test('a pushed repo lists fixture sessions with events and notes', () => withFixture(async ({ home, repo }) => {
  const dataDir = storePaths({ home, env: process.env }).dataDir;
  const db = openSessions(dataDir);
  const now = Date.now();
  const fixtures = readFileSync(join(PLUGIN, 'test', 'fixtures', 'hook-payloads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const [index, payload] of fixtures.entries()) record(db, payload, now + index, repo);
  record(db, { session_id: 'other-repo', hook_event_name: 'SessionStart' }, now, repo + '-other');
  record(db, { session_id: 'old-session', hook_event_name: 'SessionStart' }, now - 3 * 60 * 60 * 1000, repo);
  db.close();
  mkdirSync(join(home, '.claude-mem'));
  const notes = new DatabaseSync(join(home, '.claude-mem', 'claude-mem.db'));
  notes.exec(`CREATE TABLE sdk_sessions(memory_session_id TEXT, content_session_id TEXT);
    CREATE TABLE observations(memory_session_id TEXT, agent_id TEXT, created_at_epoch INTEGER, type TEXT, title TEXT);
    INSERT INTO sdk_sessions VALUES ('memory-fixture', 'fixture-session');
    INSERT INTO observations VALUES ('memory-fixture', 'worker-1', ${now}, 'finding', 'Useful note');`);
  notes.close();
  await withLive(home, {}, async ({ messages }) => {
    await until(() => messages.length);
    const sessions = messages[0].data[0].sessions;
    assert.equal(sessions.length, 4);
    const worker = sessions.find(s => s.agentId === 'worker-1');
    assert.ok(worker.events.length > 0);
    assert.deepEqual(worker.notes, [{ at: now, type: 'finding', title: 'Useful note' }]);
    assert.deepEqual(sessions.find(s => s.agentId === '').notes, []);
  });
}));

test('sessions is [] when sessions.db is absent or corrupt', () => withFixture(async ({ home }) => {
  const file = join(storePaths({ home, env: process.env }).dataDir, 'sessions.db');
  for (const corrupt of [false, true]) {
    if (corrupt) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'not a database'); }
    await withServer(home, async ({ port }) => {
      assert.deepEqual(JSON.parse((await get(port, '/api/snapshots')).body)[0].sessions, []);
    });
  }
}));

test('triqual tasks export --json output is identical with sessions recorded', () => withFixture(async ({ home, repo }) => {
  const run = () => JSON.parse(execFileSync(process.execPath, [join(PLUGIN, 'cli', 'tasks.mjs'), 'export', '--json'], { cwd: repo, env: cleanEnv(home), encoding: 'utf8' }));
  const before = run();
  const db = openSessions(storePaths({ home, env: process.env }).dataDir);
  record(db, { session_id: 'fixture-session', hook_event_name: 'SessionStart' }, Date.now(), repo);
  db.close();
  const after = run();
  // generatedAt is the export invocation time, independent of session recording.
  after.generatedAt = before.generatedAt;
  assert.deepEqual(after, before);
  assert.equal('sessions' in after, false);
}));

// ---- live agent panel ----
const agentFixture = () => {
  const at = Date.UTC(2026, 9, 26, 12);
  return ['', 'orchestrator', 'worker-1', 'worker-2'].map((agentId, index) => ({
    sessionId: 'fixture-session', agentId,
    parentAgentId: index === 0 ? null : index === 1 ? '' : 'orchestrator',
    agentType: index === 0 ? 'controller' : index === 1 ? 'orchestrator' : 'worker',
    task: index > 1 ? `T${index}` : null, model: 'fixture-model',
    startedAt: at - 120000, lastAt: at, endedAt: null,
    events: [{ at: at - 2000, kind: 'start', label: 'Started' }, { at, kind: 'tool', label: `Latest ${agentId || 'controller'}` }],
    notes: [{ at: at - 1000, type: 'finding', title: 'A useful note' }],
  }));
};
const agentSnap = () => ({ ...snap('alpha', ALPHA_PLANS()), sessions: agentFixture() });

test('a fixture with a controller, an orchestrator and two workers renders four cards and three elbows', async () => {
  const app = await mountApp({ snaps: [agentSnap()] });
  const cards = byClass(app.els.app, 'agent-card');
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map(n => n.attrs['data-key']), ['agent:fixture-session/', 'agent:fixture-session/orchestrator', 'agent:fixture-session/worker-1', 'agent:fixture-session/worker-2']);
  const elbows = flatten(app.els.app).filter(n => n.attrs.class === 'agent-elbow');
  assert.equal(elbows.length, 3);
  assert.ok(elbows.every(n => n.tag === 'svg' && n.attrs.width && n.attrs.height));
  assert.match(textOf(cards[2]), /worker.*T2.*fixture-model.*2m.*Latest worker-1/);
  assert.equal(byClass(app.els.app, 'agent-pulse').length, 4);
  assert.equal(byKey(app.els.app, 'agents:toggle').attrs['aria-expanded'], 'true');
});

test('no panel renders without sessions', async () => {
  const app = await mountApp({ snaps: TWO_REPOS() });
  assert.equal(byClass(app.els.app, 'agents-panel').length, 0);
});

test('clicking a card shows its feed newest first', async () => {
  const app = await mountApp({ snaps: [agentSnap()] });
  byKey(app.els.app, 'agent:fixture-session/worker-1').fire('click');
  assert.deepEqual(byClass(app.els.app, 'agent-feed-item').map(textOf), ['TOOLLatest worker-1', 'STARTStarted']);
});

test('the notes toggle shows and hides notes', async () => {
  const app = await mountApp({ snaps: [agentSnap()] });
  byKey(app.els.app, 'agent:fixture-session/worker-1').fire('click');
  assert.doesNotMatch(textOf(app.els.app), /A useful note/);
  byKey(app.els.app, 'agents:notes').fire('click');
  assert.deepEqual(byClass(app.els.app, 'agent-feed-item').map(textOf), ['TOOLLatest worker-1', 'NOTEA useful note', 'STARTStarted']);
  byKey(app.els.app, 'agents:notes').fire('click');
  assert.doesNotMatch(textOf(app.els.app), /A useful note/);
});

test('the selected card survives a push', async () => {
  const app = await mountApp({ snaps: [agentSnap()] });
  byKey(app.els.app, 'agent:fixture-session/worker-2').fire('click');
  byKey(app.els.app, 'agents:notes').fire('click');
  const next = agentSnap(); next.sessions[3].events.push({ at: Date.UTC(2026, 9, 26, 12, 0, 2), kind: 'tool', label: 'New activity' });
  app.state.data = [next]; await app.message();
  assert.equal(byKey(app.els.app, 'agent:fixture-session/worker-2').attrs['aria-pressed'], 'true');
  assert.equal(byKey(app.els.app, 'agents:notes').attrs['aria-pressed'], 'true');
  assert.match(textOf(byClass(app.els.app, 'agent-feed-item')[0]), /New activity/);
  byKey(app.els.app, 'agents:toggle').fire('click');
  app.state.data[0].sessions[0].lastAt++; await app.message();
  assert.equal(byKey(app.els.app, 'agents:toggle').attrs['aria-expanded'], 'false');
  assert.equal(byClass(app.els.app, 'agent-card').length, 0);
});

test('reduced motion stops the pulse', () => {
  assert.match(readFileSync(join(PLUGIN, 'ui', 'app.css'), 'utf8'), /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.agent-pulse[^}]*animation:\s*none/s);
});

test('a planless repo still shows its recorded agents', async () => {
  const fixture = agentSnap(); fixture.plans = [];
  const app = await mountApp({ snaps: [fixture] });
  assert.equal(byClass(app.els.app, 'agent-card').length, 4);
  assert.match(textOf(app.els.app), /No plans yet/);
});
