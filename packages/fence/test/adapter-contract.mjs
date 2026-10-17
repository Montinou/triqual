// The shared adapter contract suite. `runAdapterContract(adapter, fixtures)` checks that an
// adapter keeps the promises the engine relies on, whatever the host:
//
//   - the interface: a name, a non-empty list of event names, a parse function
//   - parse never throws, even on payloads that are not objects, and answers such payloads with
//     an opaque call (fail closed), with and without a ctx
//   - every call is a canonical call (assertCanonicalCall) of this adapter's host, with an event
//     the adapter lists (or "unknown"), and an opaque reason that is a non-empty string
//   - parse does not mutate its payload, is deterministic and keeps UNKNOWN as the one sentinel
//   - each fixture's `expect` holds (a partial match: every key given must be deep-equal)
//
// fixtures: {ctx?, payloads: [{name, payload, expect?}]}. Throws an AssertionError at the first
// broken promise; returns the number of checks made (so a suite that checked nothing shows).

import assert from 'node:assert/strict';

import { assertCanonicalCall } from '../src/hosts/types.mjs';

const HOSTILE = [null, undefined, 42, 'text', [], {}, { tool_name: 5, tool: 5 }, { cwd: '/work' }];

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// A frozen deep copy: a parse that writes to its payload throws instead of passing silently.
const frozenCopy = (payload) => deepFreeze(structuredClone(payload));

export function runAdapterContract(adapter, fixtures) {
  let checks = 0;
  const check = (fn, message) => {
    checks += 1;
    try {
      fn();
    } catch (err) {
      err.message = `adapter contract (${adapter?.name}): ${message}: ${err.message}`;
      throw err;
    }
  };

  check(() => {
    assert.equal(typeof adapter?.name, 'string');
    assert.notEqual(adapter.name, '');
  }, 'name');
  check(() => {
    assert.ok(Array.isArray(adapter.events) && adapter.events.length > 0, 'events is a non-empty array');
    for (const e of adapter.events) assert.ok(typeof e === 'string' && e !== '', 'an event is a non-empty string');
  }, 'events');
  check(() => assert.equal(typeof adapter.parse, 'function'), 'parse');
  assert.ok(Array.isArray(fixtures?.payloads) && fixtures.payloads.length > 0, 'the contract needs fixture payloads');

  const ctx = fixtures.ctx;
  const parseSafely = (payload, withCtx, label) => {
    let call;
    check(() => {
      call = adapter.parse(frozenCopy(payload), withCtx);
    }, `${label} must not throw, and must not write to its payload`);
    return call;
  };

  const canonical = (call, label) =>
    check(() => {
      assertCanonicalCall(call);
      assert.equal(call.host, adapter.name, 'host is the adapter name');
      assert.ok(call.event === 'unknown' || adapter.events.includes(call.event), `event ${JSON.stringify(call.event)} is one the adapter lists`);
      if (call.opaque !== undefined) assert.notEqual(call.opaque.reason, '', 'opaque.reason is not empty');
    }, `${label} is a canonical call`);

  // Payloads that are not tool calls at all are denied, never passed.
  for (const [i, bad] of HOSTILE.entries()) {
    for (const withCtx of [ctx, undefined]) {
      const label = `hostile input #${i}`;
      const call = parseSafely(bad, withCtx, label);
      canonical(call, label);
      check(() => assert.notEqual(call.opaque, undefined, 'a payload that is not a tool call is opaque'), label);
    }
  }

  for (const fx of fixtures.payloads) {
    const label = `fixture ${JSON.stringify(fx.name)}`;
    const call = parseSafely(fx.payload, ctx, label);
    canonical(call, label);
    const again = parseSafely(fx.payload, ctx, label);
    check(() => assert.deepEqual(again, call), `${label} parses the same way twice`);
    for (const [key, want] of Object.entries(fx.expect ?? {})) {
      check(() => assert.deepEqual(call[key], want), `${label} expects ${key}`);
    }
    const before = JSON.stringify(fx.payload);
    adapter.parse(fx.payload, ctx);
    check(() => assert.equal(JSON.stringify(fx.payload), before), `${label} leaves the original payload as it was`);
  }
  return checks;
}
