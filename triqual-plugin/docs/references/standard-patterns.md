# Standard Patterns for Automation Projects

This document defines what Claude Code considers "normal" for test automation projects. Understanding these patterns enables autonomous exploration - Claude can navigate standard structures without asking questions.

## Purpose

When Claude Code encounters a pattern listed here, it should:
- Understand what it is without asking
- Know how to use it appropriately
- Proceed autonomously

When Claude Code encounters something NOT matching these patterns, it should:
- Recognize it as non-standard
- Consider asking for clarification
- Proceed cautiously with explicit reasoning

---

## Directory Structures

### Standard Playwright Project Structure

```
project-root/
├── automation/                    # Or: tests/, e2e/, playwright/
│   └── playwright/
│       ├── tests/                 # Test files (*.spec.ts)
│       │   ├── feature-a/
│       │   ├── feature-b/
│       │   └── smoke/
│       ├── page-objects/          # Or: pages/, pom/
│       │   ├── login.page.ts
│       │   ├── dashboard.page.ts
│       │   └── base.page.ts
│       ├── fixtures/              # Test fixtures and data
│       │   ├── users.ts
│       │   └── test-data.ts
│       ├── factories/             # Data factories for dynamic test data
│       │   ├── user.factory.ts
│       │   └── case.factory.ts
│       ├── utils/                 # Or: helpers/, lib/, support/
│       │   ├── auth.ts
│       │   ├── api-helpers.ts
│       │   └── wait-helpers.ts
│       ├── config/                # Environment and test configuration
│       │   ├── environments.ts
│       │   └── timeouts.ts
│       ├── auth/                  # Stored authentication state
│       │   ├── buyer.json
│       │   └── seller.json
│       └── reporters/             # Custom test reporters
├── playwright.config.ts           # Main Playwright configuration
└── package.json
```

### Recognized Variations

**Test directory names:**
- `tests/`, `test/`, `specs/`, `e2e/`, `automation/`, `playwright/`

**Page Object directory names:**
- `page-objects/`, `pages/`, `pom/`, `page-models/`

**Utility directory names:**
- `utils/`, `helpers/`, `lib/`, `support/`, `common/`

**Fixture directory names:**
- `fixtures/`, `data/`, `test-data/`, `factories/`

---

## File Naming Conventions

### Test Files

| Pattern | Example | Purpose |
|---------|---------|---------|
| `*.spec.ts` | `login.spec.ts` | Standard Playwright test file |
| `*.test.ts` | `login.test.ts` | Alternative test file pattern |
| `*.e2e.ts` | `login.e2e.ts` | End-to-end specific tests |
| `*.e2e-spec.ts` | `login.e2e-spec.ts` | Combined pattern |

### Page Objects

| Pattern | Example | Purpose |
|---------|---------|---------|
| `*.page.ts` | `login.page.ts` | Page Object class |
| `*Page.ts` | `LoginPage.ts` | Alternative naming |
| `*.po.ts` | `login.po.ts` | Page Object shorthand |

### Utilities and Helpers

| Pattern | Example | Purpose |
|---------|---------|---------|
| `*.helper.ts` | `auth.helper.ts` | Helper functions |
| `*.utils.ts` | `date.utils.ts` | Utility functions |
| `*.service.ts` | `api.service.ts` | Service layer |

### Factories

| Pattern | Example | Purpose |
|---------|---------|---------|
| `*.factory.ts` | `user.factory.ts` | Data factory |
| `*Factory.ts` | `UserFactory.ts` | Alternative naming |

---

## Page Object Patterns

### Standard Page Object Structure

```typescript
// login.page.ts
import { Page, Locator } from '@playwright/test';

export class LoginPage {
  // Page reference
  readonly page: Page;

  // Locators as class properties
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByLabel('Password');
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
    this.errorMessage = page.locator('[data-testid="error-message"]');
  }

  // Navigation method
  async goto() {
    await this.page.goto('/login');
  }

  // Action methods
  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  // State check methods
  async getErrorText(): Promise<string> {
    return await this.errorMessage.textContent() || '';
  }
}
```

### Base Page Pattern

```typescript
// base.page.ts
import { Page } from '@playwright/test';

export class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // Common navigation
  async waitForPageLoad() {
    await this.page.waitForLoadState('domcontentloaded');
  }

  // Common utilities
  async takeScreenshot(name: string) {
    await this.page.screenshot({ path: `screenshots/${name}.png` });
  }
}
```

---

## Test Structure Patterns

### Standard Test File Structure

```typescript
// feature.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../page-objects/login.page';
import { DashboardPage } from '../page-objects/dashboard.page';

test.describe('Feature Name', () => {
  let loginPage: LoginPage;
  let dashboardPage: DashboardPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    dashboardPage = new DashboardPage(page);
  });

  test('should do expected behavior', async ({ page }) => {
    // Arrange
    await loginPage.goto();

    // Act
    await loginPage.login('user@example.com', 'password');

    // Assert
    await expect(dashboardPage.welcomeMessage).toBeVisible();
  });
});
```

