#!/bin/sh
set -e
git init -q .
git config user.email t@example.invalid
git config user.name T
cat > package.json <<'JSON'
{ "name": "clamp-demo", "type": "module" }
JSON
cat > clamp.mjs <<'JS'
export function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
JS
cat > clamp.test.mjs <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';

test('clamp with min equal to max returns that value', () => {
  assert.equal(clamp(5, 5, 5), 5);
});
JS
cat > brief.md <<'MD'
Task 1: `clamp(v, min, max)` limits `v` to the range from `min` to `max`.
MD
cat > report.md <<'MD'
# Report

DONE
MD
cat > findings.md <<'MD'
F1 (Important) `clamp.mjs:1`: `clamp` returns the wrong value when `min` equals `max`.
MD
git add -A
git commit -q -m init
