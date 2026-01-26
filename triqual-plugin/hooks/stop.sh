#!/usr/bin/env bash
# Triqual Plugin - Stop Hook
# Cleanup session and provide summary

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    local input=$(read_hook_input)

    # Check if session exists
    if ! session_exists; then
        output_empty
        exit 0
    fi

    # Read session data for summary
    local session=$(read_session)

    # Extract tool usage counts (simple grep)
    local quoth_searches=$(echo "$session" | grep -o '"quoth_search_index"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*' || echo "0")
    local exolar_queries=$(echo "$session" | grep -o '"query_exolar_data"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*' || echo "0")

    # Cleanup session
    cleanup_session

    # Output summary - warn if mandatory tools weren't used
    if [ "$quoth_searches" -eq 0 ] && [ "$exolar_queries" -eq 0 ]; then
        local context="[Triqual] Session ended. WARNING: No Quoth searches or Exolar queries were made this session. If you wrote or modified tests, you may have missed existing patterns. Consider reviewing Quoth documentation before your next session."
        output_context "$context" "Stop"
    elif [ "$quoth_searches" -eq 0 ]; then
        local context="[Triqual] Session ended. Exolar queries: $exolar_queries. Note: No Quoth pattern searches were made - ensure you're reusing existing Page Objects and helpers."
        output_context "$context" "Stop"
    elif [ "$exolar_queries" -eq 0 ]; then
        local context="[Triqual] Session ended. Quoth searches: $quoth_searches. Note: No Exolar queries were made - remember to report test results and check for similar tests."
        output_context "$context" "Stop"
    else
        local context="[Triqual] Session ended. Quoth searches: $quoth_searches, Exolar queries: $exolar_queries. Good job following the workflow!"
        output_context "$context" "Stop"
    fi
}

main "$@"
