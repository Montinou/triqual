---
name: check
description: "Scan test files for Playwright best practice violations. Use when user says check my tests, lint tests, validate tests, or audit test code."
---

# /check - Playwright Best Practice Linting

Scan your test files for violations of the 31 Playwright best practice rules and get actionable fix suggestions.

## When to Use

- Before committing new tests
- During code review
- After generating tests with `/test` or `/test --ticket`
- When experiencing flaky tests
- As part of test maintenance

## Quick Start

```bash
/check                           # Check all test files in project
/check ./tests/auth              # Check specific directory
/check --severity=error          # Only show errors (not warnings)
/check --fix                     # Show and offer to apply auto-fixes
```

## Rule Categories

The checker scans for violations across 8 categories:

| Category | Rules | Focus |
|----------|-------|-------|
| **Selectors** | 3 | data-testid, no XPath, role-based |
| **Locators** | 3 | visibility, .first(), chaining |
| **Waiting** | 4 | no hardcoded timeouts, auto-waiting |
| **Assertions** | 4 | web-first, specific, soft assertions |
| **Test Structure** | 5 | isolation, hooks, fixtures, naming |
| **Page Objects** | 4 | locators, actions, composition |
| **Parallelization** | 4 | worker isolation, shared state |
| **Networking** | 4 | mocking, route handlers, waiting |

## Workflow

### Step 1: Find Test Files

Locate all test files to scan:

```bash
# Default: find all .spec.ts and .test.ts files
find . -name "*.spec.ts" -o -name "*.test.ts" | grep -v node_modules
```

Or use provided path argument.

### Step 2: Scan for Violations

For each test file, check for these common violations:

#### ERROR Level (Must Fix)

| Rule | Pattern to Detect | Why It's Bad |
|------|-------------------|--------------|
| `wait-no-timeout` | `waitForTimeout(` or `page.waitFor(\d+)` | Hardcoded waits cause flakiness |
| `selector-no-xpath` | `xpath=` or `//` in locators | XPath is brittle |
| `locator-visibility` | `.nth(0)` without `:visible` | Hidden elements shift indices |
| `assert-web-first` | `expect(await page.` followed by `).toBe(` | Should use web-first assertions |
| `test-isolation` | Shared mutable state between tests | Tests must be independent |

#### WARN Level (Should Fix)

| Rule | Pattern to Detect | Why It's Risky |
|------|-------------------|----------------|
| `selector-testid` | CSS selectors without data-testid | May break on styling changes |
| `assert-timeout` | Assertions without timeout option | May timeout inconsistently |
| `locator-first` | Multiple `.first()` calls chained | Usually indicates bad selector |
| `page-object-no-assertions` | `expect()` inside Page Object class | Assertions belong in tests |

#### INFO Level (Consider Fixing)

| Rule | Pattern to Detect | Suggestion |
|------|-------------------|------------|
| `test-naming` | Test name doesn't start with "should" | Improve readability |
| `debug-trace` | No trace configuration | Add for debugging |

### Step 3: Generate Report

For each violation found:

```markdown
## Violations Report

### Summary

| Severity | Count |
|----------|-------|
| ERROR | 3 |
| WARN | 7 |
| INFO | 2 |
| **Total** | **12** |

---

### ERROR: wait-no-timeout

**File**: `tests/login.spec.ts:45`
**Rule**: Never use hardcoded waitForTimeout

```typescript
// Current (line 45):
await page.waitForTimeout(3000);

// Suggested fix:
await page.waitForSelector('.modal:visible');
// or
await expect(page.locator('.modal')).toBeVisible();
```

---

### WARN: selector-testid

**File**: `tests/checkout.spec.ts:23`
**Rule**: Prefer data-testid over CSS selectors

```typescript
// Current (line 23):
await page.locator('.btn-primary.submit').click();

// Suggested fix:
await page.locator('[data-testid="checkout-submit"]').click();
```

---
```

### Step 4: Offer Fixes (if --fix)

For auto-fixable violations:

