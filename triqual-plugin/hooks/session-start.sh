#!/usr/bin/env bash
# Triqual Plugin - SessionStart Hook
# Initializes session and provides startup hint

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    local input=$(read_hook_input)

    # Find project config
    local config_path=$(find_triqual_config)
    local project_id=""

    if [ -n "$config_path" ]; then
        project_id=$(get_config_value "project_id" "$config_path")
    fi

    # Initialize session state
    init_session "$project_id"

    # Startup hint with Quoth and Exolar integration - MANDATORY requirements
    local context="[Triqual] Test automation initialized.

MANDATORY REQUIREMENTS:
1. BEFORE writing ANY test code: You MUST call quoth_search_index({ query: \"relevant pattern\" }) to find existing Page Objects, helpers, and test patterns. DO NOT skip this step.
2. AFTER every test run: Report results to Exolar using perform_exolar_action({ action: \"report_execution\" }).
3. If tests fail: Use failure-classifier agent to determine if FLAKE/BUG/ENV before attempting fixes.

Available skills: /quick-test (ad-hoc browser testing), /test-ticket ENG-XXX (generate from Linear), /generate-test (create permanent spec files)"

    output_context "$context" "SessionStart"
}

main "$@"
