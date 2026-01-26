# Quoth Integration - Knowledge Base Interaction

This document describes how to integrate with Quoth for documentation and pattern management.

## Overview

Quoth is an MCP-enabled "Single Source of Truth" documentation system. It provides:

1. **Semantic search** across all documentation
2. **Pattern storage** for test conventions
3. **Incremental updates** as patterns evolve
4. **Audit trail** for documentation changes

## MCP Tools

### quoth_search_index

Search for relevant documentation by semantic query.

**Parameters:**
```typescript
{
  query: string,      // Natural language search query
  category?: string,  // Optional: 'patterns', 'contracts', 'architecture'
  limit?: number      // Optional: max results (default: 10)
}
```

**Usage:**
```
quoth_search_index({
  query: "authentication patterns for Playwright tests",
  category: "patterns",
  limit: 5
})
```

**Returns:**
```typescript
{
  results: [
    {
      document_id: "authentication",
      title: "Authentication Guide",
      relevance: 0.92,
      snippet: "Global setup authenticates all roles once..."
    },
    // ...
  ]
}
```

### quoth_read_doc

Read full content of a specific document.

**Parameters:**
```typescript
{
  document_id: string  // Document identifier
}
```

**Usage:**
```
quoth_read_doc({
  document_id: "authentication"
})
```

**Returns:**
```typescript
{
  document_id: "authentication",
  type: "patterns",
  status: "active",
  last_updated_date: "2025-01-15",
  content: "# Authentication Guide\n\n..."
}
```

### quoth_propose_update

Propose changes to documentation.

**Parameters:**
```typescript
{
  document_id: string,     // Document to update (or new id for create)
  content: string,         // New or updated content (markdown)
  evidence: string,        // Justification for the change
  update_type: "create" | "update" | "deprecate"
}
```

**Usage:**
```
quoth_propose_update({
  document_id: "error-patterns",
  content: "## New Error Pattern\n\n### Error: Element detached...",
  evidence: "Discovered during debugging of ENG-456",
  update_type: "update"
})
```

**Returns:**
```typescript
{
  proposal_id: "prop-123",
  status: "pending",
  message: "Proposal submitted for review"
}
```

### quoth_genesis

Bootstrap documentation from codebase scanning.

**Parameters:**
```typescript
{
  scan_path: string,       // Directory to scan
  document_type: string,   // Type of documentation to generate
  overwrite?: boolean      // Whether to replace existing (default: false)
}
```

**Usage:**
```
quoth_genesis({
  scan_path: "automation/playwright/page-objects/",
  document_type: "page-objects",
  overwrite: false
})
```

---

## Document Categories

### Architecture Documents

High-level system understanding:

| Document ID | Purpose |
|-------------|---------|
| project-overview | System overview, tech stack |
| repo-structure | Folder organization, conventions |
| test-infrastructure | Test framework setup |

### Pattern Documents

How things should be done:

| Document ID | Purpose |
|-------------|---------|
| test-conventions | File naming, test structure |
| locator-patterns | How to find elements |
| authentication | Auth state management |
| error-handling | Common error patterns and fixes |
| anti-patterns | What NOT to do |

### Contract Documents

Specific interfaces and schemas:

| Document ID | Purpose |
|-------------|---------|
| page-objects | Available Page Objects reference |
| helpers | Utility functions reference |
| fixtures | Test data reference |
| api-schemas | API endpoint contracts |

---

## Integration Workflows

