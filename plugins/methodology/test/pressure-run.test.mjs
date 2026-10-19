// The pressure-scenario runner (test/pressure/run.mjs): a fake `claude` on PATH stands in for the headless run, so
// nothing reaches a model. Carried from T12 into T16: the output file keeps what `claude -p` wrote to stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('scenarios.json carries S1-S9, each with a setup and skill files that exist, and S4 keys on the suggestions block', () => {
  const here = dirname(RUN);
  const spec = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));
  assert.deepEqual(spec.scenarios.map((s) => s.id), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']);
  for (const s of spec.scenarios) {
    assert.ok(s.setup.length > 0, `${s.id} has a setup`);
    for (const p of s.skills) assert.ok(existsSync(join(here, '..', '..', 'skills', p)), `${s.id} skill file ${p} exists`);
  }
  const s4 = spec.scenarios.find((s) => s.id === 'S4');
  assert.match(s4.setup, /<headjack-suggestions>/);
  assert.doesNotMatch(s4.setup, /skill-suggest hint/);
  assert.doesNotMatch(s4.setup, /hook/, 'no hook puts the block in the prompt');
  assert.match(s4.setup, /triqual suggest/);
  const s9 = spec.scenarios.find((s) => s.id === 'S9');
  assert.deepEqual(s9.skills, ['executing-plans/SKILL.md']);
});
