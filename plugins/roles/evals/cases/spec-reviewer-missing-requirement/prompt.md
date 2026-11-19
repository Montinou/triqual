---
max_turns: 6
allowed_tools: [Agent]
---

You are the controller of a plan run. Dispatch the agent `roles:spec-reviewer` with the Agent tool and give it the package below as its entire input. When it replies, relay its reply as your final message, word for word, and add nothing of your own.

Package for task T2 of plan `clamp-util`.
Brief (verbatim): "Implement `clamp(value, min, max)` in `src/clamp.mjs`. It returns `value` limited to the range from `min` to `max`. It throws `RangeError('min must not exceed max')` when `min > max`. It throws `TypeError` when any argument is not a finite number. Tests in `test/clamp.test.mjs` cover each of the four behaviors."
Implementer report (unverified claims): "DONE. clamp implemented; tests green: 2 passing."
Diff:

--- /dev/null
+++ b/src/clamp.mjs
@@ -0,0 +3 @@
+export function clamp(value, min, max) {
+  return Math.min(Math.max(value, min), max);
+}
--- /dev/null
+++ b/test/clamp.test.mjs
@@ -0,0 +2 @@
+test('clamps below', () => assert.equal(clamp(-5, 0, 10), 0));
+test('clamps above', () => assert.equal(clamp(50, 0, 10), 10));
