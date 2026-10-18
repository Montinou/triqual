// Runtime checks on the brainstorming visual companion (skills/brainstorming/scripts). They start the real scripts and
// hold for whatever the skill set looks like around them; when a later phase renames or removes the brainstorming skill
// they skip with a message naming the constant to re-key (COMPANION_SKILL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANION_SKILL = 'brainstorming';
const SKILL_DIR = join(ROOT, 'plugins', 'methodology', 'skills', COMPANION_SKILL);
const SCRIPTS = join(SKILL_DIR, 'scripts');
const present = existsSync(join(SCRIPTS, 'server.cjs')) && existsSync(join(SCRIPTS, 'start-server.sh'));
const SKIP = `no ${COMPANION_SKILL}/scripts companion (renamed or removed by a later phase: re-key COMPANION_SKILL)`;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Spawned children: a temp HOME, no XDG_CONFIG_HOME, and no variable that steers the companion.
const companionEnv = (extra = {}) => {
  const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'companion-home-')), ...extra };
  delete env.XDG_CONFIG_HOME;
  delete env.CODEX_CI;
  for (const key of Object.keys(env)) {
    if (/^BRAINSTORM_|TELEMETRY|^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$/.test(key) && !(key in extra)) delete env[key];
  }
  return env;
};

// What a served page must not carry: a non-loopback host, an image, or upstream branding. Returns the problems.
const pageProblems = (html) => {
  const bad = [];
  const hosts = [...html.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^\s'"`<>)\/:?#]*)/gi)]
    .map((m) => m[1])
    .filter((host) => host && !LOOPBACK_HOSTS.has(host.toLowerCase()));
  if (hosts.length) bad.push(`the page names a remote host: ${hosts.join(', ')}`);
  if (/<img\b/i.test(html)) bad.push('the page loads an image');
  if (/superpowers|prime radiant/i.test(html)) bad.push('the page carries upstream branding');
  return bad;
};

test('the visual companion stores sessions under .methodology/brainstorm/ and ensures .methodology/.gitignore', (t) => {
  if (!present) return t.skip(SKIP);
  const project = mkdtempSync(join(tmpdir(), 'companion-project-'));
  const env = companionEnv();
  let sessionDir = null;
  try {
    const r = spawnSync('bash', [join(SCRIPTS, 'start-server.sh'), '--project-dir', project, '--background'], {
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const info = JSON.parse(r.stdout.trim().split('\n').at(-1));
    sessionDir = dirname(info.screen_dir);
    assert.ok(
      info.screen_dir.startsWith(join(project, '.methodology', 'brainstorm') + sep),
      `screen_dir ${info.screen_dir} is not under .methodology/brainstorm/`,
    );
    assert.equal(readFileSync(join(project, '.methodology', '.gitignore'), 'utf8'), '*\n');
    assert.ok(
      readFileSync(join(SKILL_DIR, 'visual-companion.md'), 'utf8').includes('.methodology/brainstorm/'),
      'the guide does not name it',
    );
  } finally {
    if (sessionDir) spawnSync('bash', [join(SCRIPTS, 'stop-server.sh'), sessionDir], { env, timeout: 20000 });
    rmSync(project, { recursive: true, force: true });
    rmSync(env.HOME, { recursive: true, force: true });
  }
});

test('server.cjs renders no remote branding', async (t) => {
  if (!present) return t.skip(SKIP);
  const dir = mkdtempSync(join(tmpdir(), 'companion-server-'));
  const token = randomBytes(32).toString('hex');
  const env = companionEnv({ BRAINSTORM_DIR: dir, BRAINSTORM_TOKEN: token, BRAINSTORM_HOST: '127.0.0.1' });
  const child = spawn(process.execPath, [join(SCRIPTS, 'server.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'server-started') {
            clearTimeout(timer);
            resolve(event);
          }
        } catch {
          /* not an event line */
        }
      });
    });
    const page = async () => {
      const res = await fetch(`http://127.0.0.1:${info.port}/`, {
        headers: { cookie: `brainstorm-key-${info.port}=${token}` },
      });
      assert.equal(res.status, 200);
      return res.text();
    };
    const pages = [await page()];
    writeFileSync(join(info.screen_dir, 'choice.html'), '<h2>Pick one</h2>');
    pages.push(await page());
    assert.match(pages[1], /Pick one/, 'the fragment was not served in the frame');
    for (const html of pages) assert.deepEqual(pageProblems(html), []);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
    rmSync(env.HOME, { recursive: true, force: true });
  }
});

test('the served-page check fails on a seeded defect', () => {
  assert.deepEqual(pageProblems('<h2>ok</h2><script src="http://127.0.0.1:1/x.js"></script>'), []);
  assert.deepEqual(pageProblems('<link href="https://cdn.example.com/x.css">'), [
    'the page names a remote host: cdn.example.com',
  ]);
  assert.deepEqual(pageProblems('<IMG src="x.png">'), ['the page loads an image']);
  assert.deepEqual(pageProblems('<title>Superpowers Brainstorming</title>'), ['the page carries upstream branding']);
  assert.deepEqual(pageProblems('<p>Prime Radiant</p>'), ['the page carries upstream branding']);
});
