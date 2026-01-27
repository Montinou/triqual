---
name: playwright-rules
description: Comprehensive Playwright best practices and rules. Use when writing, reviewing, or debugging Playwright tests. Covers locators, waits, assertions, Page Objects, test organization, network mocking, debugging, and parallelization.
allowed-tools: Read, Glob, Grep
---

# Playwright Rules - Best Practices Guide

Comprehensive rules and best practices for writing reliable, maintainable Playwright tests. 31 documented rules across 8 categories.

## When to Use

- Writing new Playwright test files
- Reviewing test code for anti-patterns
- Debugging flaky tests
- Learning Playwright best practices
- Code review - referencing specific rule violations

## Quick Reference

### Critical Rules (ERROR Severity)

| Rule | Category | Issue |
|------|----------|-------|
| `wait-no-timeout` | Waits | Never use `waitForTimeout()` - causes flaky tests |
| `assert-web-first` | Assertions | Use web-first assertions with auto-retry |
| `test-isolation` | Organization | Tests must be independent for parallel execution |
| `parallel-worker-isolation` | Parallel | Workers cannot share state |
| `parallel-shared-state` | Parallel | No shared mutable state between tests |
| `selector-no-xpath` | Locators | XPath is fragile and breaks easily |
| `locator-first` | Locators | Use `.first()` explicitly when multiple match |
| `network-route-handlers` | Network | Always resolve routes (continue/fulfill/abort) |
| `debug-slow-mo` | Debugging | Never leave slowMo in CI |

### Quick Patterns

