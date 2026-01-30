---
name: test
description: "Unified Playwright test automation. Default runs full autonomous loop. Use --explore for interactive, --ticket ENG-123 for Linear tickets, --describe for text descriptions."
---

# /test - Unified Test Automation

Generate production-ready Playwright tests with multiple input modes. Default mode runs the full autonomous loop with pattern learning.

## Quick Start

```bash
/test login              # Full autonomous (default) - explore → plan → generate → heal → learn
/test --explore login    # Interactive exploration only - opens visible browser
/test --ticket ENG-123   # From Linear ticket - fetches AC, generates tests
/test --describe "..."   # From user description - skips exploration
```

## Modes Comparison

| Mode | Explore | Plan | Generate | Heal | Learn |
|------|---------|------|----------|------|-------|
| `/test login` (default) | ✅ Auto | ✅ | ✅ | ✅ 5x | ✅ |
| `/test --explore login` | ✅ Interactive | ❌ | ❌ | ❌ | ❌ |
| `/test --ticket ENG-123` | ❌ (from AC) | ✅ | ✅ | ✅ | ✅ |
| `/test --describe "..."` | ❌ (from text) | ✅ | ✅ | ✅ | ✅ |

---

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            /test {feature}                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  INPUT SOURCES:                                                              │
│  ├── Default → EXPLORE with Playwright MCP                                  │
│  ├── --ticket → Linear ticket acceptance criteria                           │
│  ├── --describe → User text description                                     │
│  └── --explore → Interactive exploration only (STOPS after explore)         │
│                                                                              │
│  PHASES:                                                                     │
│  0. SETUP → Auto-config, load patterns, discover credentials                │
│  1. EXPLORE → Playwright MCP (skip with --ticket/--describe)                │
│  1.5 QUOTH CONTEXT → quoth-context agent loads patterns (MANDATORY)        │
│  2. PLAN → Quoth context output + input source                              │
│  3. GENERATE → .spec.ts in tests/.draft/                                    │
│  4. HEAL LOOP → Run → Fix → Re-run (max 5 iterations)                       │
│  5. PROMOTE → Move to production test directory                             │
│  6. LEARN → Save patterns + anti-patterns                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: SETUP (Auto-Config & Authentication)

This phase loads configuration and handles authentication before any exploration.

### 0.1 Load Configuration

Read `triqual.config.ts` if it exists:

```bash
# Check for TypeScript config
ls triqual.config.ts 2>/dev/null
```

If TypeScript config exists, read it to extract configuration values. The config uses `defineConfig` from `triqual` for type safety:

```typescript
// triqual.config.ts
import { defineConfig } from 'triqual';

export default defineConfig({
  project_id: 'my-app',
  testDir: './tests',
  baseUrl: 'http://localhost:3000',
  auth: { strategy: 'storageState', ... },
  // ...
});
```

If missing, prompt user to run `/init` first or auto-detect basic config.

### 0.2 Load Existing Patterns

Read from `${PLUGIN_ROOT}/context/`:

- `patterns-learned.json` - Successful patterns from previous runs
- `anti-patterns-learned.json` - Known failure→fix mappings

### 0.3 Handle Authentication

Based on `auth.strategy` from config, authenticate before exploration:

#### Strategy: `storageState` (Fastest)

If `.auth/user.json` exists and is configured:

```javascript
// Load saved auth state via browser_run_code
mcp__plugin_triqual-plugin_playwright__browser_run_code({
  code: `async (page) => {
    const fs = require('fs');
    const state = JSON.parse(fs.readFileSync('.auth/user.json', 'utf8'));

    // Add cookies
    if (state.cookies?.length) {
      await page.context().addCookies(state.cookies);
    }

    // Navigate to trigger cookie application
    await page.goto('${baseUrl}');

    // Restore localStorage if present
    if (state.origins?.[0]?.localStorage?.length) {
      await page.evaluate((items) => {
        items.forEach(({ name, value }) => localStorage.setItem(name, value));
      }, state.origins[0].localStorage);
    }

    return 'Auth state loaded';
  }`
})
```

#### Strategy: `uiLogin` (When no saved state)

If credentials are configured but no storageState:

