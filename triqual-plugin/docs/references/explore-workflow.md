# Explore Workflow - Creating New Tests

This document describes the workflow for creating new tests by exploring a live application.

## Overview

The explore workflow enables creating tests based on actual application behavior:

1. **Search** Quoth for existing patterns and similar tests
2. **Navigate** to the feature in a live browser
3. **Explore** the user flow interactively
4. **Document** observations as you go
5. **Write** test code based on real behavior
6. **Verify** the test works
7. **Learn** by documenting new patterns

## When to Use

- Creating tests for a new feature
- No existing tests cover this flow
- Need to understand actual application behavior
- Test documentation doesn't match reality
- Creating comprehensive test coverage

---

## Explore Workflow Steps

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXPLORE WORKFLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐      │
│   │ SEARCH  │──▶│ NAVIGATE│──▶│ EXPLORE │──▶│  WRITE  │──▶│ VERIFY  │      │
│   │ Quoth   │   │ To      │   │ Flow    │   │  Test   │   │ & Learn │      │
│   │         │   │ Feature │   │         │   │         │   │         │      │
│   └─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘      │
│       │             │             │             │             │              │
│   Patterns,     Open app,     Click,        Create         Run test,       │
│   similar       auth if       observe,      test file      document        │
│   tests         needed        document      with real      new patterns    │
│                               states        locators                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Search for Context

### 1.1 Search Quoth for Patterns

Before exploring, gather existing knowledge:

```
quoth_search_index({
  query: "test patterns for {feature_type}"
})
```

Look for:
- Similar feature tests
- Page Objects that might apply
- Helper functions for this type of testing
- Known patterns and anti-patterns

### 1.2 Check for Existing Tests

Search the codebase:
- Are there similar tests already?
- What patterns do they follow?
- What Page Objects exist?

### 1.3 Search Exolar for Similar Tests

```
query_exolar_data({
  dataset: "test_search",
  query: "{feature_name}"
})
```

Learn from:
- Existing test coverage
- Common failure patterns
- Execution history

### 1.4 Gather Requirements

Understand what to test:
- Feature description (ticket, documentation)
- Acceptance criteria
- Edge cases to consider
- User roles involved

---

## Step 2: Navigate to Feature

### 2.1 Set Up Browser

```
1. Get tab context
   mcp__playwright-test__tabs_context_mcp({ createIfEmpty: true })

2. Create new tab
   mcp__playwright-test__tabs_create_mcp()
```

### 2.2 Navigate to Application

```
mcp__playwright-test__browser_navigate({
  url: "{base_url}/{feature_path}",
  tabId
})
```

### 2.3 Authenticate If Needed

Determine required role and authenticate:

```
Option A: Manual login via MCP
- Navigate to /login
- Enter credentials (from fixtures)
- Complete login flow

Option B: Use stored auth state
- Check if .auth/{role}.json exists
- Use for authenticated context
```

### 2.4 Take Initial Snapshot

```
mcp__playwright-test__browser_snapshot({ tabId })
```

Document the starting state.

---

## Step 3: Explore the Flow

### 3.1 Interactive Exploration

For each step in the user flow:

```
1. Take snapshot
   - Identify interactive elements
   - Note element refs for later

2. Perform action
   - Click, type, select as needed
   - Use appropriate MCP tool

3. Observe result
   - Take new snapshot
   - Note state changes
   - Capture any error/success messages

4. Document
   - What action was taken
   - What elements were involved
   - What state changed
```

### 3.2 Document as You Go

Create exploration notes:

```markdown
## Feature: {Feature Name}

### Flow: Happy Path

**Step 1: Initial State**
- URL: /feature
- Key elements:
  - [ref_1] button "Create New"
  - [ref_2] table "items-list" (empty)

**Step 2: Click Create**
- Action: Click "Create New" button
- Result: Modal appears
- New elements:
  - [ref_5] textbox "Name"
  - [ref_6] textbox "Description"
  - [ref_7] button "Save"
  - [ref_8] button "Cancel"

**Step 3: Fill Form**
- Action: Fill name = "Test Item"
- Action: Fill description = "Test description"
- Result: Save button enabled

**Step 4: Submit**
- Action: Click "Save"
- Result: Modal closes, item in list
- Success message: "Item created successfully"
```

### 3.3 Identify Key Assertions

For each step, note what should be asserted:

| Step | Assertion | Type |
|------|-----------|------|
| After click Create | Modal visible | Visibility |
| After fill form | Save enabled | State |
| After submit | Success message | Text |
| After submit | Item in list | Content |
| After submit | Modal closed | Hidden |

### 3.4 Identify Locators

Map observed elements to locator strategies:

| Element | Ref | Recommended Locator |
|---------|-----|---------------------|
| Create button | ref_1 | `getByRole('button', { name: 'Create New' })` |
| Name input | ref_5 | `getByLabel('Name')` or `getByRole('textbox', { name: 'Name' })` |
| Save button | ref_7 | `getByRole('button', { name: 'Save' })` |
| Success message | ref_10 | `getByText('Item created successfully')` |

### 3.5 Explore Edge Cases

After happy path, explore:
- Empty inputs (validation)
- Invalid data (error handling)
- Cancel/back navigation
- Error scenarios
- Different user roles

---

## Step 4: Write the Test

### 4.1 Choose Test Location

