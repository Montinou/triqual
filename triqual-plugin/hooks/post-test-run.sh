#!/usr/bin/env bash
# Triqual Plugin - PostToolUse Hook (Bash)
# Analyzes test results and sets awaiting_log_update flag
#
# This hook fires AFTER a playwright test command completes.
# It instructs Claude to document results before continuing.

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

    # Extract command from input
    local command=$(extract_command "$input")

    # Skip if not a playwright test command
    if ! is_playwright_test_command "$command"; then
        log_debug "Not a playwright command: $command"
        output_empty
        exit 0
    fi

    # Skip dry-run commands
    if has_dry_run_flag "$command"; then
        log_debug "Dry-run command, skipping"
        output_empty
        exit 0
    fi

    # Try to extract test file name from command to identify feature
    local test_file=""
    local feature=""

    # Extract file from command (e.g., "npx playwright test login.spec.ts")
    test_file=$(echo "$command" | grep -oE '[a-zA-Z0-9_-]+\.spec\.(ts|js)' | head -1)
    if [ -n "$test_file" ]; then
        feature=$(extract_feature_name "$test_file")
    fi

    # Try to extract and parse test results from tool_result
    local tool_result=$(extract_tool_result "$input")
    local test_stats=$(parse_test_results "$tool_result")
    local has_failures=false
    local fail_count="0"

    if has_test_failures "$tool_result"; then
        has_failures=true
        fail_count=$(echo "$tool_result" | grep -oE '[0-9]+[[:space:]]+failed' | head -1 | grep -oE '[0-9]+' || echo "?")
    fi

    # Set awaiting_log_update flag - next action will be blocked until log is updated
    set_awaiting_log_update
    log_debug "Set awaiting_log_update flag"

    # Determine run log path
    local run_log=""
    if [ -n "$feature" ]; then
        run_log=$(get_run_log_path "$feature")
    else
        run_log=".triqual/runs/{feature}.md"
    fi

    # Get current attempt number if we can
    local attempt_num="N"
    if [ -n "$feature" ] && run_log_exists "$feature"; then
        attempt_num=$(count_run_attempts "$feature")
        attempt_num=$((attempt_num + 1))
    fi

    # Build context message based on results
    local context=""

    if [ "$has_failures" = "true" ]; then
        # Failures detected
        local stats_msg=""
        if [ -n "$test_stats" ]; then
            stats_msg=" ($test_stats)"
        fi

        context="[Triqual] ⚠️ Test execution completed with failures${stats_msg}.

=== MANDATORY: UPDATE RUN LOG ===

You MUST document these results before any other action.
The next action will be BLOCKED until the run log is updated.

Add to $run_log:

### Stage: RUN (Attempt $attempt_num)
**Command:** \`$command\`
**Result:** FAILED

| Test | Error Type | Error Message |
|------|------------|---------------|
| [test-name] | [category] | [message from output] |

**Category:** [Choose one: LOCATOR | WAIT | ASSERTION | AUTH | ENV | NETWORK]

**Analysis:**
- Root cause: [explanation of why it failed]
- Similar errors in Exolar: [yes/no]

---

### Stage: FIX (Attempt $attempt_num)
**Hypothesis:** [What fix will you try and WHY?]

**Changes:**
- [What you will change]

---

## Error Categories

| Category | Description | Common Fixes |
|----------|-------------|--------------|
| LOCATOR | Element not found | Check selector, add :visible, use data-testid |
| WAIT | Timeout waiting | Add proper wait, use networkidle, increase timeout |
| ASSERTION | Value mismatch | Check expected value, verify test data |
| AUTH | Login/session issue | Refresh storageState, check credentials |
| ENV | Environment problem | Check BASE_URL, verify test environment |
| NETWORK | API/request failed | Check if API is running, mock if needed |

After documenting, if this is the 2nd+ failure of the same category,
you MUST search Quoth and Exolar before retrying."
    else
        # Tests passed
        context="[Triqual] ✓ Test execution completed successfully${test_stats:+ ($test_stats)}.

=== UPDATE RUN LOG ===

Document the successful run in $run_log:

### Stage: RUN (Attempt $attempt_num)
**Command:** \`$command\`
**Result:** PASSED

---

### Stage: LEARN
**Pattern discovered:**
- [What worked well?]
- [Any selector patterns to remember?]
- [Any wait patterns that helped?]

**Added to local knowledge:** [Yes | No]
**Proposed to Quoth:** [Yes - if generalizable | No - if project-specific]

---

## Accumulated Learnings (This Feature)
1. [Key learning from this test development]
2. [Selector pattern that worked]
3. [Wait pattern that worked]

Consider running the triqual-plugin:pattern-learner agent if you discovered reusable patterns."
    fi

    output_context "$context" "PostToolUse"
}

main "$@"
