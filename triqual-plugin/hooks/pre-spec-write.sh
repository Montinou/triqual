#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Edit|Write)
# BLOCKING: Enforces documentation requirements before writing test files
#
# Exit codes:
#   0 - Allow action
#   1 - Block silently
#   2 - Block + stderr message sent to Claude

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    if ! read_hook_input > /dev/null; then
        log_debug "Failed to read hook input"
        output_empty
        exit 0
    fi

    local input="$_HOOK_INPUT"

    # Validate input
    if ! validate_hook_input "$input"; then
        log_debug "Invalid hook input, skipping"
        output_empty
        exit 0
    fi

    # Extract file path from input
    local file_path=$(extract_file_path "$input")

    # Skip if no file path
    if [ -z "$file_path" ]; then
        log_debug "No file_path found in input"
        output_empty
        exit 0
    fi

    # Skip temp files (quick-test scripts)
    if is_temp_file "$file_path"; then
        log_debug "Skipping temp file: $file_path"
        output_empty
        exit 0
    fi

    # Skip non-code files (allow writing run logs, knowledge.md, etc.)
    if is_non_code_file "$file_path"; then
        log_debug "Skipping non-code file: $file_path"
        # Clear awaiting_log_update flag if a run log was just updated
        if echo "$file_path" | grep -q "\.triqual/runs/"; then
            clear_awaiting_log_update
            log_debug "Cleared awaiting_log_update flag - run log updated"
        fi
        output_empty
        exit 0
    fi

    # Only enforce for spec/test files
    if ! is_spec_file "$file_path"; then
        log_debug "Not a spec file: $file_path"
        output_empty
        exit 0
    fi

    # Extract feature name
    local feature=$(extract_feature_name "$file_path")
    log_debug "Feature: $feature, File: $file_path"

    if [ -z "$feature" ]; then
        log_debug "Could not extract feature name"
        output_empty
        exit 0
    fi

    local run_log=$(get_run_log_path "$feature")
    local runs_dir=$(get_runs_dir)

    # =========================================================================
    # GATE 1: Check awaiting_log_update flag (from previous test run)
    # =========================================================================
    if is_awaiting_log_update; then
        # Check if ANY run log was recently updated
        if any_run_log_recently_updated 60; then
            clear_awaiting_log_update
            log_debug "Cleared awaiting_log_update - recent log update detected"
        else
            cat >&2 << EOF
🚫 BLOCKED: Test results not documented

A test run was executed but results have not been documented.

Before writing more code, you MUST update the run log with:
1. **RUN stage:** Command executed, result (PASSED/FAILED)
2. **If failed:** Error category (LOCATOR/WAIT/ASSERTION/AUTH/ENV/NETWORK)
3. **If failed:** Root cause analysis
4. **FIX stage:** Your hypothesis for the fix (if fixing)

Update the run log at: $run_log
Then retry this action.
EOF
            exit 2
        fi
    fi

    # =========================================================================
    # GATE 2: Run log must exist
    # =========================================================================
    if ! run_log_exists "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: No run log found for "$feature"

Before writing test code, you MUST create a run log at:
$run_log

**Required content:**

1. Create the runs directory if needed:
   mkdir -p $runs_dir

2. Create the run log with these stages:

### Stage: ANALYZE
- Review feature requirements
- List acceptance criteria
- Identify user flows to test

### Stage: RESEARCH
- Search Quoth for patterns: quoth_search_index({ query: "$feature playwright patterns" })
- Check Exolar for similar tests
- Review existing Page Objects and helpers
- Check .triqual/knowledge.md for project conventions

### Stage: PLAN
- Document test strategy
- List tests to create with priorities
- List Page Objects, helpers, fixtures, test data to use
- Identify new artifacts to create

### Stage: WRITE
**Hypothesis:** [What approach are you taking and why?]

Then retry this write operation.
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 3: ANALYZE stage must exist
    # =========================================================================
    if ! analyze_stage_exists "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: Run log missing ANALYZE stage

Before writing test code, document your analysis in $run_log:

### Stage: ANALYZE
**Feature:** $feature
**Objective:** [What this test should verify]

#### Test Requirements Analysis
- [ ] Read feature/ticket requirements
- [ ] Identify acceptance criteria
- [ ] List user flows to cover

**Acceptance Criteria:**
1. [criterion from requirements]
2. [criterion from requirements]

**User Flows:**
1. [Happy path]
2. [Error case]
3. [Edge case]

