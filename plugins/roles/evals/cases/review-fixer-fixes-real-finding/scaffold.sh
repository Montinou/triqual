#!/bin/sh
set -e
git init -q .
git config user.email t@example.invalid
git config user.name T
cat > package.json <<'JSON'
{ "name": "price-demo", "type": "module" }
JSON
cat > price.mjs <<'JS'
export function total(items) { return items.reduce((sum, item) => sum + item.price, 0); }
JS
cat > price.test.mjs <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from './price.mjs';

test('total sums the prices', () => {
  assert.equal(total([{ price: 2 }, { price: 3 }]), 5);
});
JS
cat > brief.md <<'MD'
Task 2: `total(items)` returns the sum of `price` times `quantity`, `quantity` defaulting to 1.
MD
cat > report.md <<'MD'
# Report

DONE
MD
cat > findings.md <<'MD'
F1 (Important) `price.mjs:1`: `total` ignores `quantity`: `total([{ price: 2, quantity: 3 }])` returns 2, expected 6.
MD
git add -A
git commit -q -m init