### Before Writing Tests

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     BEFORE WRITING TESTS                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Search for relevant patterns                                           │
│      quoth_search_index({ query: "login form testing" })                    │
│                                                                              │
│   2. Read matching documents                                                │
│      quoth_read_doc({ document_id: "authentication" })                      │
│      quoth_read_doc({ document_id: "page-objects" })                        │
│                                                                              │
│   3. Check for anti-patterns                                                │
│      quoth_read_doc({ document_id: "anti-patterns" })                       │
│                                                                              │
│   4. Use patterns in test code                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### After Discovering New Pattern

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DOCUMENTING NEW PATTERN                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Search if pattern already documented                                   │
│      quoth_search_index({ query: "modal dialog handling" })                 │
│                                                                              │
│   2. If not found, propose new pattern                                      │
│      quoth_propose_update({                                                 │
│        document_id: "test-conventions",                                     │
│        content: "## Modal Dialog Pattern\n\n...",                           │
│        evidence: "Discovered during ENG-789 implementation",                │
│        update_type: "update"                                                │
│      })                                                                     │
│                                                                              │
│   3. If found but incomplete, propose update                                │
│      quoth_propose_update({                                                 │
│        document_id: "test-conventions",                                     │
│        content: "<existing> + <new section>",                               │
│        evidence: "Additional edge case found",                              │
│        update_type: "update"                                                │
│      })                                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Bootstrap Project Documentation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BOOTSTRAP WORKFLOW                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Scan Page Objects                                                      │
│      quoth_genesis({                                                        │
│        scan_path: "automation/playwright/page-objects/",                    │
│        document_type: "page-objects"                                        │
│      })                                                                     │
│                                                                              │
│   2. Scan Helpers                                                           │
│      quoth_genesis({                                                        │
│        scan_path: "automation/playwright/utils/",                           │
│        document_type: "helpers"                                             │
│      })                                                                     │
│                                                                              │
│   3. Scan Test Structure                                                    │
│      quoth_genesis({                                                        │
│        scan_path: "automation/playwright/tests/",                           │
│        document_type: "test-conventions"                                    │
│      })                                                                     │
│                                                                              │
│   4. Manual review and refinement                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Document Templates

### Page Objects Reference Template

```markdown
---
id: page-objects
type: contract
status: active
last_updated_date: YYYY-MM-DD
---

# Page Objects Reference

## Overview

List of available Page Objects with their locators and methods.

## LoginPage

**Location:** `automation/playwright/page-objects/login.page.ts`

### Locators

| Name | Selector | Purpose |
|------|----------|---------|
| emailInput | `getByLabel('Email')` | Email input field |
| passwordInput | `getByLabel('Password')` | Password input |
| submitButton | `getByRole('button', { name: 'Sign In' })` | Submit button |
| errorMessage | `getByTestId('error-message')` | Error display |

### Methods

| Method | Parameters | Returns | Description |
|--------|------------|---------|-------------|
| goto() | none | Promise<void> | Navigate to /login |
| login(email, password) | string, string | Promise<void> | Perform login |
| getErrorText() | none | Promise<string> | Get error message |

### Usage Example

```typescript
const loginPage = new LoginPage(page);
await loginPage.goto();
await loginPage.login('user@example.com', 'password');
```

## DashboardPage

[Continue for each Page Object...]
```

### Test Conventions Template

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
- Fixtures: `{data-type}.fixture.ts`

## Test Structure

```typescript
import { test, expect } from '@playwright/test';
import { FeaturePage } from '../page-objects/feature.page';

test.describe('Feature Name', () => {
  let page: FeaturePage;

  test.beforeEach(async ({ page: p }) => {
    page = new FeaturePage(p);
    await page.goto();
  });

  test('should do something', async () => {
    await test.step('Action description', async () => {
      // Action code
    });

    await test.step('Verification', async () => {
      await expect(page.element).toBeVisible();
    });
  });
});
```

## Locator Priority

1. `getByRole()` - Preferred
2. `getByLabel()` - For form inputs
3. `getByTestId()` - When role not applicable
4. CSS selectors - Last resort

## Required Patterns

- Always use Page Objects
- Always use test.step for documentation
- Always use getTimeout() for waits
- Always handle strict mode with :visible or .first()

## Anti-Patterns

- ❌ `page.waitForTimeout(NUMBER)` - Use waitFor()
- ❌ Hardcoded credentials - Use fixtures
- ❌ Inline locators - Use Page Objects
- ❌ `waitForLoadState('networkidle')` - Use 'domcontentloaded'
```

### Helper Functions Template

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

**Location:** `automation/playwright/utils/auth.ts`

Sets up authentication state for the specified role.

**Parameters:**
- `role`: 'buyer' | 'seller' | 'admin'

**Usage:**
```typescript
import { authenticateAs } from '../utils/auth';

test.beforeEach(async () => {
  await authenticateAs('buyer');
});
```

### clearAuthState()

**Location:** `automation/playwright/utils/auth.ts`

Removes all stored authentication state.

**Usage:**
```typescript
test.afterAll(async () => {
  await clearAuthState();
});
```

## Timeout Helpers

### getTimeout(type: string)

**Location:** `automation/playwright/utils/timeout-manager.ts`

Returns appropriate timeout value for different scenarios.

**Parameters:**
- `type`: 'short' | 'medium' | 'long' | 'animation'

**Returns:**
- short: 5000ms
- medium: 15000ms
- long: 30000ms
- animation: 300ms

**Usage:**
```typescript
import { getTimeout } from '../utils/timeout-manager';

