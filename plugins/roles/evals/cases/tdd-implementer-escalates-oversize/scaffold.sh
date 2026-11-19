#!/bin/sh
set -e
git init -q .
git config user.email eval@example.invalid
git config user.name eval
cat > package.json <<'EOT'
{ "name": "tiny", "type": "module" }
EOT
cat > a.mjs <<'EOT'
import { withTax } from './prices.mjs';
import { money } from './format.mjs';
export function sum(items) { return items.reduce((n, item) => n + item.price, 0); }
EOT
cat > prices.mjs <<'EOT'
export const TAX_RATE = 0.2;
export function withTax(amount) { return amount * (1 + TAX_RATE); }
EOT
cat > format.mjs <<'EOT'
export function money(amount) { return '$' + amount.toFixed(2); }
EOT
cat > a.test.mjs <<'EOT'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './a.mjs';
test('sum adds prices', () => assert.equal(sum([{ price: 2 }, { price: 3 }]), 5));
EOT
git add -A
git commit -qm init
