#!/usr/bin/env bash
# Triqual Plugin - Stop Hook
# Cleanup session and enforce final documentation requirements

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

    # Clear any awaiting flags
    clear_awaiting_log_update

    # Check for run logs that need final documentation
    local latest_log=$(get_latest_run_log)
    local needs_learnings=false
    local feature=""

    if [ -n "$latest_log" ]; then
        feature=$(basename "$latest_log" .md)
        if ! has_accumulated_learnings "$feature"; then
            needs_learnings=true
        fi
    fi

    # Build message
    local message=""

    if [ "$needs_learnings" = "true" ]; then
        message="[Triqual] ⚠️ Session ending - documentation incomplete

=== FINAL DOCUMENTATION REQUIRED ===

The run log at: $latest_log
is missing the Accumulated Learnings section.

Before ending, please add:

## Accumulated Learnings (This Feature)

### Selectors
1. [What selector patterns worked?]
2. [What selector patterns to avoid?]

### Waits
1. [What wait patterns were needed?]
2. [Known slow operations?]

### Auth
1. [Any auth discoveries?]

### Gotchas
1. [Unexpected behaviors discovered?]
2. [Things that might trip up future tests?]

---

Also consider:
- Update .triqual/knowledge.md with generalizable patterns
- Run **triqual-plugin:pattern-learner** agent to extract patterns across run logs
- Use pattern-learner's Quoth capture capability to propose generalizable patterns via \`quoth_propose_update\`

---

Session stats: Quoth searches: $quoth_searches, Exolar queries: $exolar_queries"
    else
        # All documentation complete
        message="[Triqual] Session ended.

"
        if [ -n "$latest_log" ]; then
            message="${message}✓ Run log documented: $latest_log
"
        fi

        message="${message}Session stats: Quoth searches: $quoth_searches, Exolar queries: $exolar_queries

"

        if [ "$quoth_searches" = "0" ] && [ "$exolar_queries" = "0" ]; then
            message="${message}Tip: Call triqual_load_context({ feature: \"...\" }) at session start to load project patterns from Quoth and knowledge.md."
        elif [ "$quoth_searches" = "0" ]; then
            message="${message}Tip: Call triqual_load_context({ feature: \"...\" }) to discover reusable patterns and Page Objects from Quoth."
        elif [ "$exolar_queries" = "0" ]; then
            message="${message}Tip: Exolar queries help identify flaky tests and historical fix patterns."
        fi

        # Check knowledge.md status
        if knowledge_file_exists; then
            message="${message}

✓ Project knowledge file exists. Consider updating it with session learnings."
        else
            message="${message}

💡 Consider creating .triqual/knowledge.md to persist project-specific patterns."
        fi
    fi

    # Cleanup session state (but keep run logs - they're persistent)
    cleanup_session

    output_system_message "$message"
}

main "$@"
