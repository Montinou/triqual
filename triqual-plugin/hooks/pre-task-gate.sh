#!/usr/bin/env bash
# Triqual Plugin - PreToolUse Hook (Task tool gate)
# BLOCKING: Prevents test-planner dispatch without quoth-context
#
# This is the earliest possible enforcement point — before the subagent spawns.
# If quoth-context has not been invoked yet, test-planner dispatch is blocked.

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
        *test-planner*) ;;  # Continue to quoth-context check
        *) exit 0 ;;        # Not test-planner, allow through
    esac

    log_debug "Task gate: test-planner dispatch detected, checking quoth-context"

    # Check if quoth-context was already invoked
    if quoth_context_invoked; then
        log_debug "test-planner dispatch allowed - quoth-context already invoked"
        exit 0
    fi

    # BLOCK
    cat >&2 << 'EOF'
🚫 BLOCKED: Cannot dispatch test-planner without Quoth context

Invoke quoth-context agent FIRST to load patterns:

> Use quoth-context agent to research patterns for the feature (pre-agent research mode)

After quoth-context completes (sets session flag), retry dispatching test-planner.

Why: Quoth patterns prevent common test failures and reduce fix iterations.
Without them, planning is less effective and downstream gates will block anyway.
EOF
    exit 2
}

main "$@"
