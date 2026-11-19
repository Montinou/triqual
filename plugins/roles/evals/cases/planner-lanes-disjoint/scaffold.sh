#!/bin/sh
set -e
cat > spec.md <<'SPEC'
# Report export — design

Two independent deliverables.

S1 CSV export: add `exportCsv(rows)` in `src/csv.mjs`, tested by `test/csv.test.mjs`.

S2 JSON export: add `exportJson(rows)` in `src/json.mjs`, tested by `test/json.test.mjs`.

Neither uses the other. The test runner is `node --test`. Branch prefix: `export`.
SPEC