This ensures you understand WHAT to test before HOW to test.
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 4: RESEARCH stage must exist
    # =========================================================================
    if ! research_stage_exists "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: Run log missing RESEARCH stage

Before writing test code, document your research in $run_log:

### Stage: RESEARCH
- [ ] Searched Quoth for patterns
- [ ] Checked Exolar for similar tests
- [ ] Reviewed existing Page Objects
- [ ] Checked project knowledge.md

**Quoth Search:**
- Query: "$feature playwright patterns"
- Results: [patterns found]

**Available Resources:**

| Resource | Path | Purpose |
|----------|------|---------|
| [Page Object] | [path] | [what it provides] |
| [Helper] | [path] | [what it provides] |
| [Fixture] | [path] | [what it provides] |
| [Test Data] | [path] | [what it provides] |

**Findings:**
- [What patterns exist?]
- [What can be reused?]
- [What needs to be created?]

Run these searches now:
1. quoth_search_index({ query: "$feature playwright patterns" })
2. query_exolar_data({ dataset: "test_search", filters: { search: "$feature" } })
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 4.5: QUOTH CONTEXT MUST BE LOADED (Mandatory - No Skip Allowed)
    # =========================================================================
    if ! quoth_context_invoked && ! quoth_search_documented "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: Quoth context not loaded

**MANDATORY — NO SKIP ALLOWED.** You MUST load Quoth context BEFORE writing test code.

The RESEARCH stage exists but there is no evidence that Quoth patterns were loaded.

**IMMEDIATE ACTION — Do ONE of these NOW:**

1. **Invoke quoth-context agent** (REQUIRED):
   > Use quoth-context agent to research patterns for '$feature' (pre-agent research mode)

   This sets the session flag that unblocks this gate.

2. **Or search Quoth manually and document results in $run_log:**
   \`\`\`
   mcp__quoth__quoth_search_index({
     query: "$feature playwright patterns"
   })
   \`\`\`

   Then add to RESEARCH stage:

   #### Quoth Search Results
   **Query:** \`$feature playwright patterns\`
   **Patterns Found:**
   - pattern-name: description
   - another-pattern: description

**This gate CANNOT be skipped.** Quoth contains proven patterns that prevent
common mistakes and reduce fix iterations. Load context, then retry.
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 5: PLAN stage must exist
    # =========================================================================
    if ! plan_stage_exists "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: Run log missing PLAN stage

Before writing test code, document your test plan in $run_log:

### Stage: PLAN
**Test Strategy:** [Approach description]

#### Test Plan

| Test Case | Priority | Dependencies | Complexity |
|-----------|----------|--------------|------------|
| [test-1] | High | [dependencies] | Low |
| [test-2] | Medium | [dependencies] | Medium |

**Tools & Resources to Use:**
- [ ] Page Objects: [list]
- [ ] Helpers: [list]
- [ ] Fixtures: [list]
- [ ] Test Data: [list]

**New Artifacts to Create:**
- [ ] [new artifact if needed]

**Auth Strategy:** [storageState | uiLogin | none]
**Base URL:** [environment URL]

This ensures you have a clear plan before implementation.
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 6: WRITE stage with hypothesis must exist
    # =========================================================================
    if ! write_stage_exists "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: Run log missing WRITE stage with hypothesis

Before proceeding, add to $run_log:

### Stage: WRITE
**Hypothesis:** [What approach are you taking and why?]

Example:
**Hypothesis:** Will use existing LoginPage for auth, create new DashboardPage
for dashboard assertions. Using storageState for faster test execution.
Will focus on happy path first, then add error cases.

**Files to create/modify:**
- tests/$feature.spec.ts - Main test file
- pages/[NewPage].ts - New Page Object (if needed)

Document your hypothesis, then retry this write operation.
EOF
        exit 2
    fi

    # All gates passed - allow the write
    log_debug "All documentation gates passed for $feature"

    # Check if hint already delivered this session (for the reminder message)
    if hint_delivered_for "pre_edit_spec"; then
        output_empty
        exit 0
    fi

    # Mark hint as delivered
    mark_hint_delivered "pre_edit_spec"

    # Output confirmation that documentation is complete
    local context="[Triqual] ✓ Documentation requirements met for '$feature'.

Run log verified at: $run_log
- ANALYZE stage: ✓
- RESEARCH stage: ✓
- PLAN stage: ✓
- WRITE hypothesis: ✓

Proceeding with test file write. Remember to update the run log after running tests."

    output_context "$context" "PreToolUse"
    exit 0
}

main "$@"
