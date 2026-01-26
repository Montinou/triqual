#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Edit|Write)
# Reminds to check Quoth patterns before writing test files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    local input=$(read_hook_input)

    # Extract file path from input
    local file_path=$(extract_file_path "$input")

    # Skip if no file path
    if [ -z "$file_path" ]; then
        output_empty
        exit 0
    fi

    # Skip temp files (quick-test scripts)
    if is_temp_file "$file_path"; then
        output_empty
        exit 0
    fi

    # Skip non-code files
    if is_non_code_file "$file_path"; then
        output_empty
        exit 0
    fi

    # Only trigger for spec/test files
    if ! is_spec_file "$file_path"; then
        output_empty
        exit 0
    fi

    # Check if hint already delivered this session
    if hint_delivered_for "pre_edit_spec"; then
        output_empty
        exit 0
    fi

    # Mark hint as delivered
    mark_hint_delivered "pre_edit_spec"

    # Output Quoth + Exolar integration hint - MANDATORY
    local context="[Triqual] STOP - Writing test file detected.

MANDATORY: Before proceeding, you MUST complete these steps:
1. Call quoth_search_index({ query: \"<feature> playwright patterns\" }) - Find existing Page Objects, locators, and helpers
2. Call query_exolar_data({ dataset: \"test_search\", filters: { search: \"<feature>\" } }) - Check for similar existing tests
3. Review results and REUSE existing patterns - DO NOT create duplicate selectors or helpers

Only proceed with writing the test AFTER completing steps 1-2. Failure to follow existing patterns creates maintenance debt."

    output_context "$context" "PreToolUse"
}

main "$@"
