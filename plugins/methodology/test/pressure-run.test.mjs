// The pressure-scenario runner (test/pressure/run.mjs): a fake `claude` on PATH stands in for the headless run, so
// nothing reaches a model. Carried from T12 into T16: the output file keeps what `claude -p` wrote to stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'pressure', 'run.mjs');

test('run.mjs writes claude -p stderr into the output file', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pressure-test-')));
  try {
    const bin = join(dir, 'bin');
    const tmp = join(dir, 'tmp');
    mkdirSync(bin);
    mkdirSync(tmp);
    writeFileSync(join(bin, 'claude'), [
      '#!/bin/sh',
      'echo \'{"result":"the answer"}\'',
      'echo "warning: rate limited" >&2',
      'echo "second stderr line" >&2',
      'exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const env = { ...process.env, HOME: dir, TMPDIR: tmp, PATH: [bin, ...(process.env.PATH ?? '').split(delimiter)].join(delimiter) };
    delete env.XDG_CONFIG_HOME;
    const r = spawnSync(process.execPath, [RUN, '--only', 'S1', '--variant', 'baseline'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trim();
    const text = readFileSync(join(out, 'S1-baseline.md'), 'utf8');
    assert.match(text, /^exit 1\n/);
    assert.match(text, /the answer/);
    assert.match(text, /warning: rate limited\nsecond stderr line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
