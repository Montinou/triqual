#!/usr/bin/env bash
# Triqual Plugin - PreCompact Hook
# Triggered before context compaction to preserve critical information
# Ensures the documented learning loop state survives compaction

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Read hook input
INPUT=$(read_hook_input) || true

log_debug "PreCompact triggered - preserving critical context"

# Build context to preserve
CONTEXT="[Triqual] Context compaction starting - preserving critical test automation context.

## Documented Learning Loop (CRITICAL)

You are in the middle of a test development session. The loop is:

ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN

**IMPORTANT:** Hooks BLOCK actions if documentation is missing. You MUST:
1. Document each stage in run logs at: .triqual/runs/{feature}.md
2. Update run log AFTER each test run before any other action
3. Search Quoth/Exolar after 2+ same-category failures
4. Mark as .fixme() or justify after 3+ attempts

"

# Check for active run logs and their state
RUNS_DIR=$(get_runs_dir)
if [ -d "$RUNS_DIR" ]; then
    ACTIVE_LOGS=$(list_active_run_logs)
    if [ -n "$ACTIVE_LOGS" ]; then
        CONTEXT="${CONTEXT}## Active Run Logs

READ THESE LOGS TO RESTORE CONTEXT:
"
        while read -r log; do
            if [ -n "$log" ]; then
                FEATURE=$(basename "$log" .md)
                LAST_STAGE=$(grep -E "^### Stage:" "$log" 2>/dev/null | tail -1 | sed 's/### Stage: //')
                ATTEMPTS=$(count_run_attempts "$FEATURE")
                CONTEXT="${CONTEXT}
- **$FEATURE** ($log)
  - Last stage: $LAST_STAGE
  - Run attempts: $ATTEMPTS"

                # Check for pending documentation
                if ! has_accumulated_learnings "$FEATURE"; then
                    CONTEXT="${CONTEXT}
  - ⚠️ Missing: Accumulated Learnings section"
                fi
            fi
        done <<< "$ACTIVE_LOGS"
        CONTEXT="${CONTEXT}

"
    fi
fi

# Check awaiting_log_update flag
if is_awaiting_log_update; then
    CONTEXT="${CONTEXT}## ⚠️ PENDING: Log Update Required

A test run was executed but NOT YET documented.
You MUST update the run log with results before any other action.
The next action WILL BE BLOCKED until documentation is complete.

"
fi

# Try to read session state
SESSION_FILE=$(get_session_file 2>/dev/null) || true
if [ -f "$SESSION_FILE" ] && has_jq; then
    TOOLS_USED=$(jq -r '.tools_used | to_entries | map("\(.key): \(.value)") | join(", ")' "$SESSION_FILE" 2>/dev/null) || true
    TEST_STATS=$(jq -r '.test_runs | "total: \(.total), passed: \(.passed), failed: \(.failed), healed: \(.healed)"' "$SESSION_FILE" 2>/dev/null) || true

    CONTEXT="${CONTEXT}## Session State
"
    if [ -n "$TOOLS_USED" ]; then
        CONTEXT="${CONTEXT}- MCP tools used: $TOOLS_USED
"
    fi
    if [ -n "$TEST_STATS" ]; then
        CONTEXT="${CONTEXT}- Test runs: $TEST_STATS
"
    fi
    CONTEXT="${CONTEXT}
"
fi

# Load learned patterns if they exist
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
PATTERNS_FILE="$PLUGIN_ROOT/context/patterns-learned.json"
ANTI_PATTERNS_FILE="$PLUGIN_ROOT/context/anti-patterns-learned.json"

if [ -f "$PATTERNS_FILE" ] && has_jq; then
    PATTERN_COUNT=$(jq -r '.patterns | length' "$PATTERNS_FILE" 2>/dev/null) || echo "0"
    if [ "$PATTERN_COUNT" != "0" ]; then
        CONTEXT="${CONTEXT}## Learned Patterns (preserve these)
- Total patterns learned: $PATTERN_COUNT
"
        RECENT_PATTERNS=$(jq -r '.patterns[-3:] | .[].id // empty' "$PATTERNS_FILE" 2>/dev/null | tr '\n' ', ') || true
        if [ -n "$RECENT_PATTERNS" ]; then
            CONTEXT="${CONTEXT}- Recent: $RECENT_PATTERNS
"
        fi
    fi
fi

if [ -f "$ANTI_PATTERNS_FILE" ] && has_jq; then
    ANTI_COUNT=$(jq -r '.antiPatterns | length' "$ANTI_PATTERNS_FILE" 2>/dev/null) || echo "0"
    if [ "$ANTI_COUNT" != "0" ]; then
        CONTEXT="${CONTEXT}- Anti-patterns recorded: $ANTI_COUNT
"
    fi
fi

# Check project knowledge file
KNOWLEDGE_FILE=$(get_knowledge_file)
if [ -f "$KNOWLEDGE_FILE" ]; then
    CONTEXT="${CONTEXT}
## Project Knowledge File
Location: $KNOWLEDGE_FILE
READ THIS FILE for project-specific patterns and conventions.

"
fi

# Add available tools reminder
CONTEXT="${CONTEXT}
## Available Skills (post-compaction reminder)
- /test {feature} - Full autonomous test generation (with documented loop)
- /test --explore - Interactive browser exploration
- /test --ticket ENG-123 - From Linear ticket
- /check - Lint tests for violations
- /rules - View best practices
- /help - Get guidance

## Available Agents
- test-healer - Auto-fix failing tests
- failure-classifier - Classify failures (FLAKE/BUG/ENV/TEST_ISSUE)
- pattern-learner - Learn and document patterns

## MCP Servers
- Playwright MCP - Browser automation
- Quoth - Pattern documentation (quoth_search_index, quoth_read_doc)
- Exolar - Test analytics (query_exolar_data)

## Critical Paths
- Run logs: .triqual/runs/{feature}.md
- Knowledge: .triqual/knowledge.md
- Config: triqual.config.ts"

output_context "$CONTEXT" "PreCompact"