### Authenticated Test Pattern

```typescript
// Using stored auth state
test.describe('Authenticated feature', () => {
  test.use({ storageState: '.auth/user.json' });

  test('should access protected page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
```

### Data-Driven Test Pattern

```typescript
const testCases = [
  { input: 'valid@email.com', expected: 'success' },
  { input: 'invalid-email', expected: 'error' },
  { input: '', expected: 'required' },
];

for (const { input, expected } of testCases) {
  test(`email validation: ${input} -> ${expected}`, async ({ page }) => {
    // Test implementation
  });
}
```

---

## Authentication Patterns

### Global Setup Authentication

```typescript
// global-setup.ts
import { chromium, FullConfig } from '@playwright/test';

async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Perform login
  await page.goto('/login');
  await page.fill('[name="email"]', process.env.TEST_USER_EMAIL!);
  await page.fill('[name="password"]', process.env.TEST_USER_PASSWORD!);
  await page.click('button[type="submit"]');

  // Save storage state
  await page.context().storageState({ path: '.auth/user.json' });
  await browser.close();
}

export default globalSetup;
```

### Per-Role Authentication

```typescript
// Separate auth state per role
const roles = ['buyer', 'seller', 'admin'];

for (const role of roles) {
  // Create auth state for each role
  // Save to .auth/{role}.json
}

// In tests:
test.describe('Buyer tests', () => {
  test.use({ storageState: '.auth/buyer.json' });
  // ...
});

test.describe('Admin tests', () => {
  test.use({ storageState: '.auth/admin.json' });
  // ...
});
```

### Credentials Location Patterns

**Common locations for test credentials:**

```
# Environment files
.env
.env.test
.env.local

# Fixture files
fixtures/users.ts
fixtures/credentials.ts
fixtures/test-accounts.json

# Config files
config/test-users.ts
playwright.config.ts (in use.httpCredentials or custom config)

# CI/CD
GitHub Secrets
Environment variables in CI config
```

---

## Helper and Utility Patterns

### Wait Helpers

```typescript
// wait-helpers.ts
export async function waitForNetworkIdle(page: Page, timeout = 5000) {
  await page.waitForLoadState('networkidle', { timeout });
}

export async function waitForElement(page: Page, selector: string, options = {}) {
  await page.waitForSelector(selector, { state: 'visible', ...options });
}
```

### API Helpers

```typescript
// api-helpers.ts
export async function createTestUser(request: APIRequestContext) {
  const response = await request.post('/api/users', {
    data: { email: `test-${Date.now()}@example.com` }
  });
  return response.json();
}

export async function deleteTestData(request: APIRequestContext, id: string) {
  await request.delete(`/api/data/${id}`);
}
```

### Timeout Management

```typescript
// timeout-manager.ts
const timeouts = {
  short: 5000,
  medium: 15000,
  long: 30000,
  animation: 300,
  networkIdle: 10000,
} as const;

export function getTimeout(type: keyof typeof timeouts): number {
  return timeouts[type];
}
```

---

## Configuration Patterns

### Playwright Config Structure

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './automation/playwright/tests',
  outputDir: './test-results',

  timeout: 60000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,

  reporter: [
    ['html'],
    ['list'],
    ['json', { outputFile: 'results.json' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
});
```

### Environment Configuration

```typescript
// config/environments.ts
export const environments = {
  local: {
    baseUrl: 'http://localhost:3000',
    apiUrl: 'http://localhost:8080',
  },
  staging: {
    baseUrl: 'https://staging.example.com',
    apiUrl: 'https://api-staging.example.com',
  },
  production: {
    baseUrl: 'https://example.com',
    apiUrl: 'https://api.example.com',
  },
};

export function getEnvironment() {
  const env = process.env.TEST_ENV || 'staging';
  return environments[env as keyof typeof environments];
}
```

---

## When to Recognize Non-Standard Patterns

Claude Code should note and potentially ask about:

1. **Unusual directory structures** - Tests not in any recognized location
2. **Mixed naming conventions** - Inconsistent file naming within same project
3. **Custom abstractions** - Non-standard test utilities or frameworks
4. **Missing Page Objects** - Direct locator usage in tests (might be intentional or technical debt)
5. **Hardcoded values** - Credentials, URLs, or timeouts hardcoded in tests
6. **No authentication pattern** - Tests without auth setup in authenticated app
7. **Unusual dependencies** - Third-party testing tools beyond Playwright

When encountering these, Claude Code should:
1. Note the deviation
2. Try to understand the reason (read nearby code, comments)
3. Ask if the reason is unclear
4. Follow the project's pattern even if non-standard
