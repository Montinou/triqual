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
   - `Docs/context/project.json` - Project metadata
   - `Docs/context/patterns.json` - Test patterns

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

## Using /quick-test

For ad-hoc testing without writing files:

```bash
/quick-test
```

Just describe what you want to test, and Triqual will execute it with a visible browser.
