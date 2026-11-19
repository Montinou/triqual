#!/bin/sh
set -e
cat > spec.md <<'SPEC'
# Report rendering — design

One deliverable: `src/report.mjs` gains `renderTable(rows)` and `renderSummary(rows)`; both use the private helper `padColumns` in the same file; tests in `test/report.test.mjs`. The test runner is `node --test`. Branch prefix: `report`.
SPEC