**Locators (Do → Don't)**
```typescript
// ✅ getByRole('button', { name: 'Submit' })  →  ❌ locator('.btn-submit')
// ✅ getByTestId('user-avatar')               →  ❌ locator('#avatar-12345')
// ✅ getByLabel('Email')                      →  ❌ locator('input[type="email"]')
// ✅ locator('.item').first()                 →  ❌ locator('.item') when multiple
```

**Waits (Do → Don't)**
```typescript
// ✅ await expect(el).toBeVisible()           →  ❌ await page.waitForTimeout(1000)
// ✅ await page.waitForURL('/dashboard')      →  ❌ await page.waitForLoadState('networkidle')
// ✅ await response.finished()                →  ❌ await page.waitForTimeout(500)
```

**Assertions (Do → Don't)**
```typescript
// ✅ await expect(locator).toHaveText('Hi')   →  ❌ expect(await locator.textContent()).toBe('Hi')
// ✅ await expect(locator).toBeVisible()      →  ❌ expect(await locator.isVisible()).toBe(true)
// ✅ await expect(page).toHaveURL('/home')    →  ❌ expect(page.url()).toBe('/home')
```

## Rule Categories

Read the full documentation at `${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/`:

### 1. Locators (6 rules)
Finding elements reliably and maintainably.

```bash
# Read all locator rules
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/locator-*.md
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/selector-*.md
```

| Rule | Description |
|------|-------------|
| `locator-visibility` | Verify element visibility before interactions |
| `locator-first` | Use `.first()` explicitly or refine locators |
| `locator-chaining` | Chain locators to narrow scope |
| `selector-testid` | Prefer `getByTestId` over CSS selectors |
| `selector-no-xpath` | Avoid fragile XPath expressions |
| `selector-role-based` | Prefer role-based locators (`getByRole`) |

### 2. Waits & Timing (4 rules)
Handling asynchronous operations without flakiness.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/wait-*.md
```

| Rule | Description |
|------|-------------|
| `wait-no-timeout` | **CRITICAL** - No hardcoded `waitForTimeout` |
| `wait-for-state` | Prefer `waitFor` over `networkidle` |
| `wait-auto-waiting` | Leverage Playwright's auto-waiting |
| `wait-explicit-conditions` | Use explicit wait conditions |

### 3. Assertions (4 rules)
Verifying outcomes with auto-retry.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/assert-*.md
```

| Rule | Description |
|------|-------------|
| `assert-web-first` | **CRITICAL** - Use web-first assertions |
| `assert-specific` | Use specific assertion methods |
| `assert-soft` | Use soft assertions appropriately |
| `assert-timeout` | Configure assertion timeouts properly |

### 4. Page Objects (4 rules)
Organizing locators and actions.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/page-object-*.md
```

| Rule | Description |
|------|-------------|
| `page-object-locators` | Move inline locators to Page Objects |
| `page-object-actions` | Encapsulate actions in methods |
| `page-object-composition` | Compose Page Objects for complex pages |
| `page-object-no-assertions` | Keep assertions in tests, not POs |

### 5. Test Organization (5 rules)
Structuring tests for maintainability and parallel execution.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/test-*.md
```

| Rule | Description |
|------|-------------|
| `test-isolation` | **CRITICAL** - Tests must be independent |
| `test-hooks` | Use beforeEach/afterEach properly |
| `test-fixtures` | Leverage Playwright fixtures |
| `test-describe-grouping` | Group related tests with describe |
| `test-naming` | Use descriptive test names |

### 6. Network (4 rules)
Mocking and intercepting network requests.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/network-*.md
```

| Rule | Description |
|------|-------------|
| `network-mock-api` | Mock external API calls |
| `network-route-handlers` | **CRITICAL** - Always resolve routes |
| `network-wait-response` | Wait for specific responses |
| `network-abort-unnecessary` | Abort unnecessary requests |

### 7. Debugging (4 rules)
Troubleshooting and diagnosing test failures.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/debug-*.md
```

| Rule | Description |
|------|-------------|
| `debug-trace-on-failure` | Enable traces for failed tests |
| `debug-screenshots` | Capture screenshots strategically |
| `debug-video-recording` | Configure video recording |
| `debug-slow-mo` | **CRITICAL** - Never in CI |

### 8. Parallelization (4 rules)
Running tests safely in parallel.

```bash
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/parallel-*.md
```

| Rule | Description |
|------|-------------|
| `parallel-worker-isolation` | **CRITICAL** - Ensure worker isolation |
| `parallel-shared-state` | **CRITICAL** - No shared mutable state |
| `parallel-test-data` | Use unique test data per worker |
| `parallel-serial-when-needed` | Mark serial tests explicitly |

## Usage

### Review Code Against Rules

When reviewing test code, read the relevant rule files:

```typescript
// If you see this in a test:
await page.waitForTimeout(2000);

// Reference: wait-no-timeout.md (ERROR severity)
// This is the #1 cause of flaky tests!
```

### Fix Violations

Each rule file includes:
- **Summary** - One-line description
- **Rationale** - Why the rule exists
- **Best Practice** - Correct code examples
- **Anti-Pattern** - What to avoid
- **Auto-fix** - How to transform bad code to good code

### Code Review Comments

Reference rules in code reviews:

```markdown
This violates `wait-no-timeout` (ERROR) - use explicit conditions instead:
- Before: `await page.waitForTimeout(2000)`
- After: `await expect(element).toBeVisible()`
See: docs/playwright-rules/rules/wait-no-timeout.md
```

## Read Specific Rules

To read a specific rule:

```bash
# Read a specific rule
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/wait-no-timeout.md

# Read all rules in a category
cat ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/assert-*.md

# Search for patterns
grep -r "auto-fix" ${CLAUDE_PLUGIN_ROOT}/docs/playwright-rules/rules/
```

## Integration with Other Skills

- `/quick-test` - Apply rules when writing ad-hoc tests
- `/generate-test` - Use patterns when creating production tests
- `/test-ticket` - Reference rules when generating from tickets

## Severity Levels

- **ERROR** - Must fix; will cause flaky or broken tests
- **WARNING** - Should fix; may cause issues
- **INFO** - Recommended best practice

## What This Skill Does

- Provides comprehensive Playwright best practices reference
- Documents patterns and anti-patterns with code examples
- Helps diagnose why tests are flaky
- Serves as a code review checklist

## What This Skill Does NOT Do

- Auto-fix code (read rules and apply manually)
- Run tests (use `/quick-test` or `/generate-test`)
- Create Page Objects (use `/generate-test`)
