#!/usr/bin/env bash
# Triqual Plugin - PostToolUse Hook (Bash)
# Reports test results to Exolar and offers healing options

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    read_hook_input > /dev/null
    local input="$_HOOK_INPUT"

    # Extract command from input
    local command=$(extract_command "$input")

    # Skip if not a playwright test command
    if ! is_playwright_test_command "$command"; then
        output_empty
        exit 0
    fi

    # Skip dry-run commands
    if has_dry_run_flag "$command"; then
        output_empty
        exit 0
    fi

    # Check if hint already delivered this session
    if hint_delivered_for "post_test_run"; then
        output_empty
        exit 0
    fi

    # Mark hint as delivered
    mark_hint_delivered "post_test_run"

    # Note: PostToolUse hooks receive tool_result in the JSON, but we provide
    # general guidance rather than parsing the specific output
    local context="[Triqual] Test execution completed.

MANDATORY POST-RUN ACTIONS:
1. Report results to Exolar: perform_exolar_action({ action: \"report_execution\", params: { status: \"passed|failed\", test_count: N } })

IF FAILURES DETECTED:
2. FIRST classify the failure: Use failure-classifier agent OR query_exolar_data({ dataset: \"failure_patterns\" }) to determine if FLAKE/BUG/ENV
3. For FLAKES: Use test-healer agent to auto-fix with retry logic or better selectors
4. For BUGS: Create a Linear ticket, DO NOT modify tests to mask real bugs
5. For ENV issues: Document in Quoth using quoth_propose_update()

DO NOT retry failed tests blindly - always classify first to avoid masking real issues."

    output_context "$context" "PostToolUse"
}

main "$@"
