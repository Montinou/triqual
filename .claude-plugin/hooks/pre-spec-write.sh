#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Edit|Write)
# Reminds to check Quoth patterns before writing test files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    local input="${TOOL_INPUT:-$1}"

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

    # Output Quoth + Exolar integration hint
    local context="[Triqual] Writing test file. BEFORE generating: quoth_search_index({ query: \"playwright test patterns\" }) to find existing Page Objects and helpers. Check query_exolar_data({ dataset: \"test_search\" }) for similar tests."

    output_context "$context"
}

main "$@"
