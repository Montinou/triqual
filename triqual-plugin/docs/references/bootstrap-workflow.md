# Bootstrap Workflow

How to set up a new test project with Triqual.

## Quick Start

1. **Initialize Triqual**
   ```bash
   /triqual-init
   ```
   This analyzes your project and generates configuration.

2. **Review generated config**
   - `triqual.config.json` - Main settings
   - `context/project.json` - Project metadata
   - `context/patterns.json` - Test patterns & conventions
   - `context/selectors.json` - Locator strategies

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/triqual-init` | Initialize project configuration |
| `/quick-test` | Ad-hoc browser testing |
| `/test-ticket ENG-123` | Generate tests from Linear tickets |
| `/generate-test` | Create production test files |
| `/check-rules` | Lint tests for best practice violations |
| `/playwright-rules` | View Playwright best practices (31 rules) |
| `/triqual-help` | Get help and troubleshooting |

## Project Structure

Recommended test directory structure:

```
tests/
├── pages/           # Page Objects
│   ├── LoginPage.ts
│   └── DashboardPage.ts
├── helpers/         # Utilities
│   └── auth.ts
├── fixtures/        # Test fixtures
│   └── users.json
└── specs/           # Test files
    ├── auth.spec.ts
    └── dashboard.spec.ts
```

## First Test

Create your first test file:

```typescript
// tests/specs/smoke.spec.ts
import { test, expect } from '@playwright/test';

test('homepage loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/My App/);
});
```

## Running Tests

```bash
# Run all tests
npx playwright test

# Run with visible browser
npx playwright test --headed

# Run specific file
npx playwright test smoke.spec.ts

# Debug mode
npx playwright test --debug
```

## Ad-hoc Testing with /quick-test

For quick testing without writing files:

```bash
/quick-test
```

Just describe what you want to test, and Triqual will execute it with a visible browser.

## Checking Test Quality

Lint your tests against 31 Playwright best practices:

```bash
/check-rules
```

This scans your test files for violations across 8 categories:
- Locators & selectors
- Waits & timing
- Assertions
- Page Objects
- Test organization
- Network mocking
- Parallelization
- Debugging
