# Bootstrap Workflow - Project Scan & Documentation

This document describes how to scan a test automation project and document its patterns in Quoth.

## Purpose

The bootstrap workflow creates the foundation for effective test development by:

1. **Discovering** the project's test infrastructure
2. **Understanding** its patterns and conventions
3. **Documenting** everything in Quoth for future reference
4. **Validating** the documentation with the user

## When to Bootstrap

Run the bootstrap workflow when:

- Starting work on a new project
- Project structure has significantly changed
- Quoth documentation is missing or outdated
- Test infrastructure has been refactored

## Bootstrap Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BOOTSTRAP WORKFLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Phase 1: DISCOVER          Phase 2: ANALYZE          Phase 3: DOCUMENT    │
│   ─────────────────          ───────────────           ─────────────────    │
│                                                                              │
│   • Find test directory      • Read Page Objects       • Generate docs      │
│   • Find config files        • Read helpers            • Structure for      │
│   • Identify patterns        • Read fixtures             Quoth              │
│   • Map folder structure     • Understand auth         • Upload to Quoth    │
│                              • Note conventions        • Verify with user   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Discovery

### Step 1.1: Find Test Directory

Search for test directories in order of likelihood:

```
1. automation/playwright/
2. tests/
3. e2e/
4. playwright/
5. test/
6. specs/
```

**Glob patterns:**
```
**/playwright.config.{ts,js}
**/*.spec.{ts,js}
**/page-objects/**
**/pages/**
```

### Step 1.2: Find Configuration Files

```
# Primary Playwright config
playwright.config.ts
playwright.config.js

# TypeScript config
tsconfig.json

# Package info
package.json

# Environment files
.env
.env.test
.env.local
```

### Step 1.3: Map Folder Structure

Create a map of the test infrastructure:

```
automation/
├── playwright/
│   ├── tests/           → Test files location
│   ├── page-objects/    → Page Objects location
│   ├── fixtures/        → Test data location
│   ├── utils/           → Helpers location
│   ├── auth/            → Auth state location
│   └── config/          → Config files location
├── global-setup.ts      → Setup script
└── playwright.config.ts → Main config
```

### Step 1.4: Identify Key Files

