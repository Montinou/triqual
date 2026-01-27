# Test Run Log: {feature-name}

## Session: {timestamp}

---

### Stage: ANALYZE
**Feature:** {feature-name}
**Source:** {Linear ticket ENG-XXX | User description | Exploration | Other}
**Objective:** {what this test should verify}

#### Source Context

**Linear Ticket (if applicable):**
- Ticket: `{ENG-XXX}`
- Title: {ticket title}
- Description: {brief summary}
- Acceptance Criteria from Ticket:
  1. {AC-1 from ticket}
  2. {AC-2 from ticket}
  3. {AC-3 from ticket}

**User Description (if applicable):**
> {quoted user description}

#### Requirements Analysis
- [ ] Read feature/ticket requirements
- [ ] Identify acceptance criteria
- [ ] List user flows to cover
- [ ] Identify edge cases and error scenarios

**Derived Test Requirements:**

| Requirement | Source | Priority | Testable? |
|-------------|--------|----------|-----------|
| {req-1} | Ticket AC-1 | High | Yes |
| {req-2} | Ticket AC-2 | Medium | Yes |
| {req-3} | Inferred | Low | Yes |

**User Flows to Test:**
1. {flow-1: e.g., "Happy path - successful login"}
2. {flow-2: e.g., "Error case - invalid credentials"}
3. {flow-3: e.g., "Edge case - session timeout"}
4. {flow-4: e.g., "Boundary - max login attempts"}

---

### Stage: RESEARCH
- [ ] Searched Quoth for patterns
- [ ] Checked Exolar for similar tests
- [ ] Reviewed existing Page Objects
- [ ] Reviewed existing helpers and fixtures
- [ ] Reviewed existing test data factories
- [ ] Checked project knowledge.md

#### Quoth Search Results

**Query 1:** `{feature} playwright patterns`
**Patterns Found:**
- {pattern-1: description and applicability}
- {pattern-2: description and applicability}

**Query 2:** `{error-type} fix playwright`
**Patterns Found:**
- {pattern-1}
- {pattern-2}

**Quoth Doc IDs to Reference:**
- `{doc-id-1}` - {title}
- `{doc-id-2}` - {title}

#### Exolar Search Results

**Query:** `test_search: {feature}`
**Existing Tests Found:**
| Test File | Coverage | Last Run | Status |
|-----------|----------|----------|--------|
| {path} | {what it tests} | {date} | {pass/fail} |

**Coverage Gaps Identified:**
- {gap-1}
- {gap-2}

**Historical Failure Patterns:**
- {failure-pattern-1}
- {failure-pattern-2}

#### Available Project Resources

**Page Objects:**
| Page Object | Path | Methods | Reusable For |
|-------------|------|---------|--------------|
| {LoginPage} | {path} | {login(), logout()} | Auth flows |
| {DashboardPage} | {path} | {navigate(), getStats()} | Dashboard tests |

**Helpers:**
| Helper | Path | Purpose | Usage |
|--------|------|---------|-------|
| {authHelper} | {path} | {Setup auth state} | `await auth.login(user)` |
| {apiHelper} | {path} | {API mocking} | `await api.mock(...)` |

**Fixtures:**
| Fixture | Path | Provides | Setup |
|---------|------|----------|-------|
| {auth} | {path} | Authenticated page | `test.use({ storageState: '...' })` |
| {db} | {path} | Seeded database | `test.beforeAll(...)` |

**Test Data:**
| Data Type | Path | Contents | Usage |
|-----------|------|----------|-------|
| {users} | {path} | Test user credentials | `import { testUsers } from '...'` |
| {cases} | {path} | Sample case data | `import { testCases } from '...'` |

**Project Knowledge (from .triqual/knowledge.md):**
- Selector strategy: {data-testid preferred}
- Wait patterns: {networkidle after login}
- Known gotchas: {list relevant ones}

#### Research Findings Summary
1. {finding-1: What existing patterns apply?}
2. {finding-2: What resources can be reused?}
3. {finding-3: What needs to be created?}
4. {finding-4: What potential issues to watch for?}

---

### Stage: PLAN
**Test Strategy:** {approach - e.g., "Use existing LoginPage, create new DashboardPage, leverage auth fixture"}

#### Test Plan

| # | Test Case | Covers Requirement | Priority | Dependencies | Complexity |
|---|-----------|-------------------|----------|--------------|------------|
| 1 | {test-1} | {req-1} | High | {Auth fixture} | Low |
| 2 | {test-2} | {req-2} | Medium | {LoginPage, test data} | Medium |
| 3 | {test-3} | {req-3} | Low | {None} | Low |

#### Resources to Use (from Research)

**Page Objects:**
- [ ] `{LoginPage}` - for authentication
- [ ] `{DashboardPage}` - for navigation
- [ ] _(create new)_ `{NewPage}` - for {purpose}

**Helpers:**
- [ ] `{authHelper}` - for {purpose}
- [ ] _(create new)_ `{newHelper}` - for {purpose}

**Fixtures:**
- [ ] `auth` - provides authenticated session
- [ ] _(create new)_ `{newFixture}` - for {purpose}

**Test Data:**
- [ ] `testUsers.standard` - for regular user tests
- [ ] `testUsers.admin` - for admin-only tests
- [ ] _(create new)_ `{newData}` - for {purpose}

#### New Artifacts to Create

