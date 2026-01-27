#!/usr/bin/env bash
# Triqual Plugin - SubagentStop Hook
# Triggered when a subagent (test-healer, failure-classifier, pattern-learner) completes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Read hook input
INPUT=$(read_hook_input) || true

# Extract agent name from input
AGENT_NAME=""
if has_jq; then
    AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // .subagent_name // empty' 2>/dev/null) || true
fi

# Fallback to grep if jq didn't work
if [ -z "$AGENT_NAME" ]; then
    AGENT_NAME=$(echo "$INPUT" | grep -oE '"(agent_name|subagent_name)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/') || true
fi

log_debug "SubagentStop triggered for agent: $AGENT_NAME"

# Provide context based on which agent completed
case "$AGENT_NAME" in
    *test-healer*)
        output_context "[Triqual] Test healer completed.

Next steps:
1. Run the test again to verify the fix works
2. If still failing, check if it's a different error
3. Consider running /check to validate the fix follows best practices

If the fix worked, the pattern will be saved to anti-patterns-learned.json for future reference." "SubagentStop"
        ;;

    *failure-classifier*)
        output_context "[Triqual] Failure classification completed.

Based on the classification:
- FLAKE: Consider using test-healer agent to fix
- BUG: Create a Linear ticket with reproduction steps
- ENV_ISSUE: Check environment configuration
- TEST_ISSUE: Review test logic and assertions

Use the classification to decide the appropriate next action." "SubagentStop"
        ;;

    *pattern-learner*)
        output_context "[Triqual] Pattern learner completed.

If a pattern was proposed:
1. Review the proposed documentation
2. Approve to add to Quoth, or modify first
3. Patterns help future test generation

Learned patterns are saved to patterns-learned.json in the plugin context." "SubagentStop"
        ;;

    *)
        # Unknown or no agent name - provide generic guidance
        if [ -n "$AGENT_NAME" ]; then
            log_debug "Unknown agent completed: $AGENT_NAME"
        fi
        output_empty
        ;;
esac
