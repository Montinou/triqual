#!/usr/bin/env bash
# Triqual Plugin - Stop Hook
# Cleanup session and provide summary

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    if ! read_hook_input > /dev/null; then
        log_debug "Failed to read hook input"
        output_empty
        exit 0
    fi

    # Check if session exists
    if ! session_exists; then
        log_debug "No session exists, skipping"
        output_empty
        exit 0
    fi

    # Read session data for summary
    local session=$(read_session)

    # Extract tool usage counts
    local quoth_searches="0"
    local exolar_queries="0"

    if has_jq; then
        quoth_searches=$(echo "$session" | jq -r '.tools_used.quoth_search_index // 0' 2>/dev/null || echo "0")
        exolar_queries=$(echo "$session" | jq -r '.tools_used.query_exolar_data // 0' 2>/dev/null || echo "0")
    else
        quoth_searches=$(echo "$session" | grep -o '"quoth_search_index"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*' || echo "0")
        exolar_queries=$(echo "$session" | grep -o '"query_exolar_data"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*' || echo "0")
    fi

    # Ensure we have numeric values
    quoth_searches="${quoth_searches:-0}"
    exolar_queries="${exolar_queries:-0}"

    # Cleanup session
    cleanup_session

    # Output summary - provide helpful reminders without being prescriptive
    local message=""

    if [ "$quoth_searches" = "0" ] && [ "$exolar_queries" = "0" ]; then
        message="[Triqual] Session ended. Tip: If you wrote or modified tests, searching Quoth patterns and checking Exolar for similar tests can help maintain consistency."
    elif [ "$quoth_searches" = "0" ]; then
        message="[Triqual] Session ended. Exolar queries: $exolar_queries. Tip: Quoth pattern searches can help discover reusable Page Objects and helpers."
    elif [ "$exolar_queries" = "0" ]; then
        message="[Triqual] Session ended. Quoth searches: $quoth_searches. Tip: Fetching Exolar history on failures helps identify patterns."
    else
        message="[Triqual] Session ended. Quoth searches: $quoth_searches, Exolar queries: $exolar_queries."
    fi

    output_system_message "$message"
}

main "$@"
