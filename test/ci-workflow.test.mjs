// Tests for .github/workflows/ci.yml, read as text: no YAML dependency, so a small reader written for this file's shape splits
// the jobs and the steps, and every assertion is on lines. CI repeats the local hooks on every pull request of the public
// repository and is skipped everywhere else (the private repository has the hooks and no deny-list-free runner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const lines = text.split('\n');

const REPO_IF = "if: github.repository == 'Montinou/triqual'";
const indentOf = (line) => line.length - line.trimStart().length;

// The lines after index `start` that are indented deeper than `depth`, up to the next line at that indent or less. Blank lines
// and comments do not end a block.
function after(source, start, depth) {
  const body = [];
  for (const line of source.slice(start + 1)) {
    if (line.trim() !== '' && !line.trimStart().startsWith('#') && indentOf(line) <= depth) break;
    body.push(line);
  }
  return body;
}

// The block under `header` (a line such as `jobs:` or `  test:`).
function block(source, header) {
  const start = source.findIndex((line) => line === header);
  assert.notEqual(start, -1, `missing "${header.trim()}"`);
  return after(source, start, indentOf(header));
}

const jobsBlock = block(lines, 'jobs:');
const jobNames = jobsBlock.filter((line) => /^ {2}[a-z][\w-]*:\s*$/.test(line)).map((line) => line.trim().slice(0, -1));
const job = (name) => block(jobsBlock, `  ${name}:`);
const has = (body, line) => body.some((candidate) => candidate.trim() === line);

// Every line of a `run:` step (the one-line form and the lines of a `run: |` block).
function runLines(body) {
  const found = [];
  for (let i = 0; i < body.length; i += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(body[i]);
    if (!match) continue;
    if (match[2] !== '' && !/^[|>][+-]?$/.test(match[2])) found.push(match[2]);
    else for (const line of after(body, i, match[1].length + (body[i].trimStart().startsWith('- ') ? 2 : 0))) found.push(line);
  }
  return found;
}

test('the workflow runs on pull_request opened, synchronize, reopened and edited, with no branch filter', () => {
  const on = block(lines, 'on:');
  assert.deepEqual(on.filter((line) => line.trim() !== '').map((line) => line.trim()), ['pull_request:', 'types: [opened, synchronize, reopened, edited]']);
  assert.ok(!lines.some((line) => /^\s*(branches|branches-ignore|paths|paths-ignore):/.test(line)), 'no branch or path filter anywhere');
});

test('the token is read-only at the top level and no job widens it', () => {
  assert.deepEqual(block(lines, 'permissions:').filter((line) => line.trim() !== '').map((line) => line.trim()), ['contents: read']);
  assert.ok(!lines.some((line) => /^\s+permissions:/.test(line)), 'no job-level permissions');
});

test('the jobs are test, gate, identity and ci, each skipped outside the public repository', () => {
  assert.deepEqual(jobNames, ['test', 'gate', 'identity', 'ci']);
  for (const name of ['test', 'gate', 'identity']) assert.ok(has(job(name), REPO_IF), `${name} has the repository condition`);
  assert.ok(has(job('ci'), "if: always() && github.repository == 'Montinou/triqual'"), 'ci runs always, in the public repository only');
  for (const name of jobNames) assert.equal(job(name).filter((line) => /^ {4}if:/.test(line)).length, 1, `${name} has one job-level if`);
});

test('test runs npm test on Node 22 and 24', () => {
  const body = job('test');
  assert.ok(has(body, 'node: [22, 24]'), 'matrix node: [22, 24]');
  assert.ok(has(body, 'node-version: ${{ matrix.node }}'), 'setup-node takes the matrix version');
  assert.ok(body.some((line) => /uses: actions\/setup-node@v\d+/.test(line)));
  assert.ok(runLines(body).includes('npm test'), 'runs npm test');
});

test('every checkout takes the full history', () => {
  for (const name of ['test', 'gate', 'identity']) {
    const body = job(name);
    const at = body.findIndex((line) => /uses: actions\/checkout@v\d+/.test(line));
    assert.notEqual(at, -1, `${name} checks out`);
    assert.ok(body.slice(at, at + 4).some((line) => line.trim() === 'fetch-depth: 0'), `${name} checkout has fetch-depth: 0`);
  }
});

test('gate checks the files changed from the merge base, without the deny list', () => {
  const body = job('gate');
  assert.ok(has(body, 'BASE_SHA: ${{ github.event.pull_request.base.sha }}'));
  assert.ok(has(body, 'HEAD_SHA: ${{ github.event.pull_request.head.sha }}'));
  assert.deepEqual(runLines(body), ['node bin/lib/content-gate.mjs --range "$BASE_SHA...$HEAD_SHA" --no-terms']);
});

test('identity checks the commits of the pull request, strictly for the maintainer account', () => {
  const body = job('identity');
  assert.ok(has(body, 'BASE_SHA: ${{ github.event.pull_request.base.sha }}'));
  assert.ok(has(body, 'HEAD_SHA: ${{ github.event.pull_request.head.sha }}'));
  const runs = runLines(body);
  assert.deepEqual(runs.filter((line) => line.includes('identity.mjs')), [
    'node bin/lib/identity.mjs --range "$BASE_SHA..$HEAD_SHA" --strict',
    'node bin/lib/identity.mjs --range "$BASE_SHA..$HEAD_SHA"',
  ]);
  const strictAt = body.findIndex((line) => line.includes('--strict'));
  const plainAt = body.findIndex((line) => line.includes('identity.mjs') && !line.includes('--strict'));
  const conditionOf = (at) => body.slice(Math.max(0, at - 4), at).reverse().find((line) => line.trim().startsWith('if:'))?.trim();
  assert.equal(conditionOf(strictAt), "if: github.event.pull_request.user.login == 'Montinou'");
  assert.equal(conditionOf(plainAt), "if: github.event.pull_request.user.login != 'Montinou'");
});

test('no expression is interpolated into a run script: shas and results go through env', () => {
  for (const name of ['test', 'gate', 'identity', 'ci']) {
    for (const line of runLines(job(name))) assert.ok(!line.includes('${{'), `${name} run line interpolates an expression: ${line}`);
  }
});

test('ci needs test, gate and identity and fails unless all three succeeded', () => {
  const body = job('ci');
  assert.ok(has(body, 'needs: [test, gate, identity]'));
  for (const name of ['test', 'gate', 'identity']) assert.ok(body.some((line) => line.includes('${{ needs.' + name + '.result }}')), `${name} result is read`);
  const runs = runLines(body).join('\n');
  for (const name of ['test', 'gate', 'identity']) assert.ok(runs.includes(`"$${name.toUpperCase()}_RESULT" = success`), `${name} result is compared with success`);
  assert.ok(/\bexit 1\b/.test(runs), 'a result other than success fails the job');
});

test('public-export.json exports .github/ and keeps the target-owned copy', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'public-export.json'), 'utf8'));
  assert.ok(manifest.include.includes('.github/'));
  assert.ok(manifest.keepInTarget.includes('.github/'));
});
