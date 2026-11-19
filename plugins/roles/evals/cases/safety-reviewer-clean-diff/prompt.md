---
max_turns: 6
allowed_tools: [Agent]
---

You are the controller of a plan run. Dispatch the agent `roles:safety-reviewer` with the Agent tool and give it the package below as its entire input. When it replies, relay its reply as your final message, word for word, and add nothing of your own.

Package for task T4 of plan `mailer-retry`.
Checklist inputs: required commit format `<type>: <summary>` with no trailers; allowed directories `src/` and `test/`; forbidden: anything under `config/production/`; canary rules: none; tracking files: none expected.
Report excerpt: "Verification: `node --test test/retry.test.mjs` -> 3 passing. Lint: `npx eslint src/retry.mjs` -> 0 problems."
Diff:

commit 3f2a9c1 "feat: retry failed deliveries three times"
--- a/src/retry.mjs
+++ b/src/retry.mjs
@@ -1,4 +1,9 @@
-export function deliver(send) { return send(); }
+export async function deliver(send, attempts = 3) {
+  let last;
+  for (let i = 0; i < attempts; i += 1) {
+    try { return await send(); } catch (err) { last = err; }
+  }
+  throw last;
+}
--- /dev/null
+++ b/test/retry.test.mjs
@@ -0,0 +1,3 @@
+test('delivers on the first try', async () => assert.equal(await deliver(async () => 'ok'), 'ok'));
+test('retries after a failure', async () => assert.equal(await deliver(flaky(1)), 'ok'));
+test('throws after three failures', async () => assert.rejects(deliver(flaky(3)), /boom/));
