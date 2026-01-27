---
description: Comprehensive Playwright rules and best practices for writing reliable, maintainable E2E tests. Use when writing, reviewing, or debugging Playwright tests.
---

# Playwright Rules

A comprehensive guide to Playwright best practices, patterns, and anti-patterns for writing reliable end-to-end tests.

## Quick Reference

### Locators (Most Important)

| Do | Don't |
|----|-------|
| `getByRole('button', { name: 'Submit' })` | `locator('.btn-submit')` |
| `getByTestId('user-avatar')` | `locator('#avatar-12345')` |
| `getByLabel('Email')` | `locator('input[type="email"]')` |
| `locator('.item').first()` | `locator('.item')` (when multiple) |

### Waits (Critical for Stability)

| Do | Don't |
|----|-------|
| `await expect(el).toBeVisible()` | `await page.waitForTimeout(1000)` |
| `await page.waitForURL('/dashboard')` | `await page.waitForLoadState('networkidle')` |
| `await response.finished()` | `await page.waitForTimeout(500)` |

### Assertions (Web-First Always)

| Do | Don't |
|----|-------|
| `await expect(locator).toHaveText('Hello')` | `expect(await locator.textContent()).toBe('Hello')` |
| `await expect(locator).toBeVisible()` | `expect(await locator.isVisible()).toBe(true)` |
| `await expect(page).toHaveURL('/home')` | `expect(page.url()).toBe('/home')` |

## Rule Categories

1. **[Locators](./rules/_sections.md#locators)** - Finding elements reliably
2. **[Waits & Timing](./rules/_sections.md#waits--timing)** - Handling async operations
3. **[Assertions](./rules/_sections.md#assertions)** - Verifying outcomes
4. **[Page Objects](./rules/_sections.md#page-objects)** - Organizing locators
5. **[Test Organization](./rules/_sections.md#test-organization)** - Structuring tests
6. **[Network](./rules/_sections.md#network)** - Mocking and interception
7. **[Debugging](./rules/_sections.md#debugging)** - Troubleshooting failures
8. **[Parallelization](./rules/_sections.md#parallelization)** - Running tests safely

## Usage

### In Triqual Workflows

This skill is automatically consulted when:
- Writing new `.spec.ts` files
- Debugging flaky tests
- Reviewing test code

### Manual Invocation

```
/playwright-rules
```

### In Code Reviews

Reference specific rules:
```
This violates [wait-no-timeout](./rules/wait-no-timeout.md) -
use `await expect(element).toBeVisible()` instead of `waitForTimeout`.
```

## All Rules

See [rules/_sections.md](./rules/_sections.md) for the complete index.

## Contributing

See [rules/_contributing.md](./rules/_contributing.md) for guidelines on adding new rules.
