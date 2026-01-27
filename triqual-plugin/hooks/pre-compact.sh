#!/usr/bin/env bash
# Triqual Plugin - PreCompact Hook
# Triggered before context compaction to preserve critical information

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Read hook input
INPUT=$(read_hook_input) || true

log_debug "PreCompact triggered - preserving critical context"

# Build context to preserve
CONTEXT="[Triqual] Context compaction starting - preserving critical test automation context.

## Session State"

# Try to read session state
SESSION_FILE=$(get_session_file 2>/dev/null) || true
if [ -f "$SESSION_FILE" ] && has_jq; then
    TOOLS_USED=$(jq -r '.tools_used | to_entries | map("\(.key): \(.value)") | join(", ")' "$SESSION_FILE" 2>/dev/null) || true
    TEST_STATS=$(jq -r '.test_runs | "total: \(.total), passed: \(.passed), failed: \(.failed), healed: \(.healed)"' "$SESSION_FILE" 2>/dev/null) || true

    if [ -n "$TOOLS_USED" ]; then
        CONTEXT="$CONTEXT
- MCP tools used: $TOOLS_USED"
    fi
    if [ -n "$TEST_STATS" ]; then
        CONTEXT="$CONTEXT
- Test runs: $TEST_STATS"
    fi
fi

# Load learned patterns if they exist
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"
PATTERNS_FILE="$PLUGIN_ROOT/context/patterns-learned.json"
ANTI_PATTERNS_FILE="$PLUGIN_ROOT/context/anti-patterns-learned.json"

CONTEXT="$CONTEXT

## Learned Patterns (preserve these)"

if [ -f "$PATTERNS_FILE" ] && has_jq; then
    PATTERN_COUNT=$(jq -r '.patterns | length' "$PATTERNS_FILE" 2>/dev/null) || echo "0"
    RECENT_PATTERNS=$(jq -r '.patterns[-3:] | .[].id // empty' "$PATTERNS_FILE" 2>/dev/null | tr '\n' ', ') || true
    CONTEXT="$CONTEXT
- Total patterns learned: $PATTERN_COUNT"
    if [ -n "$RECENT_PATTERNS" ]; then
        CONTEXT="$CONTEXT
- Recent: $RECENT_PATTERNS"
    fi
fi

if [ -f "$ANTI_PATTERNS_FILE" ] && has_jq; then
    ANTI_COUNT=$(jq -r '.antiPatterns | length' "$ANTI_PATTERNS_FILE" 2>/dev/null) || echo "0"
    RECENT_ANTI=$(jq -r '.antiPatterns[-3:] | .[].error // empty' "$ANTI_PATTERNS_FILE" 2>/dev/null | head -c 200) || true
    CONTEXT="$CONTEXT
- Anti-patterns recorded: $ANTI_COUNT"
fi

# Add reminder of available skills
CONTEXT="$CONTEXT

## Available Skills (post-compaction reminder)
- /test {feature} - Full autonomous test generation
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
- Exolar - Test analytics (query_exolar_data)"

output_context "$CONTEXT" "PreCompact"
