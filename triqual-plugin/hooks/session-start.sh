#!/usr/bin/env bash
# Triqual Plugin - SessionStart Hook
# Initializes session, detects active run logs, and provides startup guidance

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

    # Clear any stale awaiting_log_update flags from previous sessions
    clear_awaiting_log_update

    # Build context message
    local context="[Triqual] Test automation initialized."

    # Check for run logs - split into incomplete and completed
    local runs_dir=$(get_runs_dir)

    if [ -d "$runs_dir" ]; then
        local incomplete_logs=""
        local completed_logs=""

        for log in "$runs_dir"/*.md; do
            [ -f "$log" ] || continue
            local feature=$(basename "$log" .md)
            local status=$(get_run_log_status "$feature")

            case "$status" in
                COMPLETED)
                    completed_logs="${completed_logs}  ✅ ${feature}
"
                    ;;
                COMPLETED_NO_LEARNINGS)
                    completed_logs="${completed_logs}  ✅ ${feature} (missing Accumulated Learnings)
"
                    ;;
                IN_PROGRESS:*)
                    local stage="${status#IN_PROGRESS:}"
                    incomplete_logs="${incomplete_logs}  ⏳ ${feature} → last stage: ${stage}
"
                    ;;
            esac
        done

        if [ -n "$incomplete_logs" ]; then
            context="$context

=== INCOMPLETE RUN LOGS ===
${incomplete_logs}
**ACTION:** Read the run log to restore context and continue from the last stage."
        fi

        if [ -n "$completed_logs" ]; then
            context="$context

=== COMPLETED RUNS ===
${completed_logs}"
        fi
    fi

    # Check for knowledge.md
    local knowledge_file=$(get_knowledge_file)
    if [ -f "$knowledge_file" ]; then
        context="$context
Knowledge: $knowledge_file"
    fi

    # Add condensed workflow guidance
    context="$context

FIRST ACTION for /test workflows:
> Use quoth-context agent in session inject mode to load project patterns.
This sets the session flag required by all downstream gates.

Loop: ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN
Run logs: .triqual/runs/{feature}.md
Skills: /test, /check, /rules, /init, /help"

    output_context "$context" "SessionStart"
}

main "$@"
