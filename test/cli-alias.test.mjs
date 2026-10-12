// The deprecated `cm` alias (bin/cm-alias.mjs, installed under BRAND.legacy.cliFile behind the cm symlink): one stderr
// line, then the triqual shim beside it with the same args, stdout and exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../plugins/methodology/bin/lib/brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = join(ROOT, 'bin', 'triqual-shim.mjs');
const ALIAS = join(ROOT, 'bin', 'cm-alias.mjs');
const DEPRECATION = `${BRAND.legacy.cli} is deprecated: use ${BRAND.cli} (${BRAND.legacy.cli} will be removed in a later release)`;
const USAGE = 'usage: doctor FAKE\n';
// Prints its usage on --help; any other call exits 7.
const FAKE_DOCTOR = `if (process.argv.includes('--help')) process.stdout.write(${JSON.stringify(USAGE)});\nelse process.exit(7);\n`;

// A temp HOME with methodology installed at user scope (a fake doctor) and ~/.local/bin as bootstrap lays it out:
// triqual.mjs behind triqual, the alias (BRAND.legacy.cliFile) behind cm. `shim: false` leaves triqual.mjs out.
function withHome(fn, { shim = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cli-alias-')));
  try {
    const installPath = join(home, '.claude', 'plugins', 'cache', BRAND.marketplace, 'methodology', '0.4.0');
    mkdirSync(join(installPath, 'bin'), { recursive: true });
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
    writeFileSync(join(installPath, 'bin', 'doctor.mjs'), FAKE_DOCTOR);
    writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'methodology', version: '0.4.0' }));
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { [`methodology@${BRAND.marketplace}`]: [{ scope: 'user', installPath, version: '0.4.0' }] },
    }));
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    if (shim) {
      copyFileSync(SHIM, join(bin, BRAND.cliFile));
      chmodSync(join(bin, BRAND.cliFile), 0o755);
      symlinkSync(BRAND.cliFile, join(bin, BRAND.cli));
    }
    copyFileSync(ALIAS, join(bin, BRAND.legacy.cliFile));
    chmodSync(join(bin, BRAND.legacy.cliFile), 0o755);
    symlinkSync(BRAND.legacy.cliFile, join(bin, BRAND.legacy.cli));
    return fn({ home, bin });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const run = (file, args, home) => spawnSync(process.execPath, [file, ...args], {
  cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8',
});

test('line 2 of bin/cm-alias.mjs is BRAND.ownership.alias', () => {
  assert.equal(readFileSync(ALIAS, 'utf8').split('\n')[1], BRAND.ownership.alias);
});

test('stdout and exit code are identical through the alias', () => {
  withHome(({ home, bin }) => {
    for (const args of [['doctor', '--help'], ['doctor'], [], ['nope']]) {
      const direct = run(join(bin, BRAND.cliFile), args, home);
      for (const via of [BRAND.legacy.cliFile, BRAND.legacy.cli]) {
        const alias = run(join(bin, via), args, home);
        assert.equal(alias.stdout, direct.stdout, `${via} ${args.join(' ')}`);
        assert.equal(alias.status, direct.status, `${via} ${args.join(' ')}`);
        assert.ok(alias.stderr.startsWith(`${DEPRECATION}\n`), alias.stderr);
        assert.equal(alias.stderr, `${DEPRECATION}\n${direct.stderr}`, `${via} ${args.join(' ')}`);
      }
    }
    assert.equal(run(join(bin, BRAND.cliFile), ['doctor', '--help'], home).stdout, USAGE);
    assert.equal(run(join(bin, BRAND.cliFile), ['doctor'], home).status, 7);
    // The shim's own text names triqual, through the alias too.
    assert.match(run(join(bin, BRAND.cliFile), [], home).stdout, new RegExp(`^usage: ${BRAND.cli} <command> `));
    assert.match(run(join(bin, BRAND.legacy.cli), ['nope'], home).stderr, new RegExp(`\\n${BRAND.cli}: unknown command "nope"\\n`));
  });
});

test('alias exits 3 when triqual.mjs is missing', () => {
  withHome(({ home, bin }) => {
    const r = run(join(bin, BRAND.legacy.cli), ['doctor'], home);
    assert.equal(r.status, 3);
    assert.equal(r.stdout, '');
    const lines = r.stderr.split('\n');
    assert.equal(lines.length, 3, r.stderr); // two lines, then the empty string after the last newline
    assert.equal(lines[0], DEPRECATION);
    assert.ok(lines[1].includes(join(bin, BRAND.cliFile)), lines[1]);
    assert.equal(lines[2], '');
  }, { shim: false });
});
