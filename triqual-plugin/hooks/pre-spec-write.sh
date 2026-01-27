#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Edit|Write)
# Reminds to check Quoth patterns before writing test files

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

    # Skip non-code files
    if is_non_code_file "$file_path"; then
        log_debug "Skipping non-code file: $file_path"
        output_empty
        exit 0
    fi

    # Only trigger for spec/test files
    if ! is_spec_file "$file_path"; then
        log_debug "Not a spec file: $file_path"
        output_empty
        exit 0
    fi

    # Check if hint already delivered this session
    if hint_delivered_for "pre_edit_spec"; then
        log_debug "pre_edit_spec hint already delivered"
        output_empty
        exit 0
    fi

    # Mark hint as delivered
    mark_hint_delivered "pre_edit_spec"

    # Output Quoth + Exolar integration guidance
    local context="[Triqual] Writing test file detected.

Recommended steps before proceeding:
1. Search for existing patterns: quoth_search_index({ query: \"<feature> playwright patterns\" })
2. Check for similar tests: query_exolar_data({ dataset: \"test_search\", filters: { search: \"<feature>\" } })
3. Review results and reuse existing Page Objects, locators, and helpers

Following existing patterns reduces maintenance debt and improves test reliability."

    output_context "$context" "PreToolUse"
}

main "$@"
