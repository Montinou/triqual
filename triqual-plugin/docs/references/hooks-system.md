# Hook System

> **Category:** Architecture | **Updated:** 2026-02-02

Comprehensive guide to Triqual's hook system that enforces the documented learning loop.

---

## Overview

Triqual uses **9 hooks** to enforce workflow discipline through blocking actions and injecting context. Hooks communicate with Claude using exit codes and stderr messages.

---

## Hook Architecture

### Communication Protocol

```
┌──────────┐    JSON stdin    ┌──────────┐
│  Claude  │─────────────────►│   Hook   │
│   Code   │                  │  Script  │
│          │◄─────────────────│          │
└──────────┘   exit code +    └──────────┘
               stderr message
```

### Input/Output

| Channel | Description |
|---------|-------------|
| **stdin** | JSON with event details (tool name, parameters, etc.) |
| **Environment** | `TRIQUAL_DEBUG`, session variables |
| **Exit Code** | 0 (allow), 1 (block silent), 2 (block + message) |
| **stderr** | Message displayed to Claude (with exit 2) |

---

## Exit Codes

| Code | Effect | Use Case |
|------|--------|----------|
| **0** | Continue - action proceeds | Requirements met, allow action |
| **1** | Block silently | Internal check failed, no message needed |
| **2** | Block + send stderr to Claude | Requirements NOT met, tell Claude what to do |

**Exit code 2** is the enforcement mechanism - hooks block actions AND tell Claude what documentation is needed.

---

## The 9 Hooks

### 1. SessionStart

**Event:** Session begins + after compaction

**Purpose:** Initialize session, detect active run logs, show guidance

**Actions:**
- Creates session state at `~/.cache/triqual/session-state.json`
- Detects active run logs (incomplete tests)
- Suggests reading run logs if found
- Shows "Getting Started" hint (once per session)

**Never Blocks:** Always exit 0

**Example Output:**
```
📋 Active run logs detected:
- .triqual/runs/login.md (WRITE stage - ready to generate)
- .triqual/runs/dashboard.md (RUN stage - needs fixing)

Suggestion: Read these logs to resume work.
```

---

### 2. PreToolUse (Edit/Write) - Spec Write Gate

**Event:** Writing `.spec.ts` file

**Purpose:** **BLOCK** if documentation incomplete

**Checks:**
1. File path in `.draft/` folder (or file already exists)?
2. Run log exists for this feature?
3. Run log has ANALYZE/RESEARCH/PLAN/WRITE stages?
4. Context files exist at `.triqual/context/{feature}/`?

**Blocks (Exit 2) If:**
- Writing to `tests/` directly (not `.draft/`)
- No run log found
- Missing any required stage
- No context files

**Example Block Message:**
```
🚫 BLOCKED: Missing required stages in run log

File: .triqual/runs/login.md

Required stages:
✅ ANALYZE
❌ RESEARCH (missing)
❌ PLAN (missing)
❌ WRITE (missing)

Before writing test code, document:
1. RESEARCH - Search Quoth patterns, check Exolar
2. PLAN - Test strategy, tools to use
3. WRITE - Hypothesis and approach

Then retry this write operation.
```

---

### 3. PreToolUse (Bash) - Retry Gate

**Event:** Before `playwright test` command

**Purpose:** **BLOCK** if retry limits exceeded without research

**Checks:**
1. How many test attempts so far?
2. Same failure category repeated?
3. External research documented (Quoth/Exolar)?
4. Deep analysis at attempt 12?
5. Max attempts (25) reached?

**Blocks (Exit 2) If:**
- 2+ same-category failures without Quoth/Exolar search
- 12+ attempts without deep analysis phase
- 25+ attempts without `.fixme()` or justification

**Example Block Message:**
```
🚫 BLOCKED: Retry limit exceeded without external research

Current: 3 consecutive WAIT failures
Required: Search Quoth for "wait patterns", query Exolar for similar failures

Before retrying, document in run log:
### External Research (Attempt 3)
- Quoth patterns searched: [queries]
- Exolar history checked: [findings]
- Insights applied: [what changed]

Then retry the test.
```

---

### 4. PostToolUse (Bash) - Test Run Flag

**Event:** After `playwright test` command

**Purpose:** Set flag requiring run log update

**Actions:**
- Sets `awaiting_log_update` flag in session state
- Increments attempt counter
- Records test result (passed/failed)

**Never Blocks:** Always exit 0

**Effect:** Next action will be reminded to update run log

---

### 5. SubagentStart - Context Injection

**Event:** Before agent runs

**Purpose:** **INJECT CONTEXT** - tell agent what to read

**Actions:**
- Detects which agent is starting
- Provides file paths to read before acting
- Lists critical context (run log, knowledge.md, context files)

**Never Blocks:** Always exit 0

**Example Output:**
```
🔵 test-healer starting

CRITICAL CONTEXT - Read these files FIRST:
1. .triqual/runs/login.md (run log - current state)
2. .triqual/knowledge.md (project patterns)
3. .triqual/context/login/patterns.md (Quoth patterns)

DO NOT proceed without reading these files.
```

---

### 6. SubagentStop - Next Step Guidance

**Event:** After agent completes

