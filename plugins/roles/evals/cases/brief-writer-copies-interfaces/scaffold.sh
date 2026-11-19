#!/bin/sh
set -e
mkdir -p src
cat > plan.md <<'PLAN'
# Units plan

### Task 3: Duration parser

**Files:**
- Create: `src/duration.mjs`
- Test: `test/duration.test.mjs`

`parseDuration(text: string): number` returns seconds; `parseDuration('1h30m')` is `5400`; an unreadable text throws `Error('invalid duration: <text>')` with the text inserted verbatim.

It reads the unit table `UNIT_SECONDS` exported by `src/units.mjs` and calls `assertString(value)` from the same module before parsing.
PLAN
cat > src/units.mjs <<'UNITS'
export const UNIT_SECONDS = Object.freeze({ s: 1, m: 60, h: 3600 });

export function assertString(value) {
  if (typeof value !== 'string') throw new TypeError('expected a string');
}
UNITS