await page.waitForSelector('.element', { timeout: getTimeout('medium') });
```

## Data Helpers

### createTestUser(overrides?: Partial<User>)

**Location:** `automation/playwright/utils/data-factory.ts`

Creates a test user via API.

**Parameters:**
- `overrides`: Optional fields to override defaults

**Returns:** Created user object

**Usage:**
```typescript
const user = await createTestUser({ role: 'seller' });
```
```

### Authentication Guide Template

```markdown
---
id: authentication
type: patterns
status: active
last_updated_date: YYYY-MM-DD
---

# Authentication Guide

## Architecture

- Global setup authenticates all roles once
- Auth state stored in `.auth/{role}.json`
- Tests use `storageState` to restore sessions

## Available Roles

| Role | Email | Capabilities |
|------|-------|--------------|
| buyer | buyer@test.com | Create cases, submit proposals |
| seller | seller@test.com | View cases, respond |
| admin | admin@test.com | Full access |

## Usage Patterns

### Single Role Test

```typescript
test.describe('Buyer Flow', () => {
  test.use({ storageState: '.auth/buyer.json' });

  test('can create case', async ({ page }) => {
    // Already authenticated as buyer
  });
});
```

### Multi-Role Test

```typescript
test('buyer-seller interaction', async ({ browser }) => {
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

### Refreshing Auth State

```bash
rm -rf .auth/
npx playwright test --project=setup
```

## Troubleshooting

### Redirected to Login

**Symptom:** Test redirects to login unexpectedly
**Cause:** Auth state expired or missing
**Fix:** Regenerate auth state

### Session Invalid

**Symptom:** 401 errors during test
**Cause:** Session invalidated server-side
**Fix:** Check session TTL, regenerate if needed
```

---

## Quoth Search Strategies

### Finding Relevant Patterns

```typescript
// For new feature implementation
quoth_search_index({
  query: "how to test {feature_type}",
  category: "patterns"
})

// For debugging failures
quoth_search_index({
  query: "error {error_message}",
  category: "patterns"
})

// For understanding existing code
quoth_search_index({
  query: "{PageObjectName} locators methods",
  category: "contracts"
})
```

### Query Formulation Tips

| Goal | Query Pattern |
|------|---------------|
| Find Page Object | `"{PageName}" locators methods usage` |
| Find pattern for action | `"how to {action}" playwright test` |
| Find error solution | `"error {keyword}" fix solution` |
| Find anti-pattern | `"avoid" "{pattern}" anti-pattern` |
| Find helper | `"helper" "{function_name}" usage` |

### Handling No Results

If search returns no results:

1. **Broaden query** - Remove specific terms
2. **Try synonyms** - Different terminology
3. **Check category** - May be in different category
4. **Bootstrap needed** - Documentation may not exist

```typescript
// Too specific
quoth_search_index({ query: "MUI DataGrid pagination test" })

// Better: broader terms
quoth_search_index({ query: "table pagination testing" })

// Alternative: check contracts
quoth_search_index({ query: "DataGrid", category: "contracts" })
```

---

## Pattern Lifecycle

### Creating New Pattern

```
1. Discover pattern during development
   ↓
2. Search Quoth for existing documentation
   ↓
3. If not found: propose_update with create
   ↓
4. Pattern reviewed (manual or automated)
   ↓
5. Pattern available for future reference
```

### Updating Existing Pattern

```
1. Find limitation or error in existing pattern
   ↓
2. Read current documentation
   ↓
3. propose_update with updated content
   ↓
4. Include evidence (ticket, test, failure)
   ↓
5. Pattern updated after review
```

### Deprecating Pattern

```
1. Pattern no longer applicable
   ↓
2. Read current documentation
   ↓
3. propose_update with deprecate type
   ↓
4. Include reason and replacement
   ↓
5. Pattern marked deprecated
```

---

## Integration Checklist

### Setting Up Quoth Integration

```
□ Quoth MCP server connected
□ Test quoth_search_index with sample query
□ Verify document categories exist
□ Bootstrap initial documentation (if new project)
□ Document Page Objects
□ Document Helpers
□ Document Authentication
□ Document Conventions
```

### Using Quoth in Workflow

```
□ Search before writing new tests
□ Check anti-patterns before implementation
□ Propose updates for new discoveries
□ Include evidence with all proposals
□ Review and refine generated documentation
```

### Maintaining Documentation

```
□ Update docs when patterns change
□ Deprecate obsolete patterns
□ Add new patterns as discovered
□ Keep examples current
□ Review periodically for accuracy
```
