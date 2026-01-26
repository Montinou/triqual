#!/usr/bin/env bash
# Quolar Plugin - PostToolUse Hook (Bash)
# Reports test results to Exolar and offers healing options

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    local input="${TOOL_INPUT:-$1}"
    local output="${TOOL_OUTPUT:-}"

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

    # Check for failures in output
    local has_failures=false
    if [[ "$output" =~ "failed" ]] || [[ "$output" =~ "Error:" ]] || [[ "$output" =~ "FAILED" ]]; then
        has_failures=true
    fi

    # Build response based on results
    local context=""

    if [ "$has_failures" = true ]; then
        # Failures detected - offer Exolar reporting and healing
        context="[Quolar] Test failures detected. Options: (1) Analyze with failure-classifier agent to classify as FLAKE/BUG/ENV (2) Auto-heal with test-healer agent (asks before fixing) (3) Report to Exolar: perform_exolar_action({ action: \"report_execution\", params: { failures: [...] } })"
    else
        # All passed - brief confirmation with Exolar reporting hint
        context="[Quolar] Tests passed. Report to Exolar: perform_exolar_action({ action: \"report_execution\", params: { passed: true } })"
    fi

    output_context "$context"
}

main "$@"
