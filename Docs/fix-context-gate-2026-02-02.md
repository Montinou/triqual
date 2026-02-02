# Fix: Context Loading Hook - From Blocking to Advisory

**Date:** 2026-02-02
**Version:** Triqual Plugin 1.2.0
**Issue:** Hook was blocking ALL test runs when context files didn't exist

## Problem

The `pre-retry-gate.sh` hook's Gate 0 was blocking ALL `npx playwright test` commands when `.triqual/context/{feature}/` didn't exist, including:
- Existing, working tests
- Manual test runs for debugging
- Verification runs

This was overly aggressive and prevented legitimate test execution.

## Solution Implemented

### Changed: pre-retry-gate.sh

**Removed:** Gate 0 (lines 72-100) - BLOCKING context enforcement
**Added:** Advisory message (non-blocking) at lines 72-88

#### Before (Gate 0 - BLOCKING)
```bash
if ! context_files_exist "$feature"; then
    cat >&2 << EOF
🚫 BLOCKED: Context files not loaded before test run
...
EOF
    exit 2  # BLOCKS the test run
fi
```

#### After (Advisory - NON-BLOCKING)
```bash
if ! context_files_exist "$feature"; then
    # Only show once per session per feature
    if ! has_shown_hint "context_reminder_$feature"; then
        cat >&2 << EOF
💡 TIP: Consider loading context for better test healing:
   triqual_load_context({ feature: "$feature" })

Context files contain proven patterns from Quoth and project history,
which can help reduce fix iterations. This is optional for running
existing tests but recommended for better results.
EOF
        mark_hint_shown "context_reminder_$feature"
    fi
fi
# Continues with exit 0 at end
```

## Context Enforcement Still Works

Context loading is STILL enforced when writing NEW test files via `pre-spec-write.sh` Gate 4.5:

**File:** `pre-spec-write.sh`
**Gate 4.5:** CONTEXT FILES MUST EXIST (Mandatory - No Skip Allowed)

```bash
if ! context_files_exist "$feature"; then
    cat >&2 << EOF
🚫 BLOCKED: Context files not loaded for "$feature"
...
EOF
    exit 2  # BLOCKS writing new test files
fi
```

## Verification

### Test 1: Running Tests Without Context (Should Pass)
```bash
npx playwright test tests/login.spec.ts
# Expected: Exit 0 (allowed to run)
# Result: ✅ Exit 0
```

### Test 2: Writing Tests Without Context (Should Block)
```bash
# Attempt to create new test file without context
# Expected: 🚫 BLOCKED by pre-spec-write.sh Gate 4.5
# Result: ✅ Still enforced
```

### Test 3: Load Context, Then Write (Should Pass)
```bash
triqual_load_context({ feature: "new-feature" })
# Now can write new test
# Expected: ✅ Allowed
```

## File Backup

Original file backed up to:
```
/Users/agustinmontoya/.claude/plugins/cache/triqual/triqual-plugin/1.2.0/hooks/pre-retry-gate.sh.backup
```

## Impact

| Behavior | Before | After |
|----------|--------|-------|
| Run existing tests | ❌ Blocked | ✅ Allowed |
| Write new tests without context | ❌ Blocked | ❌ Blocked (still) |
| Load context before writing | ✅ Required | ✅ Required (still) |
| Advisory message for context | ❌ No | ✅ Yes (once per session) |

## Summary

- **Fixed:** Users can now run existing tests without being blocked
- **Preserved:** Context enforcement when writing NEW test files (via pre-spec-write.sh)
- **Added:** Helpful advisory message suggests context loading (non-blocking)
- **Result:** Balanced approach - guidance without obstruction

## Remaining Gates in pre-retry-gate.sh

The hook still enforces:
- **Gate 1:** External research after 2+ same-category failures
- **Gate 2:** Deep analysis after 12+ attempts
- **Gate 3:** Max attempts limit (25) with .fixme() requirement

These gates remain BLOCKING (exit 2) as intended.