Based on project conventions:
```
automation/playwright/tests/{feature}/{feature-flow}.spec.ts
```

### 4.2 Create or Update Page Object

If needed, create Page Object for the feature:

```typescript
// feature.page.ts
import { Page, Locator } from '@playwright/test';

export class FeaturePage {
  readonly page: Page;

  // Locators from exploration
  readonly createButton: Locator;
  readonly modal: Locator;
  readonly nameInput: Locator;
  readonly descriptionInput: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;
  readonly successMessage: Locator;
  readonly itemsList: Locator;

  constructor(page: Page) {
    this.page = page;

    // Use locators identified during exploration
    this.createButton = page.getByRole('button', { name: 'Create New' });
    this.modal = page.getByRole('dialog');
    this.nameInput = page.getByLabel('Name');
    this.descriptionInput = page.getByLabel('Description');
    this.saveButton = page.getByRole('button', { name: 'Save' });
    this.cancelButton = page.getByRole('button', { name: 'Cancel' });
    this.successMessage = page.getByText('Item created successfully');
    this.itemsList = page.getByRole('table', { name: 'items-list' });
  }

  async goto() {
    await this.page.goto('/feature');
  }

  async createItem(name: string, description: string) {
    await this.createButton.click();
    await this.nameInput.fill(name);
    await this.descriptionInput.fill(description);
    await this.saveButton.click();
  }
}
```

### 4.3 Write Test File

```typescript
// feature-create.spec.ts
import { test, expect } from '@playwright/test';
import { FeaturePage } from '../page-objects/feature.page';

test.describe('Feature Creation', () => {
  let featurePage: FeaturePage;

  test.beforeEach(async ({ page }) => {
    featurePage = new FeaturePage(page);
    await featurePage.goto();
  });

  test('should create new item successfully', async ({ page }) => {
    await test.step('Open create modal', async () => {
      await featurePage.createButton.click();
      await expect(featurePage.modal).toBeVisible();
    });

    await test.step('Fill form', async () => {
      await featurePage.nameInput.fill('Test Item');
      await featurePage.descriptionInput.fill('Test description');
    });

    await test.step('Submit and verify', async () => {
      await featurePage.saveButton.click();
      await expect(featurePage.successMessage).toBeVisible();
      await expect(featurePage.modal).toBeHidden();
      await expect(featurePage.itemsList).toContainText('Test Item');
    });
  });

  test('should show validation error for empty name', async ({ page }) => {
    await test.step('Open modal and submit empty', async () => {
      await featurePage.createButton.click();
      await featurePage.saveButton.click();
    });

    await test.step('Verify error', async () => {
      await expect(page.getByText('Name is required')).toBeVisible();
    });
  });
});
```

### 4.4 Use Existing Patterns

Ensure test follows project conventions:
- Use Page Objects
- Use helper functions
- Use timeout manager
- Follow naming conventions
- Include test.step for documentation

---

## Step 5: Verify and Learn

### 5.1 Run the Test

```bash
npx playwright test path/to/test.spec.ts --headed
```

### 5.2 Watch and Verify

Observe test execution:
- Does it follow the explored flow?
- Do assertions pass?
- Is timing appropriate?

### 5.3 Fix Any Issues

If test fails, use debug workflow to fix.

### 5.4 Document New Patterns

If you discovered something new:

**Update Quoth with new pattern:**
```
quoth_propose_update({
  document_id: "test-conventions",
  content: "New section about {pattern}",
  evidence: "Discovered during exploration of {feature}",
  update_type: "update"
})
```

**Update Page Objects reference:**
```
quoth_propose_update({
  document_id: "page-objects",
  content: "New FeaturePage documentation",
  evidence: "Created for {feature} tests",
  update_type: "update"
})
```

---

## Exploration Templates

### Template 1: Form Flow

```markdown
## Form Exploration: {Form Name}

### Fields
| Field | Type | Required | Validation |
|-------|------|----------|------------|
| | | | |

### Actions
| Action | Result |
|--------|--------|
| Submit valid | |
| Submit empty | |
| Submit invalid | |
| Cancel | |

### Locators
| Element | Locator |
|---------|---------|
| | |
```

### Template 2: CRUD Flow

```markdown
## CRUD Exploration: {Entity}

### Create
- URL:
- Steps:
- Success indicator:
- Error handling:

### Read
- List view:
- Detail view:
- Empty state:

### Update
- Access:
- Editable fields:
- Save behavior:

### Delete
- Access:
- Confirmation:
- Result:
```

### Template 3: Multi-Step Flow

```markdown
## Flow Exploration: {Flow Name}

### Prerequisites
- Auth:
- Data:

### Steps
1. Step 1
   - Action:
   - Result:
   - Assertions:

2. Step 2
   - Action:
   - Result:
   - Assertions:

### Edge Cases
-
-

### Roles Involved
| Role | Can Do | Cannot Do |
|------|--------|-----------|
| | | |
```

---

## Explore Checklist

```
□ Search Quoth for relevant patterns
□ Check for existing similar tests
□ Understand requirements/acceptance criteria
□ Set up browser with appropriate auth
□ Navigate to feature
□ Explore happy path
  □ Document each step
  □ Note elements and refs
  □ Identify assertions
□ Explore edge cases
□ Create/update Page Object
□ Write test file following patterns
□ Run test and verify
□ Fix any issues
□ Document new patterns to Quoth
```
