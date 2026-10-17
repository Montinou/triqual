import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SECRET_PATTERNS as FENCE_PATTERNS } from '../src/log/redact.mjs';
import { SECRET_PATTERNS as MEMORY_REPORT_PATTERNS } from '../../../plugins/memory-report/lib/policy.mjs';

// Test-only import: fence's runtime does not import triqual, so the copy in src/log/redact.mjs must not drift.
test("the copy equals memory-report's SECRET_PATTERNS source strings", () => {
  assert.equal(FENCE_PATTERNS.length, MEMORY_REPORT_PATTERNS.length);
  assert.deepEqual(
    FENCE_PATTERNS.map((p) => ({ source: p.source, flags: p.flags })),
    MEMORY_REPORT_PATTERNS.map((p) => ({ source: p.source, flags: p.flags })),
  );
});