```javascript
// Navigate to login page
mcp__plugin_triqual-plugin_playwright__browser_navigate({
  url: config.auth.uiLogin.loginUrl  // e.g., "/login"
})

// Get page snapshot to find form elements
mcp__plugin_triqual-plugin_playwright__browser_snapshot({})

// Fill login form using configured selectors
mcp__plugin_triqual-plugin_playwright__browser_fill_form({
  fields: [
    {
      name: 'Email',
      type: 'textbox',
      ref: '{email-field-ref}',  // From snapshot
      value: credentials.email
    },
    {
      name: 'Password',
      type: 'textbox',
      ref: '{password-field-ref}',  // From snapshot
      value: credentials.password
    }
  ]
})

// Click submit
mcp__plugin_triqual-plugin_playwright__browser_click({
  ref: '{submit-button-ref}',
  element: 'Login submit button'
})

// Wait for navigation to success URL
mcp__plugin_triqual-plugin_playwright__browser_wait_for({
  text: 'Dashboard'  // Or wait for URL change
})
```

#### Strategy: `setupProject` (Playwright native)

If project uses Playwright's setup project pattern:

```bash
# Run setup project first
npx playwright test --project=setup
```

Then proceed with tests that have `dependencies: ['setup']`.

#### Strategy: `none` (No auth needed)

Skip authentication, proceed directly to exploration.

### 0.4 Verify Authentication

After auth, verify we're logged in:

```javascript
// Take snapshot to confirm auth state
mcp__plugin_triqual-plugin_playwright__browser_snapshot({})

// Check for logged-in indicators:
// - User avatar/menu visible
// - Dashboard or protected content visible
// - No login form visible
```

### 0.5 Optionally Save Auth State

After successful UI login, save state for future runs:

```javascript
// Save state for future runs (optional)
mcp__plugin_triqual-plugin_playwright__browser_run_code({
  code: `async (page) => {
    const state = await page.context().storageState();
    require('fs').writeFileSync('.auth/user.json', JSON.stringify(state, null, 2));
    return 'Auth state saved to .auth/user.json';
  }`
})
```

---

## Phase 1: EXPLORE

### Default Mode (Autonomous)

After authentication, explore the feature:

```javascript
// Navigate to feature (already authenticated)
mcp__plugin_triqual-plugin_playwright__browser_navigate({ url: featureUrl })

// Capture state
mcp__plugin_triqual-plugin_playwright__browser_snapshot({})
```

### --explore Mode (Interactive)

For exploration-only mode:

1. **Detect dev server**: Check running servers
2. **Open visible browser**: `headless: false`
3. **User controls exploration**: Navigate, click, observe
4. **Take screenshots**: Capture key states
5. **STOP**: Do not proceed to Plan/Generate

Output exploration notes but do NOT generate test files.

### --ticket Mode (Skip Explore)

Fetch ticket from Linear:

```
mcp__linear__get_issue({ issueId: "ENG-123" })
```

Parse acceptance criteria as test requirements. Skip exploration phase.

### --describe Mode (Skip Explore)

Use the provided description as test requirements. Skip exploration phase.

---

## Phase 1.5: QUOTH CONTEXT (MANDATORY — ENFORCED BY HOOKS)

**Before dispatching test-planner**, invoke the quoth-context agent:

> Use quoth-context agent to research patterns for '{feature}' (pre-agent research mode)

This is **mandatory** during `/test`. The quoth-context agent will:
1. Search Quoth for "{feature} playwright test patterns"
2. Search Quoth for "{feature} common failures"
3. Read top matching docs and local knowledge.md
4. Return structured patterns summary
5. **Set the `quoth_context.invoked` session flag** (via `subagent-stop.sh`)

**The output feeds directly into test-planner's RESEARCH stage.**

### Hook Enforcement — This Is NOT Optional

Two blocking gates enforce quoth-context invocation:

| Gate | Hook | Blocks | Unblocked By |
|------|------|--------|--------------|
| **Gate 4.5** | `pre-spec-write.sh` | Writing any `.spec.ts` file | `quoth_context_invoked()` OR documented Quoth search in run log |
| **Gate 0** | `pre-retry-gate.sh` | Running `playwright test` (when run log exists) | `quoth_context_invoked()` session flag |

If quoth-context is skipped, **both writing tests and running tests will be BLOCKED with exit code 2**.

Additionally, `subagent-start.sh` warns the test-planner agent with a STOP advisory if quoth-context has not been invoked yet.

If quoth-context fails (MCP unavailable), fall back to manual search and document results in the run log:
```
mcp__quoth__quoth_search_index({
  query: "{feature} playwright test pattern"
})
```
Manual search results documented in the run log will satisfy Gate 4.5 (but not Gate 0 — only the agent sets the session flag).

---

## Phase 2: PLAN

### Using Quoth Context Output

