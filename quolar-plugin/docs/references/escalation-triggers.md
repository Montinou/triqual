# Escalation Triggers - When to Ask vs Act

This document defines when Claude Code should proceed autonomously versus when to stop and ask the user for guidance.

## Core Principle

> **Act like a competent test developer who knows when they need input.**

A skilled developer doesn't ask about every decision, but also doesn't make assumptions about business logic or take destructive actions without confirmation.

---

## Autonomy Matrix

### PROCEED AUTONOMOUSLY ✅

Claude Code should proceed without asking when:

#### 1. Standard Exploration
| Situation | Action |
|-----------|--------|
| Finding test files | Search standard locations, read files |
| Finding Page Objects | Search standard locations, read methods |
| Finding credentials | Search standard locations (.env, fixtures, config) |
| Understanding test structure | Read test files, infer patterns |
| Finding helpers/utilities | Search standard locations, read implementations |

#### 2. Standard Operations
| Situation | Action |
|-----------|--------|
| Opening a URL | Navigate via Playwright MCP |
| Taking screenshots | Capture for analysis |
| Reading page state | Use browser_snapshot |
| Clicking visible elements | Interact to test flow |
| Filling form fields | Enter test data |
| Running existing tests | Execute via Bash |

#### 3. Clear Fixes
| Situation | Action |
|-----------|--------|
| Locator typo | Fix the typo |
| Missing :visible filter | Add it |
| Missing .first() for strict mode | Add it |
| Obvious timeout too short | Use getTimeout() or increase reasonably |
| Missing await | Add it |
| Import missing | Add import statement |

#### 4. Pattern Following
| Situation | Action |
|-----------|--------|
| Project uses Page Objects | Create/use Page Objects for new tests |
| Project has helper functions | Use existing helpers instead of inline code |
| Project has specific naming conventions | Follow them |
| Project has specific locator patterns | Follow them |

---

### ASK FIRST 🛑

Claude Code should stop and ask when:

#### 1. Business Logic Questions
| Situation | Why Ask |
|-----------|---------|
| What should this feature do? | Claude can see UI but not intent |
| Is this behavior correct? | Only user knows expected behavior |
| Which flow is the happy path? | Business decision |
| What data is valid for this field? | Domain knowledge required |
| Should this test exist? | Product decision |

**Example prompt:**
```
I can see the form has these fields: [list].

What's the expected flow for submitting this form?
What validation rules should I test?
```

#### 2. Multiple Valid Approaches
| Situation | Why Ask |
|-----------|---------|
| Two patterns exist in codebase | Which is preferred? |
| New pattern vs existing pattern | Consistency vs improvement |
| Test granularity (unit vs e2e) | Architecture decision |
| Where to place new test file | Organization preference |

**Example prompt:**
```
I see two patterns for authentication in this codebase:
A) Using storageState from global setup
B) Login helper function per test

Which should I use for this new test?
```

#### 3. Non-Standard Situations
| Situation | Why Ask |
|-----------|---------|
| Project structure doesn't match standard patterns | Need to understand custom setup |
| Unusual dependencies or tools | May have special requirements |
| No Page Objects in a large project | Intentional or technical debt? |
| Tests mixed with production code | Unusual, need context |

**Example prompt:**
```
This project doesn't have a page-objects/ directory, but has 50+ test files.

Should I:
A) Create a page-objects/ directory and start using Page Objects
B) Follow the existing pattern of inline locators
C) Something else
```

#### 4. Destructive Actions
| Situation | Why Ask |
|-----------|---------|
| Deleting test files | Irreversible |
| Removing test cases | May lose coverage |
| Modifying shared fixtures | Affects other tests |
| Changing global config | Affects all tests |
| Modifying authentication setup | Could break all authenticated tests |
| Running tests against production | Potentially dangerous |

**Example prompt:**
```
This test file seems to be duplicated by another file.

Should I delete this one, or is there a reason both exist?
```

#### 5. Uncertainty Above Threshold
| Confidence Level | Action |
|------------------|--------|
| >90% confident | Proceed |
| 70-90% confident | Proceed, mention assumption |
| 50-70% confident | Ask first |
| <50% confident | Definitely ask |