| File Type | Purpose | Count Found |
|-----------|---------|-------------|
| Test files (*.spec.ts) | Test cases | N |
| Page Objects (*.page.ts) | UI abstractions | N |
| Helpers (utils/*.ts) | Utility functions | N |
| Fixtures | Test data | N |
| Config files | Configuration | N |

---

## Phase 2: Analysis

### Step 2.1: Analyze Page Objects

For each Page Object file:

```typescript
// Extract:
// - Class name
// - Available locators (as properties)
// - Available methods
// - Dependencies on other Page Objects

// Example output:
LoginPage:
  Locators:
    - emailInput: getByLabel('Email')
    - passwordInput: getByLabel('Password')
    - submitButton: getByRole('button', { name: 'Sign In' })
    - errorMessage: getByTestId('error-message')
  Methods:
    - goto(): Navigate to /login
    - login(email, password): Perform login
    - getErrorText(): Get error message text
  Dependencies:
    - BasePage (extends)
```

### Step 2.2: Analyze Helper Functions

For each helper/utility file:

```typescript
// Extract:
// - Function name
// - Parameters
// - Purpose
// - Usage example

// Example output:
auth.ts:
  Functions:
    - authenticateAs(role: string): Sets up auth state for role
    - clearAuthState(): Removes stored auth
    - getStorageStatePath(role): Returns path to .auth/{role}.json

timeout-manager.ts:
  Functions:
    - getTimeout(type: 'short' | 'medium' | 'long'): Returns timeout value
  Constants:
    - short: 5000ms
    - medium: 15000ms
    - long: 30000ms
```

### Step 2.3: Analyze Fixtures and Factories

```typescript
// Extract:
// - Available test users
// - Data creation functions
// - Static test data

// Example output:
fixtures/users.ts:
  Users:
    - buyer: { email: 'buyer@test.com', role: 'buyer' }
    - seller: { email: 'seller@test.com', role: 'seller' }
    - admin: { email: 'admin@test.com', role: 'admin' }

factories/case.factory.ts:
  Functions:
    - createCase(overrides): Creates a case via API
    - createCaseWithProposals(count): Creates case with N proposals
```

### Step 2.4: Analyze Authentication Pattern

```typescript
// Determine:
// - How auth is set up (global-setup vs per-test)
// - Where credentials come from
// - Where auth state is stored
// - What roles are available

// Example output:
Authentication:
  Pattern: Global setup with per-role storage
  Setup file: global-setup.ts
  Credentials source: fixtures/users.ts + .env
  Storage location: .auth/{role}.json
  Roles: buyer, seller, admin
  Usage in tests: test.use({ storageState: '.auth/buyer.json' })
```

### Step 2.5: Identify Conventions

Look for patterns in existing code:

```
Locator patterns:
  - Preferred: getByRole, getByLabel
  - Secondary: getByTestId
  - Avoided: CSS selectors

Naming conventions:
  - Test files: {feature}.spec.ts
  - Page Objects: {feature}.page.ts
  - Helpers: {purpose}.ts or {purpose}.helper.ts

Test structure:
  - Uses test.describe for grouping
  - Uses test.beforeEach for setup
  - Uses test.step for documentation
  - Follows AAA pattern (Arrange, Act, Assert)

Error handling:
  - Uses getTimeout() for timeouts
  - Uses :visible filter for resilience
  - Uses .first() for strict mode
```

---

## Phase 3: Documentation

### Step 3.1: Generate Quoth Documents

Create documentation in Quoth-friendly format:

#### Document 1: Project Overview

```markdown
---
id: project-overview
type: architecture
status: active
last_updated_date: YYYY-MM-DD
---

# Test Automation Overview

## Project Structure
[Map from Phase 1]

## Key Directories
- Tests: automation/playwright/tests/
- Page Objects: automation/playwright/page-objects/
- Helpers: automation/playwright/utils/
- Auth State: automation/playwright/auth/

## Tech Stack
- Framework: Playwright
- Language: TypeScript
- Runners: GitHub Actions CI
```

#### Document 2: Page Objects Reference

```markdown
---
id: page-objects
type: contract
status: active
last_updated_date: YYYY-MM-DD
---

# Page Objects Reference

## Available Page Objects

### LoginPage
Location: `automation/playwright/page-objects/login.page.ts`

**Locators:**
| Name | Selector | Purpose |
|------|----------|---------|
| emailInput | getByLabel('Email') | Email input field |
| passwordInput | getByLabel('Password') | Password input field |
| submitButton | getByRole('button', { name: 'Sign In' }) | Submit button |

**Methods:**
| Method | Parameters | Description |
|--------|------------|-------------|
| goto() | none | Navigate to login page |
| login(email, password) | string, string | Perform login |
| getErrorText() | none | Get error message text |

### DashboardPage
[Similar structure]
```

#### Document 3: Helper Functions

```markdown
---
id: helpers
type: contract
status: active
last_updated_date: YYYY-MM-DD
---

# Helper Functions Reference

## Authentication Helpers

### authenticateAs(role: string)
Location: `automation/playwright/utils/auth.ts`

Sets up authentication state for the specified role.

**Parameters:**
- role: 'buyer' | 'seller' | 'admin'

**Usage:**
```typescript
test.beforeEach(async () => {
  await authenticateAs('buyer');
});
```

## Timeout Management

### getTimeout(type)
Location: `automation/playwright/utils/timeout-manager.ts`

Returns appropriate timeout value.

**Parameters:**
- type: 'short' | 'medium' | 'long' | 'animation'

**Returns:**
- short: 5000ms
- medium: 15000ms
- long: 30000ms
- animation: 300ms

**Usage:**
```typescript
await page.waitForSelector('.element', { timeout: getTimeout('medium') });
```
```

#### Document 4: Test Conventions

```markdown
---
id: test-conventions
type: patterns
status: active
last_updated_date: YYYY-MM-DD
---

# Test Conventions

## File Naming
- Test files: `{feature}.spec.ts`
- Page Objects: `{feature}.page.ts`
- Helpers: `{purpose}.ts`

## Locator Priority
1. getByRole() - Preferred
2. getByLabel() - For form inputs
3. getByTestId() - When role not applicable
4. CSS selectors - Last resort

## Required Patterns
- Always use :visible filter for potentially duplicate elements
- Always use .first() when strict mode may fail
- Never use hardcoded timeouts - use getTimeout()
- Always use Page Objects - no inline locators in tests

## Anti-Patterns to Avoid
- waitForTimeout(NUMBER) - Use waitFor() or getTimeout()
- waitForLoadState('networkidle') - Use 'domcontentloaded'
- Hardcoded credentials - Use fixtures
- Inline locators in tests - Use Page Objects
```

#### Document 5: Authentication Guide

```markdown
---
id: authentication
type: patterns
status: active
last_updated_date: YYYY-MM-DD
---

# Authentication Guide

## Authentication Architecture
- Global setup authenticates all roles once
- Auth state stored in .auth/{role}.json
- Tests use storageState to restore session

## Available Roles
| Role | Email | Capabilities |
|------|-------|--------------|
| buyer | buyer@test.com | Create cases, submit proposals |
| seller | seller@test.com | View cases, respond to proposals |
| admin | admin@test.com | Full access |

## Usage in Tests

### Single Role Test
```typescript
test.describe('Buyer flow', () => {
  test.use({ storageState: '.auth/buyer.json' });

  test('can create case', async ({ page }) => {
    // Already authenticated as buyer
  });
});
```

### Multi-Role Test
```typescript
test('buyer and seller interaction', async ({ browser }) => {
  const buyerContext = await browser.newContext({
    storageState: '.auth/buyer.json'
  });
  const sellerContext = await browser.newContext({
    storageState: '.auth/seller.json'
  });

  const buyerPage = await buyerContext.newPage();
  const sellerPage = await sellerContext.newPage();

  // Interact with both
});
```

## Refreshing Auth State
If auth state becomes stale:
```bash
rm -rf .auth/
npx playwright test --project=setup
```
```

### Step 3.2: Upload to Quoth

For each document:

```
quoth_propose_update({
  document_id: "project-overview",
  content: "<markdown content>",
  evidence: "Bootstrap scan of project automation/playwright/",
  update_type: "create"  // or "update" if exists
})
```

### Step 3.3: Verify with User

Present summary to user for confirmation:

```
Bootstrap Complete! I've documented:

1. Project Overview
   - Test directory: automation/playwright/
   - 45 test files, 12 Page Objects, 8 helpers

2. Page Objects (12)
   - LoginPage, DashboardPage, CasePage...

3. Helper Functions (15)
   - Authentication, timeouts, API helpers...

4. Test Conventions
   - Locator priority, patterns, anti-patterns

5. Authentication
   - 3 roles: buyer, seller, admin
   - Global setup pattern

Should I upload these to Quoth? [Y/n]
```

---

## Incremental Updates

After initial bootstrap, update documentation when:

- New Page Objects are created
- New helper functions are added
- Patterns change
- Issues are discovered

Use `quoth_propose_update` with `update_type: "update"` for incremental changes.

---

## Bootstrap Checklist

```
□ Phase 1: Discovery
  □ Found test directory
  □ Found config files
  □ Mapped folder structure
  □ Identified key files

□ Phase 2: Analysis
  □ Analyzed all Page Objects
  □ Analyzed helper functions
  □ Analyzed fixtures/factories
  □ Understood authentication pattern
  □ Identified conventions

□ Phase 3: Documentation
  □ Generated project overview
  □ Generated Page Objects reference
  □ Generated helpers reference
  □ Generated conventions guide
  □ Generated authentication guide
  □ User verified documents
  □ Uploaded to Quoth
```
