# Bootstrap Workflow

How to set up a new test project with Triqual.

## Quick Start

1. **Initialize Triqual**
   ```bash
   /init
   ```
   This analyzes your project and generates configuration.

2. **Review generated config**
   - `triqual.config.ts` - Main TypeScript configuration
   - `context/project.json` - Project metadata
   - `context/patterns.json` - Test patterns & conventions
   - `context/selectors.json` - Locator strategies

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/init` | Initialize project configuration |
| `/test login` | Full autonomous test generation |
| `/test --explore` | Interactive browser exploration |
| `/test --ticket ENG-123` | Generate tests from Linear tickets |
| `/test --describe "..."` | Generate tests from description |
| `/check` | Lint tests for best practice violations |
| `/rules` | View Playwright best practices (31 rules) |
| `/help` | Get help and troubleshooting |

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

## Interactive Exploration with /test --explore

For quick testing without writing files:

```bash
/test --explore login
```

Just describe what you want to test, and Triqual will open a visible browser for exploration.

## Checking Test Quality

Lint your tests against 31 Playwright best practices:

```bash
/check
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
