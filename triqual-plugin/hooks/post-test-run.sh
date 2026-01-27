#!/usr/bin/env bash
# Triqual Plugin - PostToolUse Hook (Bash)
# Analyzes test results and offers next steps

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

    # Check if hint already delivered this session
    if hint_delivered_for "post_test_run"; then
        log_debug "post_test_run hint already delivered"
        output_empty
        exit 0
    fi

    # Mark hint as delivered
    mark_hint_delivered "post_test_run"

    # Try to extract and parse test results from tool_result
    local tool_result=$(extract_tool_result "$input")
    local test_stats=$(parse_test_results "$tool_result")
    local has_failures=false

    if has_test_failures "$tool_result"; then
        has_failures=true
    fi

    # Build context message based on results
    local context=""

    if [ "$has_failures" = "true" ]; then
        # Failures detected - recommend failure-classifier
        local stats_msg=""
        if [ -n "$test_stats" ]; then
            stats_msg=" ($test_stats)"
        fi

        context="[Triqual] Test execution completed with failures${stats_msg}.

Recommended next steps:
1. Fetch similar failures from Exolar: query_exolar_data({ dataset: \"failures\", filters: { error_pattern: \"...\" } })
   - This reveals if this is a known flake or recurring issue

2. Use Playwright MCP to explore the app and verify actual behavior
   - Navigate to the failing page, inspect state, compare expected vs actual

3. Classify the failure: Use failure-classifier agent to determine if FLAKE/BUG/ENV/TEST_ISSUE
   - This helps decide whether to auto-heal or report a bug

4. For FLAKE or TEST_ISSUE: Consider using test-healer agent to apply fixes
5. For BUG: Create a Linear ticket - do not modify tests to mask real bugs

Would you like me to run the failure-classifier agent to analyze these failures?"
    else
        # Tests passed or no result info
        context="[Triqual] Test execution completed.

Recommended next steps:
1. If any tests were flaky, check Exolar for patterns: query_exolar_data({ dataset: \"flaky_tests\", filters: { test_file: \"...\" } })
2. Document successful patterns in Quoth for future reuse"
    fi

    output_context "$context" "PostToolUse"
}

main "$@"