test-planner receives the quoth-context output and uses it for:
- Existing Page Objects (from Quoth patterns)
- Similar test files (from Quoth search results)
- Assertion patterns (from matched docs)
- Locator strategies (from knowledge.md)

### Create Test Plan

Based on input source (exploration notes, ticket AC, or description):

**Output: specs/{feature}-plan.md**

```markdown
# Test Plan: {feature}

## Scope
- Feature: {feature}
- URL: /feature-path
- Auth required: Yes/No

## Test Cases

### TC-001: Should display feature page
- Navigate to /feature-path
- Assert page title is visible
- Assert main elements present

### TC-002: Should submit form successfully
- Fill form with valid data
- Click submit
- Assert success message visible

### TC-003: Should show validation errors
- Submit empty form
- Assert error messages visible

## Page Object
- Use existing: FeaturePage (from Quoth)
- Or create new with identified selectors
```

---

## Phase 3: GENERATE

### Prepare seed.spec.ts

Copy from `${PLUGIN_ROOT}/context/seed.template.ts` and customize:

```typescript
// tests/.draft/seed.spec.ts
import { test as base } from '@playwright/test';
import { testUsers } from '../../shared/test-data/users';

type AuthFixtures = {
  authenticatedPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.fill('[data-testid="email"]', testUsers.standard.email);
    await page.fill('[data-testid="password"]', testUsers.standard.password);
    await page.click('[type="submit"]');
    await page.waitForURL('**/dashboard');
    await use(page);
  },
});
```

### Generate Test File

**Output: tests/.draft/{feature}.spec.ts**

```typescript
import { test, expect } from './seed.spec';
import { FeaturePage } from '../pages/feature.page';

test.describe('{Feature}', () => {
  let featurePage: FeaturePage;

  test.beforeEach(async ({ authenticatedPage }) => {
    featurePage = new FeaturePage(authenticatedPage);
    await featurePage.goto();
  });

  test('should display feature page', async () => {
    await expect(featurePage.title).toBeVisible();
    await expect(featurePage.mainContainer).toBeVisible();
  });

  test('should submit form successfully', async () => {
    await featurePage.fillForm({ field1: 'value1' });
    await featurePage.submit();
    await expect(featurePage.successMessage).toBeVisible();
  });

  test('should show validation errors', async () => {
    await featurePage.submit(); // Empty form
    await expect(featurePage.errorMessage).toBeVisible();
  });
});
```

### Create Page Object (if needed)

Only if Quoth didn't find an existing one:

```typescript
// tests/pages/{feature}.page.ts
import { Page, Locator } from '@playwright/test';

export class FeaturePage {
  readonly page: Page;
  readonly title: Locator;
  readonly mainContainer: Locator;
  readonly submitButton: Locator;
  readonly successMessage: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.title = page.locator('h1');
    this.mainContainer = page.locator('[data-testid="feature-container"]');
    this.submitButton = page.locator('[data-testid="submit-btn"]');
    this.successMessage = page.locator('.success-message');
    this.errorMessage = page.locator('.error-message');
  }

  async goto() {
    await this.page.goto('/feature-path');
  }

  async fillForm(data: Record<string, string>) {
    // Fill form fields
  }

  async submit() {
    await this.submitButton.click();
  }
}
```

---

## Phase 4: HEAL LOOP

### Run Test

```bash
npx playwright test tests/.draft/{feature}.spec.ts --reporter=list
```

### If PASS → Go to Phase 5

### If FAIL → Heal (Max 5 Iterations)

#### 4a. Query Exolar for Similar Failures

```
mcp__exolar-qa__query_exolar_data({
  dataset: "failures",
  filters: { error_pattern: "{error_message}" }
})
```

If found, use previous fix as guidance.

#### 4b. Analyze Failure

Common fixes:

| Error | Fix |
|-------|-----|
| `strict mode violation` | Add `:visible` or more specific selector |
| `Timeout exceeded` | Add explicit wait or increase timeout |
| `Element not found` | Verify selector with Playwright MCP snapshot |
| `Multiple elements` | Use `.first()` or `nth()` with `:visible` |

#### 4c. Visual Verification (Optional)

If unsure about element existence:

```javascript
mcp__plugin_triqual-plugin_playwright__browser_navigate({ url: failingPageUrl })
mcp__plugin_triqual-plugin_playwright__browser_snapshot({})
// Inspect snapshot to find correct selector
```

#### 4d. Apply Fix

Edit the test file with the fix.

#### 4e. Track Anti-Pattern

