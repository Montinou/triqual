---
max_turns: 6
allowed_tools: [Agent]
---
You are the controller of a plan run. Dispatch the agent `roles:final-adversarial-reviewer` with the Agent tool and give it the package below as its entire input. When it replies, relay its reply as your final message, word for word, and add nothing of your own.

Spec excerpt: "All money amounts inside the cart module are integer cents. Prices arrive from the catalog as integer cents."
Plan: T1 adds `src/money.mjs`; T2 adds `src/cart.mjs`. Deferred minors: none. Parked findings: none.
Whole-branch diff:

--- /dev/null
+++ b/src/money.mjs
+// Converts a price in dollars (a number such as 4.25) to integer cents.
+export function toCents(dollars) { return Math.round(dollars * 100); }
--- /dev/null
+++ b/src/cart.mjs
+import { toCents } from './money.mjs';
+// item.price is already integer cents (catalog contract).
+export function cartTotal(items) {
+  return items.reduce((sum, item) => sum + toCents(item.price) * item.qty, 0);
+}
--- /dev/null
+++ b/test/cart.test.mjs
+test('total of one 4.25 item', () => assert.equal(cartTotal([{ price: 4.25, qty: 1 }]), 425));
