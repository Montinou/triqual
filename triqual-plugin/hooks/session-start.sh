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

    # Check if Playwright Agents need initialization
    local agents_status=""
    if [ -d "${PWD}/.agents" ]; then
        agents_status="Playwright Agents: initialized"
    else
        agents_status="Playwright Agents: not found (run 'npx playwright init-agents --loop=claude' for autonomous testing)"
    fi

    # Startup guidance with Quoth, Exolar, and Playwright MCP integration
    local context="[Triqual] Test automation initialized.

${agents_status}

Recommended workflow:
1. Before writing test code: Search for existing patterns with quoth_search_index({ query: \"relevant pattern\" })
2. When tests fail: Fetch historic results from Exolar to find similar failures
3. Use Playwright MCP to explore the app and verify actual behavior vs expected
4. Use failure-classifier agent to determine if FLAKE/BUG/ENV before attempting fixes

Available skills:
- /test login        (full autonomous: explore → plan → generate → heal → learn)
- /test --explore    (interactive browser exploration)
- /test --ticket     (generate from Linear ticket)
- /test --describe   (generate from description)
- /check             (lint tests for best practices)
- /rules             (view best practice documentation)
- /init              (initialize project config)

Tip: If Quoth/Exolar searches fail, verify MCP is connected with /mcp"

    output_context "$context" "SessionStart"
}

main "$@"
