#!/usr/bin/env bash
# Quolar Plugin - SessionStart Hook
# Initializes session and provides startup hint

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Find project config
    local config_path=$(find_quolar_config)
    local project_id=""

    if [ -n "$config_path" ]; then
        project_id=$(get_config_value "project_id" "$config_path")
    fi

    # Initialize session state
    init_session "$project_id"

    # Startup hint with Quoth and Exolar integration
    local context="[Quolar] Test automation ready. Before writing tests: quoth_search_index({ query: \"playwright patterns\" }). After test runs: results auto-reported to Exolar. Skills: /quick-test, /test-ticket, /generate-test"

    output_context "$context"
}

main "$@"
