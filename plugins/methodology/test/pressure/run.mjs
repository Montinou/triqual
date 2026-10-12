#!/usr/bin/env node
// Runs every pressure scenario twice (baseline, with the forked skill) with headless `claude -p` in a fresh temp
// directory and only project/local setting sources, so no CLAUDE.md, plugin, skill or hook can leak in.
// Usage: node run.mjs [--model sonnet] [--only S1,S3] [--variant baseline|skill] ; writes to $TMPDIR/pressure-<ts>/.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', '..', 'skills');
const { values } = parseArgs({ options: { model: { type: 'string', default: 'sonnet' }, only: { type: 'string' }, variant: { type: 'string' } } });
const spec = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'));
const only = values.only ? new Set(values.only.split(',')) : null;
const variants = values.variant ? [values.variant] : ['baseline', 'skill'];
const out = mkdtempSync(join(tmpdir(), 'pressure-'));

function prompt(s, variant) {
  const parts = [spec.preamble];
  if (variant === 'skill') {
    const text = s.skills.map((p) => `--- ${p} ---\n${readFileSync(join(skillsDir, p), 'utf8')}`).join('\n\n');
    parts.push(`You follow these instructions (skill files loaded in this session):\n\n${text}`);
  }
  parts.push(s.setup);
  return parts.join('\n\n');
}

function runOne(s, variant) {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pressure-cwd-'));
    const child = spawn('claude', ['-p', prompt(s, variant), '--model', values.model, '--setting-sources', 'project,local', '--output-format', 'json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let text;
      try { text = JSON.parse(buf).result ?? buf; } catch { text = buf; }
      // stderr is kept: a failed or rate-limited run must show why in the output file.
      const stderr = err.trim() ? `\n--- stderr ---\n${err.trimEnd()}\n` : '';
      writeFileSync(join(out, `${s.id}-${variant}.md`), `exit ${code}\n\n${text}\n${stderr}`);
      resolve();
    });
  });
}

const jobs = spec.scenarios.filter((s) => !only || only.has(s.id)).flatMap((s) => variants.map((v) => () => runOne(s, v)));
const limit = 3;
await Promise.all(Array.from({ length: limit }, async () => { while (jobs.length) await jobs.shift()(); }));
console.log(out);
