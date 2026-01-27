#!/usr/bin/env bash
# Triqual Plugin - SessionStart Hook
# Initializes session and provides startup guidance

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

    # Find project config
    local config_path=$(find_triqual_config)
    local project_id=""

    if [ -n "$config_path" ]; then
        project_id=$(get_config_value "project_id" "$config_path")
    fi

    # Initialize session state
    if ! init_session "$project_id"; then
        log_debug "Failed to initialize session"
    fi

    # Startup guidance with Quoth and Exolar integration
    local context="[Triqual] Test automation initialized.

Recommended workflow:
1. Before writing test code: Search for existing patterns with quoth_search_index({ query: \"relevant pattern\" })
2. After test runs: Report results to Exolar using perform_exolar_action({ action: \"report_execution\" })
3. If tests fail: Use failure-classifier agent to determine if FLAKE/BUG/ENV before attempting fixes

Available skills: /quick-test (ad-hoc browser testing), /test-ticket ENG-XXX (generate from Linear), /generate-test (create permanent spec files)

Tip: If Quoth/Exolar searches fail, verify MCP is connected with /mcp"

    output_context "$context" "SessionStart"
}

main "$@"