```markdown
## Auto-Fixable Violations

Found 5 violations that can be auto-fixed:

1. `tests/login.spec.ts:45` - Add :visible to selector
2. `tests/login.spec.ts:52` - Replace waitForTimeout with waitForSelector
3. `tests/checkout.spec.ts:23` - [Manual] Add data-testid (requires code change)
4. `tests/dashboard.spec.ts:18` - Add timeout to assertion
5. `tests/dashboard.spec.ts:31` - Add timeout to assertion

**Apply auto-fixes for items 1, 2, 4, 5? (y/n)**
```

## Detection Patterns

### Pattern: Hardcoded Timeout (ERROR)

```typescript
// Detects:
page.waitForTimeout(1000)
await page.waitFor(5000)
{ timeout: 30000 }  // without getTimeout()

// Fix:
// Replace with waitForSelector, waitForLoadState, or assertion
await page.waitForLoadState('networkidle');
await expect(element).toBeVisible({ timeout: getTimeout() });
```

### Pattern: XPath Selector (ERROR)

```typescript
// Detects:
page.locator('xpath=//div[@class="content"]')
page.locator('//button[contains(text(), "Submit")]')

// Fix:
page.locator('[data-testid="content"]')
page.getByRole('button', { name: 'Submit' })
```

### Pattern: nth() Without Visibility (ERROR)

```typescript
// Detects:
page.locator('.item').nth(0)
locator.nth(2).click()

// Fix:
page.locator('.item:visible').first()
locator.filter({ hasText: 'specific' }).first()
```

### Pattern: Non-Web-First Assertion (ERROR)

```typescript
// Detects:
const text = await element.textContent();
expect(text).toBe('Hello');

// Fix:
await expect(element).toHaveText('Hello');
```

### Pattern: Missing data-testid (WARN)

```typescript
// Detects:
page.locator('.submit-button')
page.locator('button.primary')

// Suggest:
// Add data-testid="submit-button" to HTML
// Then use: page.locator('[data-testid="submit-button"]')
```

### Pattern: Assertion Without Timeout (WARN)

```typescript
// Detects:
await expect(element).toBeVisible();

// Suggest:
await expect(element).toBeVisible({ timeout: getTimeout() });
```

## Integration with Other Tools

### After /check

If violations found:
1. Use **Edit** tool to apply simple fixes
2. For complex fixes, explain what needs to change
3. Re-run `/check` to verify fixes

### With Test-Healer

If tests are failing due to rule violations:
```
/check --severity=error  # Find violations
# Apply fixes
npx playwright test            # Re-run tests
```

### With Quoth

Search for pattern documentation:
```
mcp__quoth__quoth_search_index({ query: "wait-no-timeout pattern" })
```

## What This Skill Does NOT Do

- Run tests (use `npx playwright test`)
- Generate new tests (use `/test`)
- Fetch tickets (use `/test --ticket`)
- Heal failing tests (use test-healer agent)

This skill is for **static analysis and linting** only.

## Example Output

```markdown
## Playwright Best Practices Audit

**Scanned**: 15 test files
**Total Tests**: 47

### Results

| Severity | Count | Status |
|----------|-------|--------|
| ERROR | 0 | ✅ |
| WARN | 3 | ⚠️ |
| INFO | 5 | ℹ️ |

### Warnings (3)

1. **tests/auth/login.spec.ts:34** - `selector-testid`
   Using `.submit-btn` - consider adding data-testid

2. **tests/checkout/payment.spec.ts:67** - `assert-timeout`
   Assertion missing explicit timeout

3. **tests/checkout/payment.spec.ts:72** - `assert-timeout`
   Assertion missing explicit timeout

### Info (5)

1-5. Test naming suggestions (use "should ..." format)

---

**Overall**: Good! No critical violations found.
Consider addressing the 3 warnings when convenient.
```

## Troubleshooting

### "No test files found"

Check:
1. Are you in the correct directory?
2. Do files end with `.spec.ts` or `.test.ts`?
3. Is the path argument correct?

### "Too many violations"

Start with:
```bash
/check --severity=error  # Fix critical issues first
```

### "False positive detected"

Some patterns may have valid uses. Use judgment and:
1. Add inline comments explaining the exception
2. Focus on ERROR level violations first
