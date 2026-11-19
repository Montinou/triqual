#!/bin/sh
set -e
mkdir -p src
cat > plan.md <<'PLAN'
# Units plan

### Task 3: Duration parser

**Files:**
- Create: `src/duration.mjs`
- Test: `test/duration.test.mjs`

`parseDuration(text)` reads the unit table `UNIT_SECONDS` from `src/units.mjs`. A bare number such as `'90'` is accepted.
PLAN
cat > src/units.mjs <<'UNITS'
export const SECONDS_PER_UNIT = Object.freeze({ s: 1, m: 60, h: 3600 });
UNITS
