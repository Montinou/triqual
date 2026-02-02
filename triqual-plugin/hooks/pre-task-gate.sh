#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Task tool gate)
# BLOCKING: Prevents test-planner dispatch without context files
#
# This is the earliest possible enforcement point — before the subagent spawns.
# If context files have not been built yet, test-planner dispatch is blocked.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    if ! read_hook_input > /dev/null; then
        exit 0  # fail-open
    fi

    local input="$_HOOK_INPUT"
    if ! validate_hook_input "$input"; then
        exit 0
    fi

    # Detect if this Task dispatches test-planner
    local agent_type
    agent_type=$(extract_task_agent_type "$input")

    # Match both plain and fully-qualified agent name
    case "$agent_type" in
        *test-planner*) ;;  # Continue to context check
        *) exit 0 ;;        # Not test-planner, allow through
    esac

    log_debug "Task gate: test-planner dispatch detected, checking context files"

    # Extract feature from prompt
    local feature
    feature=$(extract_feature_from_prompt "$input")

    if [ -z "$feature" ]; then
        log_debug "Could not extract feature name from prompt, allowing through"
        exit 0
    fi

    # Check if context files exist
    if context_files_exist "$feature"; then
        log_debug "test-planner dispatch allowed - context files exist for $feature"
        exit 0
    fi

    # BLOCK
    cat >&2 << EOF
🚫 BLOCKED: Cannot dispatch test-planner without context files

**Load context first:**

\`\`\`
triqual_load_context({ feature: "$feature" })
\`\`\`

If you have a Linear ticket:
\`\`\`
triqual_load_context({ feature: "$feature", ticket: "ENG-123" })
\`\`\`

The tool automatically analyzes the feature complexity and loads
appropriate context (Quoth patterns, codebase analysis, failure history).

After context files are generated, retry dispatching test-planner.

**Why:** Context files contain proven patterns that make planning more
effective and prevent common test failures.
EOF
    exit 2
}

main "$@"
