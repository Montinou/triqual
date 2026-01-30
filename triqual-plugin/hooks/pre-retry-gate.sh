#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Bash - playwright test retry gate)
# BLOCKING: Enforces retry limits and external research requirements
#
# Exit codes:
#   0 - Allow action
#   1 - Block silently
#   2 - Block + stderr message sent to Claude
#
# This hook fires BEFORE a playwright test command executes.
# It checks the run log for:
# - 2+ same-category failures -> require Quoth/Exolar search
# - 12+ total attempts -> require DEEP ANALYSIS phase
# - 25+ total attempts -> require .fixme() or justification

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin
    if ! read_hook_input > /dev/null; then
        log_debug "Failed to read hook input"
        exit 0
    fi

    local input="$_HOOK_INPUT"

    # Validate input
    if ! validate_hook_input "$input"; then
        log_debug "Invalid hook input, skipping"
        exit 0
    fi

    # Extract command from input
    local command=$(extract_command "$input")

    # Only trigger for playwright test commands
    if ! is_playwright_test_command "$command"; then
        log_debug "Not a playwright command: $command"
        exit 0
    fi

    # Skip dry-run commands
    if has_dry_run_flag "$command"; then
        log_debug "Dry-run command, skipping"
        exit 0
    fi

    # Try to extract test file name from command to identify feature
    local test_file=""
    local feature=""

    test_file=$(echo "$command" | grep -oE '[a-zA-Z0-9_-]+\.spec\.(ts|js)' | head -1)
    if [ -n "$test_file" ]; then
        feature=$(extract_feature_name "$test_file")
    fi

    # If we can't identify the feature, allow the test to run
    if [ -z "$feature" ]; then
        log_debug "Could not extract feature name from command"
        exit 0
    fi

    # Check if run log exists
    if ! run_log_exists "$feature"; then
        log_debug "No run log for $feature, allowing test"
        exit 0
    fi

    local run_log=$(get_run_log_path "$feature")

    # =========================================================================
    # GATE 0: Quoth context must be loaded before first test run
    # Only enforced when a run log exists (within /test workflow)
    # =========================================================================
    if ! quoth_context_invoked; then
        cat >&2 << EOF
🚫 BLOCKED: Quoth context not loaded before test run

**MANDATORY:** You MUST invoke the quoth-context agent BEFORE running tests.

The run log for '$feature' exists, which means you are in the /test workflow.
Quoth context loading is **required** before executing any test.

**IMMEDIATE ACTION:**

> Use quoth-context agent to research patterns for '$feature' (pre-agent research mode)

This sets the session flag that unblocks test execution.

**Why:** Quoth patterns prevent common test failures. Loading context first
reduces fix iterations and avoids reinventing solutions that already exist.

After quoth-context completes, retry the test command.
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 1: Check for repeated same-category failures (2+)
    # =========================================================================
    local locator_fails=$(count_failures_by_category "$feature" "LOCATOR")
    local wait_fails=$(count_failures_by_category "$feature" "WAIT")
    local assertion_fails=$(count_failures_by_category "$feature" "ASSERTION")
    local auth_fails=$(count_failures_by_category "$feature" "AUTH")
    local env_fails=$(count_failures_by_category "$feature" "ENV")
    local network_fails=$(count_failures_by_category "$feature" "NETWORK")

    local repeated_category=""
    local repeated_count=0

    if [ "$locator_fails" -ge 2 ]; then
        repeated_category="LOCATOR"
        repeated_count=$locator_fails
    elif [ "$wait_fails" -ge 2 ]; then
        repeated_category="WAIT"
        repeated_count=$wait_fails
    elif [ "$assertion_fails" -ge 2 ]; then
        repeated_category="ASSERTION"
        repeated_count=$assertion_fails
    elif [ "$auth_fails" -ge 2 ]; then
        repeated_category="AUTH"
        repeated_count=$auth_fails
    elif [ "$env_fails" -ge 2 ]; then
        repeated_category="ENV"
        repeated_count=$env_fails
    elif [ "$network_fails" -ge 2 ]; then
        repeated_category="NETWORK"
        repeated_count=$network_fails
    fi

    if [ -n "$repeated_category" ] && ! external_research_exists "$feature"; then
        cat >&2 << EOF
🚫 BLOCKED: Same error category ($repeated_category) failed $repeated_count times

Before retrying, you MUST perform external research:

1. **Search Quoth** for this error pattern:
   quoth_search_index({ query: "$repeated_category error playwright fix" })

2. **Query Exolar** for historical fixes:
   query_exolar_data({ dataset: "failures", filters: { error_pattern: "$repeated_category" } })