**Example prompt:**
```
I'm about to update the locator for the submit button.

Current: `page.locator('.btn-submit')`
Proposed: `page.getByRole('button', { name: 'Submit' })`

I'm 75% confident this is correct based on the screenshot,
but the button text might change based on form state.

Should I proceed or verify first?
```

---

## Escalation Patterns by Workflow

### During Debug Workflow

| Phase | Autonomous | Ask First |
|-------|------------|-----------|
| Reading failing test | ✅ | |
| Opening browser | ✅ | |
| Navigating to page | ✅ | |
| Observing current state | ✅ | |
| Identifying locator issue | ✅ | |
| Fixing obvious locator bug | ✅ | |
| Changing test logic | | 🛑 User should confirm |
| Removing assertions | | 🛑 May reduce coverage |
| Changing expected values | | 🛑 May indicate bug in app |

### During Explore Workflow

| Phase | Autonomous | Ask First |
|-------|------------|-----------|
| Searching Quoth for patterns | ✅ | |
| Opening browser | ✅ | |
| Navigating to feature | ✅ | |
| Clicking through flow | ✅ | |
| Observing states | ✅ | |
| Writing test file | ✅ (following patterns) | |
| Deciding what to assert | | 🛑 Business logic |
| Deciding test scope | | 🛑 Coverage decision |
| Creating new Page Object | ✅ (if pattern exists) | 🛑 (if no pattern) |

### During Bootstrap Workflow

| Phase | Autonomous | Ask First |
|-------|------------|-----------|
| Scanning directories | ✅ | |
| Reading config files | ✅ | |
| Identifying Page Objects | ✅ | |
| Identifying helpers | ✅ | |
| Finding credentials location | ✅ | |
| Generating documentation | ✅ | |
| Uploading to Quoth | | 🛑 Confirm before upload |
| Modifying existing Quoth docs | | 🛑 May override manual edits |

---

## How to Ask Well

### Good Question Format

```
[Context]: What I observed/found
[Options]: Clear choices if applicable
[Recommendation]: My suggestion if I have one
[Question]: Specific question to answer
```

### Examples

**Good:**
```
I found two timeout patterns in the codebase:

1. Hardcoded values: `await page.waitForTimeout(5000)`
2. Timeout manager: `await page.waitForTimeout(getTimeout('medium'))`

Pattern 2 appears in newer tests. Should I:
A) Update all tests to use the timeout manager (recommended)
B) Only use it for new tests
C) Keep using hardcoded values in this test to match surrounding code
```

**Bad:**
```
What timeout should I use?
```

**Good:**
```
The login test is failing because the submit button locator changed.

Current: `page.locator('#submit-btn')`
Actual button on page: `<button class="btn-primary" type="submit">Sign In</button>`

I recommend changing to: `page.getByRole('button', { name: 'Sign In' })`

This follows the project's preference for role-based selectors. Should I proceed?
```

**Bad:**
```
The locator is wrong. Can I fix it?
```

---

## Confidence Calibration

### Signs of High Confidence (proceed)
- Pattern matches documented standard
- Multiple examples in codebase follow same pattern
- Fix is mechanical (typo, missing import, syntax)
- No business logic involved
- Reversible action

### Signs of Low Confidence (ask)
- First time seeing this pattern
- Conflicting patterns in codebase
- Involves understanding user intent
- Could affect other tests
- Irreversible or hard to reverse
- Involves production systems

---

## Emergency Stops

**ALWAYS stop and ask before:**

1. Running tests against production URL
2. Deleting files
3. Modifying environment variables or secrets
4. Changing CI/CD configuration
5. Modifying shared authentication state
6. Making breaking changes to test utilities used by many tests
7. Disabling tests without understanding why they exist
8. Committing or pushing changes

---

## Recovery from Mistakes

If Claude Code takes an action that turns out to be wrong:

1. **Acknowledge** the mistake
2. **Explain** what was assumed incorrectly
3. **Revert** if possible
4. **Learn** - update this document or Quoth if the pattern should be documented
5. **Ask** about similar situations going forward