**Purpose:** Guide next step, suggest run log update

**Actions:**
- Detects which agent just finished
- Suggests next step based on agent role
- Reminds to update run log with findings

**Never Blocks:** Always exit 0

**Example Output:**
```
✅ test-planner completed

NEXT STEPS:
1. Update run log with PLAN stage findings
2. Dispatch test-generator to write code
3. Read plan carefully before generating

Suggested: Review .triqual/runs/login.md PLAN stage
```

---

### 7. PreCompact - Preserve State

**Event:** Before context compaction

**Purpose:** Preserve run log state and critical context

**Actions:**
- Saves current stage for each active run log
- Marks critical sections for preservation
- Ensures learnings survive compaction

**Never Blocks:** Always exit 0

---

### 8. Stop - Learnings Check

**Event:** Session ends

**Purpose:** Check for missing accumulated learnings

**Actions:**
- Scans all run logs
- Checks for `## Accumulated Learnings` section
- Reminds to document learnings if missing

**Never Blocks:** Always exit 0 (reminder only)

**Example Output:**
```
⚠️  Run logs missing learnings:
- .triqual/runs/login.md (LEARN stage incomplete)

Before ending session, add:
## Accumulated Learnings
1. [Pattern learned]
2. [Pattern learned]
```

---

### 9. PreToolUse (Draft Promotion) - REMOVED

**Note:** Draft promotion is now **FULLY MANUAL** - hooks do NOT auto-promote. User must explicitly move files from `.draft/` to `tests/`.

---

## Session State

Hooks maintain state at `~/.cache/triqual/`:

### session-state.json

```json
{
  "session_id": "uuid",
  "hints_shown": {
    "getting_started": true,
    "draft_folder": false
  },
  "tool_counts": {
    "Write": 3,
    "Edit": 5,
    "Bash": 12
  },
  "test_runs": {
    "login": {
      "attempts": 2,
      "last_category": "WAIT",
      "passed": false
    }
  },
  "awaiting_log_update": false
}
```

### File Locking

Hooks use flock to prevent race conditions:

```bash
# lib/common.sh
lock_session_state() {
  exec 200>"$LOCK_FILE"
  flock -w 5 200 || exit 1
}
```

---

## Debugging Hooks

### Enable Debug Mode

```bash
export TRIQUAL_DEBUG=true
```

Debug messages appear in stderr:

```
[DEBUG] SessionStart: Initializing session
[DEBUG] Session state: ~/.cache/triqual/session-state.json
[DEBUG] Active run logs: 2 found
```

### Check Hook Execution

```bash
# Verify hooks.json syntax
cat triqual-plugin/hooks/hooks.json | jq

# Check script permissions
ls -l triqual-plugin/hooks/*.sh
```

### Manual Hook Testing

```bash
# Test a hook directly
echo '{"tool":"Write","parameters":{"file_path":"tests/login.spec.ts"}}' | \
  triqual-plugin/hooks/pre-spec-write.sh

# Check exit code
echo $?
```

---

## Hook Dependencies

### Required Files

| File | Purpose |
|------|---------|
| `hooks/hooks.json` | Hook manifest |
| `hooks/lib/common.sh` | Shared functions |
| `hooks/*.sh` | Hook scripts |

### Shared Functions (lib/common.sh)

| Function | Purpose |
|----------|---------|
| `lock_session_state()` | Acquire file lock |
| `unlock_session_state()` | Release file lock |
| `read_session_state()` | Parse JSON state |
| `write_session_state()` | Update JSON state |
| `get_feature_from_path()` | Extract feature name |
| `run_log_exists()` | Check for run log |
| `run_log_has_stage()` | Check stage present |

---

## Example: Full Enforcement Flow

```
User: "Write login test"
    │
    ▼
PreToolUse (pre-spec-write.sh)
    │
    ├─► Check 1: File in .draft/? ❌
    │   └─► BLOCK (exit 2) "Write to .draft/tests/ instead"
    │
User: "Write to .draft/tests/login.spec.ts"
    │
    ▼
PreToolUse (pre-spec-write.sh)
    │
    ├─► Check 1: File in .draft/? ✅
    ├─► Check 2: Run log exists? ❌
    │   └─► BLOCK (exit 2) "Create .triqual/runs/login.md"
    │
User: Creates run log with ANALYZE/RESEARCH/PLAN
    │
    ▼
PreToolUse (pre-spec-write.sh)
    │
    ├─► Check 1: File in .draft/? ✅
    ├─► Check 2: Run log exists? ✅
    ├─► Check 3: All stages present? ✅
    ├─► Check 4: Context files exist? ✅
    │   └─► ALLOW (exit 0)
    │
Write Tool: Creates .draft/tests/login.spec.ts ✅
```

---

## Related Documentation

- [Learning Loop](/docs/learning-loop) - Workflow stages enforced
- [Session State](/docs/session-state) - State persistence
- [Agents Guide](/docs/agents-guide) - Context injection
- [Troubleshooting](/docs/troubleshooting) - Hook debugging

---

**Next Steps:** Read [Learning Loop](/docs/learning-loop) to understand what hooks enforce, or [Troubleshooting](/docs/troubleshooting) if hooks aren't working.