3. **Document findings** in $run_log:

## External Research (Required after 2+ same-category failures)

### Quoth Search
**Query:** $repeated_category error playwright fix
**Patterns Found:**
- [pattern-1]
- [pattern-2]

### Exolar Query
**Query:** failures with $repeated_category
**Historical Fixes:**
- [fix-1 from similar failure]
- [fix-2 from similar failure]

**New Hypothesis Based on Research:**
[What will you try differently based on external research?]

---

After documenting external research, retry the test.
EOF
        exit 2
    fi

    # =========================================================================
    # GATE 2: Check for deep analysis requirement (5+ attempts)
    # =========================================================================
    local total_attempts=$(count_run_attempts "$feature")

    if [ "$total_attempts" -ge 12 ] && [ "$total_attempts" -lt 25 ]; then
        # Check if deep analysis is documented
        if ! grep -q "### Stage: DEEP ANALYSIS" "$run_log" 2>/dev/null; then
            cat >&2 << EOF
🚫 BLOCKED: Deep analysis required after 11 failed attempts

You have made $total_attempts attempts to fix '$feature'.

Before attempting again, you MUST perform **DEEP ANALYSIS**:

1. **Extended Quoth Search** - Broader pattern search:
   quoth_search_index({ query: "playwright $feature patterns best practices" })
   quoth_search_index({ query: "flaky test stabilization $feature" })

2. **Exolar Historical Data** - Query failure history:
   query_exolar_data({ dataset: "test_history", filters: { test_signature: "$feature" } })
   query_exolar_data({ dataset: "failure_patterns", filters: { error_type: "$feature" } })

3. **App Exploration** - Use Playwright MCP to understand actual behavior:
   browser_navigate({ url: "{page-url}" })
   browser_snapshot({})

4. **Document in run log**:

### Stage: DEEP ANALYSIS (Attempt 12)
**Timestamp:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Reason:** 4 fix attempts failed, expanding search

#### Extended Quoth Search
**Queries:**
- {query-1}: {results}
- {query-2}: {results}

#### Exolar Historical Data
- Test failure history: {summary}
- Similar failure patterns: {summary}

#### App Exploration
- Actual page structure: {findings}
- Selector discrepancies: {findings}

#### Alternative Approaches
1. {Approach 1} - {rationale}
2. {Approach 2} - {rationale}
3. {Approach 3} - {rationale}

**Selected Approach:** {N} - {why this is most likely to work}

---

After documenting deep analysis, retry the test with your new approach.
EOF
            exit 2
        fi
    fi

    # =========================================================================
    # GATE 3: Check for max attempts (25+)
    # =========================================================================
    if [ "$total_attempts" -ge 25 ]; then
        # Check if .fixme() is documented or justification exists
        if ! fixme_documented "$feature"; then
            # Check for explicit justification
            if ! grep -qi "justification for attempt" "$run_log" 2>/dev/null; then
                cat >&2 << EOF
🚫 BLOCKED: Maximum 25 attempts reached for '$feature'

You have made $total_attempts attempts to fix this test.

**This is the maximum allowed.** Before attempting again, you MUST either:

**OPTION 1: Mark as .fixme()** (Recommended)
Add to the run log:

### Decision: Mark as .fixme()
**Reason:** [Why this test cannot be fixed after 25 attempts]
**Summary of Attempts:**
1. [fix-1]: [result]
2. [fix-2]: [result]
...
8. [fix-8]: [result]

**Blockers:**
- [blocker-1]
- [blocker-2]

**Test code to add:**
\`\`\`typescript
test.fixme('test name', async ({ page }) => {
  // FIXME: 8 auto-heal attempts failed
  // Last error: [error]
  // Run log: .triqual/runs/$feature.md
});
\`\`\`

---

**OPTION 2: Justify another attempt** (Requires strong justification)
Add to the run log:

### Justification for Attempt $((total_attempts + 1))
**Critical New Information:** [What fundamentally changed?]
**Why 8 Previous Fixes ALL Failed:** [Root cause analysis]
**New Approach (Fundamentally Different):**
[This must be a completely different strategy, not an incremental tweak]

**Confidence Level:** [Must be High with strong evidence]
**Evidence:** [Concrete proof this will work]

---

After 25 attempts, marking as .fixme() is usually the right choice.
Create a Linear ticket to investigate this as a potential bug.
EOF
                exit 2
            fi
        fi
    fi

    # All gates passed
    log_debug "Retry gates passed for $feature (attempts: $total_attempts of 25 max)"
    exit 0
}

main "$@"
