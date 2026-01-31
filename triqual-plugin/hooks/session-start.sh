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

    # Check for existing context directories
    local triqual_dir=$(get_triqual_dir)
    if [ -d "$triqual_dir/context" ]; then
        local context_features=$(ls "$triqual_dir/context/" 2>/dev/null | head -10)
        if [ -n "$context_features" ]; then
            context="$context

=== CONTEXT FILES AVAILABLE ===
${context_features}
Use force: true to regenerate: triqual_load_context({ feature: \"{name}\", force: true })"
        fi
    fi

    # Add condensed workflow guidance
    context="$context

FIRST ACTION for /test workflows:
Call triqual_load_context({ feature: \"{name}\" }) to build context files before planning.

Loop: ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN
Run logs: .triqual/runs/{feature}.md
Skills: /test, /check, /rules, /init, /help"

    output_context "$context" "SessionStart"
}

main "$@"
