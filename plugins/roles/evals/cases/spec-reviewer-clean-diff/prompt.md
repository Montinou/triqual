---
max_turns: 6
allowed_tools: [Agent]
---

You are the controller of a plan run. Dispatch the agent `roles:spec-reviewer` with the Agent tool and give it the package below as its entire input. When it replies, relay its reply as your final message, word for word, and add nothing of your own.

Package for task T2 of plan `clamp-util`.
Brief (verbatim): "Implement `clamp(value, min, max)` in `src/clamp.mjs`. It returns `value` limited to the range from `min` to `max`. It throws `RangeError('min must not exceed max')` when `min > max`. It throws `TypeError` when any argument is not a finite number. Tests in `test/clamp.test.mjs` cover each of the four behaviors."
Implementer report (unverified claims): "DONE. tests green: 4 passing."
Diff:

--- /dev/null
+++ b/src/clamp.mjs
@@ -0,0 +1,7 @@
+export function clamp(value, min, max) {
+  if (![value, min, max].every((v) => typeof v === 'number' && Number.isFinite(v))) {
+    throw new TypeError('clamp needs finite numbers');
+  }
+  if (min > max) throw new RangeError('min must not exceed max');
+  return Math.min(Math.max(value, min), max);
+}
--- /dev/null
+++ b/test/clamp.test.mjs
@@ -0,0 +1,7 @@
+import { test } from 'node:test';
+import assert from 'node:assert/strict';
+import { clamp } from '../src/clamp.mjs';
+test('clamps below', () => assert.equal(clamp(-5, 0, 10), 0));
+test('clamps above', () => assert.equal(clamp(50, 0, 10), 10));
+test('rejects an inverted range', () => assert.throws(() => clamp(1, 5, 2), RangeError));
+test('rejects a non-finite value', () => assert.throws(() => clamp(NaN, 0, 1), TypeError));
