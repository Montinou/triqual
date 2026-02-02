# Draft Folder Pattern

> **Category:** Workflow | **Updated:** 2026-02-02

Tests are developed in `.draft/` folder ONLY. Promotion to `tests/` requires explicit user approval.

---

## Overview

The draft folder pattern prevents broken tests from entering the codebase. All test development happens in staging (`.draft/`), and promotion is **ENFORCED BY HOOKS** to require user approval.

---

## Directory Structure

```
.draft/
├── tests/
│   └── login.spec.ts            # Work in progress (test-generator creates here)
└── pages/
    └── LoginPage.ts             # New Page Objects (if created)

tests/
└── login.spec.ts                # ONLY after user explicitly approves promotion
```

---

## Workflow Stages

### Stage 1: Development in .draft/

**test-generator** creates files in `.draft/`:

```
.draft/tests/login.spec.ts       (generated)
.draft/pages/DashboardPage.ts    (if needed)
```

**test-healer** works on `.draft/` files:

```
Runs: .draft/tests/login.spec.ts
Edits: .draft/tests/login.spec.ts
Loops: Until PASS or 25 attempts
```

### Stage 2: Success - Healer STOPS

When tests PASS, **test-healer STOPS** (does NOT auto-promote):

```
✅ Tests PASSED (Attempt 3)

🛑 STOPPING - Awaiting user approval for promotion

Review test at:
.draft/tests/login.spec.ts

To promote:
git mv .draft/tests/login.spec.ts tests/login.spec.ts
```

### Stage 3: User Reviews

User reviews the test:

```bash
# Read the test
cat .draft/tests/login.spec.ts

# Check test quality
/check

# Run test locally
npx playwright test .draft/tests/login.spec.ts
```

### Stage 4: Explicit Promotion

User **explicitly approves** promotion:

```bash
# Move to final location
git mv .draft/tests/login.spec.ts tests/login.spec.ts

# If Page Objects created
git mv .draft/pages/DashboardPage.ts pages/DashboardPage.ts
```

---

## Hook Enforcement

### Gate 1: Writing to tests/ Directly BLOCKED

**Hook:** `pre-spec-write.sh`

**Trigger:** Writing `.spec.ts` file

**Check:** Is file path in `.draft/` OR does file already exist?

**If writing to tests/ directly:**

```
🚫 BLOCKED: New test files must be created in .draft/ folder

Attempted: tests/login.spec.ts
Required: .draft/tests/login.spec.ts

The draft folder pattern ensures tests are working before promotion.

To proceed:
1. Write to .draft/tests/login.spec.ts instead
2. After tests pass, user approves promotion
```

**Exit Code:** 2 (block + message)

### Gate 2: Auto-Promotion BLOCKED

**test-healer** does NOT promote automatically on success:

```typescript
// test-healer logic
if (testResult === "PASS") {
  console.log("✅ Tests PASSED");
  console.log("🛑 STOPPING - Awaiting user approval for promotion");
  return; // EXIT - do NOT promote
}
```

---

## Why This Pattern

### Problem: Auto-Promotion Risks

**Without draft folder:**
- Broken tests enter codebase
- CI pipelines break
- Team productivity impacted
- Rollback required

**With draft folder:**
- Tests validated before promotion
- User reviews code quality
- Explicit approval required
- Clean test suite maintained

### Benefits

| Benefit | Description |
|---------|-------------|
| **Quality Gate** | User reviews before promotion |
| **Safe Iteration** | Healer can fix 25 times without polluting codebase |
| **Explicit Approval** | User consciously approves promotion |
| **Clean History** | No broken test commits |
| **CI Protection** | Only working tests reach CI |

---

## Mandatory Code Reuse

**BEFORE creating new Page Objects, helpers, or fixtures**, agents MUST:

### Step 1: Check Context

Read `.triqual/context/{feature}/existing-tests.md`:

```markdown
# Existing Test Resources

## Page Objects Available

- `pages/LoginPage.ts` - Login form interactions
- `pages/DashboardPage.ts` - Dashboard navigation
- `pages/SettingsPage.ts` - User settings

## Helpers Available

- `helpers/auth.ts` - Authentication utilities
- `helpers/api.ts` - API request helpers

## Fixtures Available

- `fixtures/users.json` - Test user accounts
- `fixtures/mock-data.json` - Mock API responses
```

### Step 2: Read Existing Code

