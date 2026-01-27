# Project-Specific Test Knowledge

> This file accumulates learnings from test development sessions.
> Updated automatically by Triqual hooks and pattern-learner agent.
> Read this file before writing tests to apply project conventions.

## Last Updated
{timestamp}

---

## Project Overview

**Project:** {project-name}
**Test Directory:** {testDir}
**Base URL:** {baseUrl}

---

## Selectors

### Strategy Priority
1. `data-testid` (preferred)
2. `getByRole()` with name
3. `getByText()` for static content
4. CSS selectors (last resort)

### Component Patterns

| Component | Selector Pattern | Notes |
|-----------|-----------------|-------|
| Primary Button | `[data-testid="{action}-button"]` | {notes} |
| Form Input | `getByLabel("{label}")` | {notes} |
| Modal | `[role="dialog"]` | {notes} |
| Toast | `[data-testid="toast"]` | {notes} |

### Page-Specific Selectors

#### {Page Name}
| Element | Selector | Notes |
|---------|----------|-------|
| {element} | {selector} | {notes} |

---

## Wait Patterns

### After Navigation
- Login redirect: `await page.waitForLoadState('networkidle')`
- Dashboard load: `await expect(page.getByRole('heading')).toBeVisible()`

### After Actions
- Form submit: `await expect(toast).toBeVisible()`
- Modal open: `await expect(modal).toBeVisible()`
- API calls: `await page.waitForResponse(/api\/{endpoint}/)`

### Known Slow Operations
| Operation | Recommended Wait | Timeout |
|-----------|-----------------|---------|
| {operation} | {wait-strategy} | {ms} |

---

## Authentication

### Strategy
**Primary:** {storageState | setupProject | uiLogin}
**Fallback:** {strategy}

### Storage State Files
| User Type | Path | Purpose |
|-----------|------|---------|
| Standard | `.auth/user.json` | Regular user flows |
| Admin | `.auth/admin.json` | Admin-only features |

### Credentials
**Location:** `{path/to/credentials}`
**Default User:** `{type}`

### Login Flow Notes
- {note about login behavior}
- {note about session handling}

---

## Test Data

### Data Factory
**Location:** `{path/to/factories}`

| Factory | Purpose | Example |
|---------|---------|---------|
| {factory} | {purpose} | `{usage}` |

### Static Test Data
| Data Type | Location | Notes |
|-----------|----------|-------|
| Users | `{path}` | {notes} |
| Cases | `{path}` | {notes} |

### Database Seeding
- Seed command: `{command}`
- Reset command: `{command}`

---

## Page Objects

### Available Page Objects
| Page Object | Path | Coverage |
|-------------|------|----------|
| LoginPage | `{path}` | Login, logout, forgot password |
| DashboardPage | `{path}` | Navigation, quick actions |

### Page Object Conventions
- One file per logical page/component
- Methods return `Promise<void>` or `Promise<Locator>`
- Use Arrange-Act-Assert pattern in tests
- Page Objects do NOT assert - tests assert

---

## Helpers & Utilities

| Helper | Path | Purpose |
|--------|------|---------|
| `{helper}` | `{path}` | {purpose} |

---

## Fixtures

### Available Fixtures
| Fixture | Path | Provides |
|---------|------|----------|
| `{fixture}` | `{path}` | {what it provides} |

### Fixture Usage
```typescript
test.use({ /* fixture config */ });
```

---

## Known Flakes

| Test/Area | Cause | Mitigation |
|-----------|-------|------------|
| Dashboard charts | Animation timing | Retry up to 2x |
| File uploads | Network latency | Increase timeout |

---

## Anti-Patterns (Do NOT Use)

### Locators
- `page.waitForTimeout()` - Always use proper waits
- `nth(0)` without `:visible` - May select hidden elements
- Complex XPath - Use data-testid instead
- Fragile CSS chains - Breaks on DOM changes

### Assertions
- `expect(count).toBe(N)` without wait - Race condition
- Asserting on animation states - Use `toBeVisible()`

### Flow
- Hardcoded URLs - Use `BASE_URL` env var
- Magic numbers - Use named constants

---

## Environment Notes

### Local Development
- Base URL: `http://localhost:{port}`
- Special setup: {notes}

### Staging
- Base URL: `{url}`
- Special setup: {notes}

### CI/CD
- Special considerations: {notes}
- Timeouts: Increase by 2x

---

## Debugging Tips

### Common Issues

#### "Element not found"
1. Check if element is in viewport
2. Check if element is behind overlay
3. Check if element is in iframe
4. Use `:visible` filter

#### "Timeout waiting for..."
1. Check network conditions
2. Check if API is responding
3. Increase timeout for slow operations
4. Use `page.waitForLoadState('networkidle')`

#### "Strict mode violation"
1. Add `:visible` filter
2. Use more specific selector
3. Use `first()` only if intentional

---

## Session Learnings

> Recent learnings added by Triqual sessions

### {date} - {feature}
- {learning-1}
- {learning-2}

### {date} - {feature}
- {learning-1}
- {learning-2}