| Artifact Type | Name | Purpose | Estimated Effort |
|---------------|------|---------|-----------------|
| Page Object | {NewPage.ts} | {Purpose} | {Low/Medium/High} |
| Helper | {newHelper.ts} | {Purpose} | {Low/Medium/High} |
| Fixture | {newFixture.ts} | {Purpose} | {Low/Medium/High} |
| Test Data | {newData.ts} | {Purpose} | {Low/Medium/High} |

#### Technical Decisions

**Auth Strategy:** {storageState | uiLogin | none}
- Reason: {why this strategy}

**Base URL:** {environment URL}
- Environment: {local | staging | production}

**Browser:** {chromium | firefox | webkit | all}

**Special Considerations:**
- {consideration-1: e.g., "Requires network mocking for API failures"}
- {consideration-2: e.g., "Needs mobile viewport for responsive tests"}

---

### Stage: WRITE
**Hypothesis:** {what approach are you taking and why?}

**Implementation Order:**
1. {First: Create/update Page Objects}
2. {Second: Create helpers/fixtures if needed}
3. {Third: Write test file}

**Files created/modified:**

| File | Type | Action | Description |
|------|------|--------|-------------|
| `{path/to/NewPage.ts}` | Page Object | Created | {what it provides} |
| `{path/to/helper.ts}` | Helper | Modified | {what changed} |
| `{path/to/file.spec.ts}` | Test | Created | {tests included} |

**Implementation Notes:**
- {note-1}
- {note-2}

**Patterns Applied (from Research):**
- Used: `{pattern-from-quoth}` for {purpose}
- Used: `{pattern-from-knowledge.md}` for {purpose}

---

### Stage: RUN (Attempt 1)
**Command:** `{npx playwright test file.spec.ts}`
**Result:** {PASSED | FAILED}
**Duration:** {Xms}

**If PASSED:**
- All {N} tests passed
- Ready for LEARN stage

**If FAILED:**

| Test | Error Type | Error Message |
|------|------------|---------------|
| {test-name} | {LOCATOR/WAIT/ASSERTION/AUTH/ENV/NETWORK} | {message} |

**Error Category:** {LOCATOR | WAIT | ASSERTION | AUTH | ENV | NETWORK}

**Root Cause Analysis:**
- Immediate cause: {what went wrong}
- Underlying cause: {why it went wrong}
- Similar errors in Exolar: {yes/no - if yes, reference}

**Error Screenshots/Traces:**
- Screenshot: {path or "captured in trace"}
- Trace: {path to trace file}

---

### Stage: FIX (Attempt 1)
**Hypothesis:** {what fix will you try and why?}

**Based on:**
- [ ] Error analysis
- [ ] Quoth pattern: {pattern-id}
- [ ] Exolar historical fix
- [ ] Project knowledge

**Changes:**

| File | Line | Change |
|------|------|--------|
| {file} | {N} | {description} |
| {file} | {N} | {description} |

---

### Stage: RUN (Attempt 2)
**Command:** `{command}`
**Result:** {PASSED | FAILED}

{If failed, repeat FIX → RUN stages}

---

### Stage: LEARN
**Pattern discovered:**
- {description of pattern}

**Reusability:**
- Project-specific: {yes/no}
- Generalizable: {yes/no}

**Added to local knowledge (.triqual/knowledge.md):** {Yes | No}
- Section: {Selectors/Waits/Auth/Gotchas}
- Content: {what was added}

**Proposed to Quoth:** {Yes | No}
- Reason: {why proposed or why not}
- Doc ID (if created): {quoth-doc-id}

---

## Accumulated Learnings (This Feature)

### Selectors
1. {selector-pattern-discovered}
2. {another-selector-pattern}

### Waits
1. {wait-pattern-discovered}
2. {another-wait-pattern}

### Auth
1. {auth-pattern-discovered}

### API/Network
1. {api-pattern-discovered}

### Gotchas
1. {gotcha-discovered}
2. {unexpected-behavior}

### Reusable Code Created
1. {PageObject/Helper/Fixture created and why}

---

## External Research (Required after 2+ same-category failures)

### Quoth Deep Search
**Query:** `{specific error pattern}`
**Patterns Found:**
- {pattern-1: full description}
- {pattern-2: full description}

**Applicable Solution:**
{Which pattern applies and how to apply it}

### Exolar Historical Analysis
**Query:** `failures: {error pattern}`
**Historical Fixes:**

| Date | Test | Similar Error | Fix Applied | Worked? |
|------|------|---------------|-------------|---------|
| {date} | {test} | {error} | {fix} | {yes/no} |

**Recommended Fix Based on History:**
{What fix has worked for similar issues}

---

## Decision Log

| Decision | Rationale | Alternative Considered | Outcome |
|----------|-----------|----------------------|---------|
| {decision-1} | {why} | {alternative} | {result} |
| {decision-2} | {why} | {alternative} | {result} |

---

## Session Summary

**Started:** {timestamp}
**Completed:** {timestamp}
**Total Attempts:** {N}
**Final Result:** {PASSED | FIXME | BLOCKED}

**Key Takeaways:**
1. {takeaway-1}
2. {takeaway-2}
3. {takeaway-3}

**Follow-up Actions:**
- [ ] {action-1: e.g., "Update knowledge.md with wait pattern"}
- [ ] {action-2: e.g., "Create Quoth doc for selector strategy"}
- [ ] {action-3: e.g., "Add to CI pipeline"}
