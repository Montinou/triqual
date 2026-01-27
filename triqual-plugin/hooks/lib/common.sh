#!/usr/bin/env bash
# Triqual Plugin - Shared Functions
# Source this file from other hooks: source "${SCRIPT_DIR}/lib/common.sh"

set -e

# ============================================================================
# CONSTANTS
# ============================================================================

TRIQUAL_SESSION_DIR="/tmp/triqual"
QUOTH_MCP_NAME="quoth"
EXOLAR_MCP_NAME="exolar-qa"

# Global variable to cache stdin input (read once per hook execution)
_HOOK_INPUT=""
_HOOK_SESSION_ID=""

# ============================================================================
# STDIN INPUT HANDLING
# ============================================================================

# Read and cache stdin input (call this once at the start of each hook)
# Claude Code passes hook input as JSON via stdin
read_hook_input() {
    if [ -z "$_HOOK_INPUT" ]; then
        _HOOK_INPUT=$(cat)
    fi
    echo "$_HOOK_INPUT"
}

# Get the cached hook input (must call read_hook_input first)
get_hook_input() {
    echo "$_HOOK_INPUT"
}

# Extract session_id from hook input JSON
# Returns: session_id string or empty
get_session_id_from_input() {
    local input="${1:-$_HOOK_INPUT}"
    echo "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# ============================================================================
# MCP DETECTION
# ============================================================================

# Check if Quoth MCP is likely available
# Returns: 0 (always) - if this hook is running, the plugin is installed
quoth_mcp_installed() {
    return 0
}

# Check if Exolar MCP is likely available
exolar_mcp_installed() {
    return 0
}

# ============================================================================
# PROJECT CONFIG
# ============================================================================

# Find Triqual config file in current directory
# Returns: path to config file, or empty string
find_triqual_config() {
    if [ -f ".triqual/config.json" ]; then
        echo ".triqual/config.json"
    elif [ -f "triqual.config.json" ]; then
        echo "triqual.config.json"
    elif [ -f "triqual.config.ts" ]; then
        echo "triqual.config.ts"
    else
        echo ""
    fi
}

# Extract value from JSON config (simple grep-based, no jq dependency)
# Usage: get_config_value "project_id" "$CONFIG_PATH"
get_config_value() {
    local key="$1"
    local config_path="$2"
    if [ -f "$config_path" ]; then
        grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$config_path" 2>/dev/null | \
            head -1 | sed 's/.*"\([^"]*\)"$/\1/' || echo ""
    fi
}

# ============================================================================
# SESSION STATE
# ============================================================================

# Get session marker file path
# Uses session_id from hook input JSON, falls back to a default
get_session_file() {
    mkdir -p "$TRIQUAL_SESSION_DIR"

    # Try to get session_id from cached input
    local session_id=""
    if [ -n "$_HOOK_INPUT" ]; then
        session_id=$(get_session_id_from_input "$_HOOK_INPUT")
    fi

    # Fallback to default if no session_id
    if [ -z "$session_id" ]; then
        session_id="default"
    fi

    # Cache for reuse
    _HOOK_SESSION_ID="$session_id"

    echo "$TRIQUAL_SESSION_DIR/session_$session_id.json"
}

# Initialize session state
# Usage: init_session "$PROJECT_ID"
init_session() {
    local project_id="$1"
    local session_file=$(get_session_file)
    cat > "$session_file" << EOF
{
  "project_id": "$project_id",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "hints_delivered": {
    "session_start": true,
    "pre_edit_spec": false,
    "post_test_run": false
  },
  "tools_used": {
    "quoth_search_index": 0,
    "quoth_read_doc": 0,
    "query_exolar_data": 0,
    "perform_exolar_action": 0
  },
  "test_runs": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "healed": 0
  }
}
EOF
}

# Check if session exists
session_exists() {
    local session_file=$(get_session_file)
    [ -f "$session_file" ]
}

# Read session state
# Returns: JSON content of session file
read_session() {
    local session_file=$(get_session_file)
    if [ -f "$session_file" ]; then
        cat "$session_file"
    else
        echo '{}'
    fi
}

# Clean up session state
cleanup_session() {
    local session_file=$(get_session_file)
    rm -f "$session_file"
}

# ============================================================================
# HINT TRACKING HELPERS
# ============================================================================

# Check if hint was already delivered for a category
# Usage: hint_delivered_for "pre_edit_spec"
# Returns: 0 if delivered, 1 if not
hint_delivered_for() {
    local category="$1"
    local session_file=$(get_session_file)
    if [ -f "$session_file" ]; then
        if grep -q "\"$category\"[[:space:]]*:[[:space:]]*true" "$session_file" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Mark hint as delivered for a category
# Usage: mark_hint_delivered "pre_edit_spec"
mark_hint_delivered() {
    local category="$1"
    local session_file=$(get_session_file)
    if [ -f "$session_file" ]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/\"$category\"[[:space:]]*:[[:space:]]*false/\"$category\": true/" "$session_file"
        else
            sed -i "s/\"$category\"[[:space:]]*:[[:space:]]*false/\"$category\": true/" "$session_file"
        fi
    fi
}

# Increment a tool usage counter
# Usage: increment_tool_counter "quoth_search_index"
increment_tool_counter() {
    local tool_name="$1"
    local session_file=$(get_session_file)
    if [ -f "$session_file" ]; then
        local current=$(grep -o "\"$tool_name\"[[:space:]]*:[[:space:]]*[0-9]*" "$session_file" | grep -o '[0-9]*' | head -1 || echo "0")
        local new=$((current + 1))
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/\"$tool_name\"[[:space:]]*:[[:space:]]*[0-9]*/\"$tool_name\": $new/" "$session_file"
        else
            sed -i "s/\"$tool_name\"[[:space:]]*:[[:space:]]*[0-9]*/\"$tool_name\": $new/" "$session_file"
        fi
    fi
}

# ============================================================================
# FILE CATEGORY DETECTION
# ============================================================================

# Check if file is a test/spec file
is_spec_file() {
    local file_path="$1"
    case "$file_path" in
        *.spec.ts | *.spec.js | *.test.ts | *.test.js)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Check if file is in /tmp (quick-test scripts)
is_temp_file() {
    local file_path="$1"
    case "$file_path" in
        /tmp/* | /private/tmp/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Check if file is non-code (docs, config, etc.)
is_non_code_file() {
    local file_path="$1"
    case "$file_path" in
        *.md | *.txt | *.json | *.yaml | *.yml | *.lock)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# ============================================================================
# COMMAND DETECTION
# ============================================================================

# Check if command is a playwright test command
is_playwright_test_command() {
    local command="$1"
    if [[ "$command" =~ (playwright|pw)[[:space:]]test ]]; then
        return 0
    fi
    return 1
}

# Check if command has dry-run flag
has_dry_run_flag() {
    local command="$1"
    if [[ "$command" =~ --dry-run ]]; then
        return 0
    fi
    return 1
}

# ============================================================================
# JSON PARSING HELPERS
# ============================================================================

# Extract file_path from hook input JSON (from tool_input object)
# Usage: extract_file_path "$INPUT"
extract_file_path() {
    local input="$1"
    # Match file_path within the JSON - handles both top-level and nested in tool_input
    echo "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Extract command from hook input JSON (from tool_input object)
# Usage: extract_command "$INPUT"
extract_command() {
    local input="$1"
    echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Extract tool_name from hook input JSON
# Usage: extract_tool_name "$INPUT"
extract_tool_name() {
    local input="$1"
    echo "$input" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# ============================================================================
# JSON OUTPUT HELPERS
# ============================================================================

# Escape string for JSON
# Usage: json_escape "string with \"quotes\""
json_escape() {
    local str="$1"
    printf '%s' "$str" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' '
}

# Output hook response with additional context
# Usage: output_context "Your context message here" ["EventName"]
output_context() {
    local context="$1"
    local event_name="${2:-SessionStart}"
    local escaped=$(json_escape "$context")
    cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "$event_name",
    "additionalContext": "$escaped"
  }
}
EOF
}

# Output system message (for Stop hooks and other hooks without hookSpecificOutput)
# Usage: output_system_message "Your message here"
output_system_message() {
    local message="$1"
    local escaped=$(json_escape "$message")
    cat << EOF
{
  "systemMessage": "$escaped"
}
EOF
}

# Output empty response (hook has nothing to add)
output_empty() {
    echo '{}'
}
