# Verification Workflow - Confirming Fixes Work

This document describes the workflow for verifying that test changes actually work.

## Overview

Verification ensures that:
1. The fix actually resolves the issue
2. The fix doesn't break other tests
3. The fix is stable (not flaky)
4. The fix follows project conventions

## Verification Levels

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VERIFICATION LEVELS                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Level 1          Level 2          Level 3          Level 4                │
│   ─────────        ─────────        ─────────        ─────────              │
│   Single Run       Stability        Regression       Full Suite             │
│                    Check            Check                                    │
│   Run the test     Run 3-5x to      Run related      Run all tests          │
│   once to see      verify not       tests to check   to ensure no           │
│   if it passes     flaky            no breaks        side effects           │
│                                                                              │
│   Quick check      Medium           Thorough         Complete               │
│   (~1 min)         (~5 min)         (~10 min)        (~varies)              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Level 1: Single Run

### Purpose
Quick check that the fix resolves the immediate issue.

### Command
```bash
npx playwright test path/to/test.spec.ts --headed
```

### With specific test
```bash
npx playwright test path/to/test.spec.ts -g "test name" --headed
```

### What to Watch
- Test completes without error
- Assertions pass
- No unexpected warnings
- Timing looks reasonable

### Pass Criteria
- Test passes
- Execution looks correct visually (if running headed)

### When Sufficient
- Simple typo fixes
- Obvious locator updates
- Adding missing imports

---

## Level 2: Stability Check

### Purpose
Verify the fix isn't introducing flakiness.

### Command
```bash
npx playwright test path/to/test.spec.ts --repeat-each=5
```

### For previously flaky tests
```bash
npx playwright test path/to/test.spec.ts --repeat-each=10
```

### What to Track
| Run | Result | Notes |
|-----|--------|-------|
| 1 | Pass/Fail | |
| 2 | Pass/Fail | |
| 3 | Pass/Fail | |
| 4 | Pass/Fail | |
| 5 | Pass/Fail | |

### Pass Criteria
- All runs pass
- Consistent timing across runs
- No intermittent failures

### When Required
- Timing-related fixes
- Locator changes that might be ambiguous
- Previously flaky tests
- Tests involving network requests

---

## Level 3: Regression Check

### Purpose
Ensure the fix doesn't break related functionality.

### Identify Related Tests

Related tests might be in:
- Same test file (same describe block)
- Same feature directory
- Tests using same Page Object
- Tests testing related flows

### Command
```bash
# Same file
npx playwright test path/to/test.spec.ts

# Same directory
npx playwright test path/to/directory/

# Tests using specific Page Object (find them first)
npx playwright test tests/feature-a/ tests/feature-b/
```

### What to Check
- All related tests still pass
- No new failures introduced
- Shared helpers/Page Objects work correctly

### Pass Criteria
- All related tests pass
- No degradation in test stability

### When Required
- Page Object changes
- Helper function changes
- Shared fixture changes
- Changes affecting multiple tests

---

## Level 4: Full Suite

### Purpose
Complete confidence that nothing is broken.

### Command
```bash
# Full local run
npx playwright test

# With parallel execution
npx playwright test --workers=4
```

### CI Equivalent
Push changes and verify CI passes.

### What to Monitor
- Total pass/fail count
- Any new failures
- Timing changes
- Memory/resource issues

### Pass Criteria
- Same or better pass rate than before
- No new failures
- No significant timing regression

### When Required
- Core utility changes
- Configuration changes
- Major refactoring
- Before merging to main branch

---

## Verification Decision Matrix

| Change Type | Min Level | Recommended |
|-------------|-----------|-------------|
| Typo fix | 1 | 1 |
| Single locator update | 1 | 2 |
| Multiple locator updates | 2 | 3 |
| Page Object method change | 2 | 3 |
| New Page Object | 2 | 3 |
| Helper function change | 3 | 4 |
| Config change | 3 | 4 |
| Timing/wait changes | 2 | 3 |
| Previously flaky test | 2 | 2 (10x) |
| New test file | 2 | 2 |

---

## Handling Verification Failures

### Single Test Fails

```
1. Check error message
2. Run headed to observe
3. Apply debug workflow
4. Retry verification
```

### Stability Check Fails (Flaky)

```
1. Identify failing runs
2. Look for timing patterns
3. Add appropriate waits
4. Increase repeat count
5. Consider test isolation
```

### Regression Check Fails

```
1. Identify which tests failed
2. Determine if related to your change
3. If related: fix or revert
4. If unrelated: investigate separately
```

### Full Suite Fails

```
1. Compare with baseline
2. Identify new failures
3. Categorize as:
   - Related to your change
   - Pre-existing flaky tests
   - Environment issues
4. Address related failures
5. Document unrelated issues
```

---

## Verification Commands Reference

### Basic Commands

```bash
# Single test file
npx playwright test tests/feature/test.spec.ts

# Single test by name
npx playwright test -g "should do something"

# Headed mode (see browser)
npx playwright test --headed

# Debug mode (step through)
npx playwright test --debug

# Specific project/browser
npx playwright test --project=chromium
```

### Repeat/Stability Commands

```bash
# Repeat each test N times
npx playwright test --repeat-each=5

# Retry failed tests
npx playwright test --retries=2

# Combination
npx playwright test --repeat-each=3 --retries=1
```

### Output/Reporting Commands

```bash
# Show detailed output
npx playwright test --reporter=list

# Generate HTML report
npx playwright test --reporter=html

# JSON output
npx playwright test --reporter=json --output=results.json
```

### Performance Commands

```bash
# Parallel workers
npx playwright test --workers=4

# Single worker (serial)
npx playwright test --workers=1

# Timeout override
npx playwright test --timeout=60000
```

---

## Verification Checklist

### Before Verification
```
□ Changes saved
□ No syntax errors
□ Imports correct
□ Know which level of verification needed
```

### During Verification
```
□ Watch test execution (at least once headed)
□ Note any warnings
□ Track pass/fail results
□ Note timing patterns
```

### After Verification
```
□ All required levels pass
□ No new failures introduced
□ Results documented if significant
□ Ready to commit/PR
```

---

## Automated Verification in CI

### GitHub Actions Example

```yaml
# .github/workflows/playwright.yml
name: Playwright Tests

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright
        run: npx playwright install --with-deps
      - name: Run tests
        run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

### Pre-commit Hook

```bash
# .husky/pre-commit
#!/bin/sh
npx playwright test --reporter=dot
```

---

## Reporting Verification Results

### To Exolar

After verification, report results:

```
query_exolar_data({
  dataset: "executions",
  branch: "current-branch"
})
```

### To Team

For significant changes, document:
- What was changed
- Verification level performed
- Results
- Any follow-up needed