```json
{
  "error": "strict mode violation: getByRole('button') resolved to 3 elements",
  "fix": "Use getByRole('button', { name: 'Submit' })",
  "feature": "{feature}",
  "iteration": 1
}
```

#### 4f. Re-run

```bash
npx playwright test tests/.draft/{feature}.spec.ts --reporter=list
```

Repeat until passing or max iterations (5) reached.

---

## Phase 5: PROMOTE

### Move from Draft to Production

```bash
# Determine target directory based on feature
# auth/ for login, signup
# dashboard/ for dashboard, home
# settings/ for settings, profile

mkdir -p tests/{category}/
mv tests/.draft/{feature}.spec.ts tests/{category}/{feature}.spec.ts
mv tests/.draft/seed.spec.ts tests/{category}/seed.spec.ts  # If new
```

### Verify Final Location

```bash
npx playwright test tests/{category}/{feature}.spec.ts --reporter=list
```

---

## Phase 6: LEARN

### Save Successful Patterns

Append to `${PLUGIN_ROOT}/context/patterns-learned.json`:

```json
{
  "id": "{feature}-{date}",
  "feature": "{feature}",
  "date": "2025-01-27",
  "selectors": {
    "submitButton": "[data-testid='submit-btn']",
    "successMessage": ".success-message"
  },
  "waits": ["waitForURL('**/dashboard')"],
  "assertions": ["expect(element).toBeVisible()"]
}
```

### Save Anti-Patterns

Append to `${PLUGIN_ROOT}/context/anti-patterns-learned.json`:

```json
{
  "id": "{error-type}-{date}",
  "error": "strict mode violation...",
  "fix": "Use more specific selector with name",
  "feature": "{feature}",
  "date": "2025-01-27"
}
```

### Propose to Quoth (Significant Discoveries)

If a pattern is reusable across features:

```
"I discovered that for this project, modals always use [data-testid='modal-overlay'].
Should I propose adding this to Quoth documentation?"
```

---

## Report Success

```markdown
## Test Complete: {feature}

**Generated Files:**
- `tests/{category}/{feature}.spec.ts` - 3 test cases
- `tests/pages/{feature}.page.ts` - Page Object

**Test Results:**
- 3/3 tests passing
- 2 heal iterations required

**Patterns Learned:**
- Selector: [data-testid="submit-btn"] for submit buttons
- Wait: Always waitForURL after form submission

**Anti-Patterns Recorded:**
- Don't use getByRole('button') without name in this project

**Next Steps:**
1. Review generated tests
2. Add to version control
3. Run full test suite to ensure no conflicts
```

---

## Mode-Specific Behavior

### --explore Mode

```bash
/test --explore login
```

**Behavior:**
1. Opens visible browser (headless: false)
2. Uses Playwright MCP for exploration
3. Captures screenshots and observations
4. **STOPS after exploration - no test generation**

Use when you want to:
- Understand the UI before writing tests
- Debug a specific interaction
- Take screenshots for documentation

### --ticket Mode

```bash
/test --ticket ENG-123
```

**Behavior:**
1. Fetches ticket from Linear MCP
2. Parses acceptance criteria
3. Searches Quoth for patterns
4. Generates tests from AC (skips exploration)
5. Runs heal loop
6. Provides PR instructions

### --describe Mode

```bash
/test --describe "user can reset password via email link"
```

**Behavior:**
1. Uses description as requirements
2. Searches Quoth for patterns
3. Generates tests from description (skips exploration)
4. Runs heal loop

---

## Troubleshooting

### Playwright MCP Not Connected

```
Run /mcp to check connection status
```

### Test Credentials Not Found

Check these locations:
- `automation/shared/test-data/users.ts`
- `tests/fixtures/users.ts`
- `.env.test` for environment variables

### Heal Loop Exhausted

If 5 iterations fail:
1. Review the final error carefully
2. Use Playwright MCP for manual exploration
3. Check if the feature actually works manually
4. Consider if this is a BUG (create Linear ticket) vs TEST_ISSUE

### No Config Found

Run `/init` first, or provide `--ticket` or `--describe` with explicit requirements.

---

## What This Skill Does

- **Default mode**: Full autonomous test generation with learning
- **--explore**: Interactive browser exploration only
- **--ticket**: Generate tests from Linear acceptance criteria
- **--describe**: Generate tests from text description

## What This Skill Does NOT Do

- Lint tests for violations (use `/check`)
- Show best practice rules (use `/rules`)
- Initialize project config (use `/init`, though auto-config works)