```typescript
// Read LoginPage before creating new one
const loginPageContent = await Read("pages/LoginPage.ts");

// Check if it covers the need
if (loginPageContent.includes("login()")) {
  // Reuse existing LoginPage ✅
} else {
  // Create new method in LoginPage (extend existing)
}
```

### Step 3: Reuse or Justify

**Reuse what exists:**

```typescript
// .draft/tests/login.spec.ts
import { LoginPage } from '../pages/LoginPage'; // ✅ REUSE

test('login flow', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.login('user@example.com', 'password'); // ✅ REUSE
});
```

**If creating new, document WHY:**

```markdown
### Stage: WRITE

**New Artifacts Created:**
- `.draft/pages/DashboardPage.ts`

**Justification:**
No existing Page Object covers post-login dashboard interactions.
Checked `context/existing-tests.md` - no DashboardPage found.
```

---

## Promotion Checklist

Before promoting, verify:

- [ ] Tests PASS consistently (run 3+ times)
- [ ] `/check` shows no violations
- [ ] Code reuses existing Page Objects/helpers
- [ ] Run log documents all stages
- [ ] Learnings added to knowledge.md

```bash
# Verify tests pass
npx playwright test .draft/tests/login.spec.ts
npx playwright test .draft/tests/login.spec.ts
npx playwright test .draft/tests/login.spec.ts

# Check quality
/check

# Verify documentation
cat .triqual/runs/login.md | grep "Stage: LEARN"

# Promote
git mv .draft/tests/login.spec.ts tests/login.spec.ts
```

---

## Common Scenarios

### Scenario 1: Multiple Test Files

```bash
.draft/tests/
├── login.spec.ts         (PASS ✅)
├── dashboard.spec.ts     (PASS ✅)
└── settings.spec.ts      (FAIL ❌)

# Promote ready tests
git mv .draft/tests/login.spec.ts tests/
git mv .draft/tests/dashboard.spec.ts tests/

# Keep failing test in draft
# Continue healing settings.spec.ts
```

### Scenario 2: Page Object Created

```bash
.draft/
├── tests/login.spec.ts
└── pages/DashboardPage.ts

# Promote both together
git mv .draft/tests/login.spec.ts tests/
git mv .draft/pages/DashboardPage.ts pages/
```

### Scenario 3: Extend Existing Page Object

```bash
# Instead of creating NEW Page Object
.draft/pages/LoginPage.ts  ❌

# Extend EXISTING Page Object
pages/LoginPage.ts         ✅
  + Add new method
  + Keep existing methods
```

---

## Git Integration

### Recommended .gitignore

```gitignore
# Keep .draft/ tracked (for code review)
# Do NOT ignore .draft/

# Session state (ephemeral)
.cache/triqual/
```

### Branch Workflow

```bash
# Create feature branch
git checkout -b feature/login-tests

# Generate tests (creates .draft/)
/test login

# Tests pass, promote
git mv .draft/tests/login.spec.ts tests/

# Commit promoted tests
git add tests/login.spec.ts
git commit -m "feat: add login flow tests"

# Create PR
gh pr create --title "Add login tests" --body "..."
```

---

## Troubleshooting

### Issue: Hook Not Blocking

**Symptom:** Can write to `tests/` directly

**Check:**
```bash
# Verify hook exists
ls triqual-plugin/hooks/pre-spec-write.sh

# Check executable
chmod +x triqual-plugin/hooks/pre-spec-write.sh

# Test hook
echo '{"tool":"Write","parameters":{"file_path":"tests/new.spec.ts"}}' | \
  triqual-plugin/hooks/pre-spec-write.sh
echo $? # Should be 2 (blocked)
```

### Issue: test-healer Auto-Promotes

**Symptom:** Tests moved to `tests/` automatically

**Check:**
```bash
# Verify test-healer agent definition
grep -A 5 "STOP" triqual-plugin/agents/test-healer.md
```

Should see:
```markdown
When tests PASS:
1. Document LEARN stage
2. STOP (do NOT promote)
3. Await user approval
```

---

## Related Documentation

- [Learning Loop](/docs/learning-loop) - Draft folder gate enforcement
- [Hooks System](/docs/hooks-system) - Hook implementation
- [Agents Guide](/docs/agents-guide) - test-healer behavior
- [Skills Reference](/docs/skills-reference) - /check command

---

**Next Steps:** Read [Hooks System](/docs/hooks-system) to understand enforcement mechanism, or [Agents Guide](/docs/agents-guide) for test-healer logic.
