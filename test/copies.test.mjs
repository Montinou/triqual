// Plugins never import each other's code at runtime: shared code lives in one plugin and the others carry a
// byte-identical copy. Each pair below is pinned here, so an edit to one side fails until the other matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = join(ROOT, 'plugins');

// [source, copy], both relative to plugins/.
const COPIES = [
  ['progress-tracking/lib/plan.mjs', 'methodology/skills/subagent-driven-development/scripts/lib/plan.mjs'],
];

test('plan.mjs copies are byte-identical', () => {
  for (const [source, copy] of COPIES) {
    const original = readFileSync(join(PLUGINS, source));
    const copied = readFileSync(join(PLUGINS, copy));
    assert.ok(original.equals(copied), `plugins/${copy} differs from plugins/${source}: copy it again byte for byte`);
  }
});
