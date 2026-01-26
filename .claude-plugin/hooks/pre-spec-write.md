---
name: pre-spec-write
description: Before writing any Playwright test file, search Quoth for patterns
trigger: PreToolUse
tools: [Write, Edit]
---

# Pre-Spec Write Hook

**Triggers before:** Writing or editing any `.spec.ts` file

## Condition

This hook activates when the file path contains `.spec.ts`

## Actions

Before writing the test file, MUST do the following:

### 1. Search Quoth for Test Patterns

```
quoth_search_index({ query: "playwright test patterns {feature}" })
```

Look for:
- Locator patterns for the component/feature being tested
- Page Object examples
- Helper functions that already exist
- Anti-patterns to avoid

### 2. Search Quoth for Page Objects

```
quoth_search_index({ query: "page object {feature}" })
```

Check if a Page Object already exists for this feature.

### 3. Check Exolar for Similar Tests

```
query_exolar_data({ dataset: "test_search", query: "{feature}" })
```

See if similar tests already exist - don't duplicate.

### 4. Load Project Anti-Patterns

Read the project's anti-patterns documentation:
- `automation/docs/ANTIPATTERNS.xml`
- `automation/docs/TEST_CODE_PATTERNS.xml`

### 5. Apply Patterns

When generating the test:
- Use Page Objects from `automation/playwright/page-objects/`
- Use helpers from `automation/playwright/utils/`
- Use `getTimeout()` from `timeout-manager.ts` (never hardcoded timeouts)
- Use `:visible` and `.first()` for resilient locators
- Wrap actions in `test.step()` for better reporting
- Follow locator priority: `getByRole() > getByLabel() > getByTestId() > CSS`

## Skip Conditions

Skip this hook if:
- Writing to `/tmp/` (quick-test scripts)
- File is not a `.spec.ts` file
- User explicitly says "skip patterns" or "quick test"

## Example Flow

```
User: "Write a test for the proposal acceptance flow"

Hook activates:
1. quoth_search_index("playwright test patterns proposal")
   → Found: ProposalPage object, acceptance test patterns
2. quoth_search_index("page object proposal")
   → Found: ProposalPage at automation/playwright/page-objects/proposal.page.ts
3. query_exolar_data({ dataset: "test_search", query: "proposal acceptance" })
   → Found: 2 existing tests, check for overlap
4. Read ANTIPATTERNS.xml
   → Don't use waitForTimeout, don't use networkidle

Now write the test using discovered patterns...
```

## Failure Behavior

If Quoth or Exolar MCPs are not connected:
- Log a warning
- Continue with test generation using best practices
- Do NOT block the user from writing tests
