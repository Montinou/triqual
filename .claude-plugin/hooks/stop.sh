#!/usr/bin/env bash
# Quolar Plugin - Stop Hook
# Cleanup session and provide summary

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
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

    # Only output summary if tools were used
    if [ "$quoth_searches" -gt 0 ] || [ "$exolar_queries" -gt 0 ]; then
        local context="[Quolar] Session ended. Quoth searches: $quoth_searches, Exolar queries: $exolar_queries"
        output_context "$context"
    else
        output_empty
    fi
}

main "$@"
