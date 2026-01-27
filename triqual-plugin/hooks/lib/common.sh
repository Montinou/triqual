#!/usr/bin/env bash
# Triqual Plugin - Shared Functions
# Source this file from other hooks: source "${SCRIPT_DIR}/lib/common.sh"

# Exit on error within functions, but allow hooks to handle gracefully
set -e

# ============================================================================
# CONSTANTS
# ============================================================================

# Use ~/.cache for session state (more persistent than /tmp)
TRIQUAL_SESSION_DIR="${HOME}/.cache/triqual"
QUOTH_MCP_NAME="quoth"
EXOLAR_MCP_NAME="exolar-qa"

# Global variable to cache stdin input (read once per hook execution)
_HOOK_INPUT=""
_HOOK_SESSION_ID=""
_HOOK_DEBUG="${TRIQUAL_DEBUG:-false}"

# ============================================================================
# LOGGING & DEBUGGING
# ============================================================================

# Log debug message (only when TRIQUAL_DEBUG=true)
log_debug() {
    if [ "$_HOOK_DEBUG" = "true" ]; then
        echo "[TRIQUAL DEBUG] $*" >&2
    fi
}

# Log error message
log_error() {
    echo "[TRIQUAL ERROR] $*" >&2
}

# Log warning message
log_warn() {
    echo "[TRIQUAL WARN] $*" >&2
}

# ============================================================================
# STDIN INPUT HANDLING
# ============================================================================

# Read and cache stdin input (call this once at the start of each hook)
# Claude Code passes hook input as JSON via stdin
# Returns: 0 on success, 1 on failure
read_hook_input() {
    if [ -z "$_HOOK_INPUT" ]; then
        # Read with timeout to prevent hanging
        if ! _HOOK_INPUT=$(timeout 5 cat 2>/dev/null); then
            log_debug "Failed to read stdin (timeout or error)"
            _HOOK_INPUT=""
            return 1
        fi
    fi
    echo "$_HOOK_INPUT"
    return 0
}

# Get the cached hook input (must call read_hook_input first)
get_hook_input() {
    echo "$_HOOK_INPUT"
}

# Validate that hook input looks like JSON
# Returns: 0 if valid, 1 if invalid
validate_hook_input() {
    local input="${1:-$_HOOK_INPUT}"

    # Empty input is invalid
    if [ -z "$input" ]; then
        log_debug "Hook input is empty"
        return 1
    fi

    # Must start with { (JSON object)
    if ! echo "$input" | grep -q '^[[:space:]]*{'; then
        log_debug "Hook input doesn't look like JSON: ${input:0:50}..."
        return 1
    fi

    return 0
}

# ============================================================================
# JSON PARSING HELPERS (with jq fallback)
# ============================================================================

# Check if jq is available
has_jq() {
    command -v jq &> /dev/null
}

# Extract a field from JSON using jq (with grep/sed fallback)
# Usage: extract_json_field "$INPUT" "field_name"
# Returns: field value or empty string
extract_json_field() {
    local input="$1"
    local field="$2"
    local result=""

    if [ -z "$input" ] || [ -z "$field" ]; then
        return 0
    fi

    if has_jq; then
        # Use jq for reliable JSON parsing
        result=$(echo "$input" | jq -r ".$field // empty" 2>/dev/null) || true
    else
        # Fallback to grep/sed (less reliable but works without dependencies)
        result=$(echo "$input" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"\([^"]*\)"$/\1/') || true
    fi

    echo "$result"
}

# Extract nested field from JSON
# Usage: extract_nested_field "$INPUT" "parent" "child"
extract_nested_field() {
    local input="$1"
    local parent="$2"
    local child="$3"

    if [ -z "$input" ] || [ -z "$parent" ] || [ -z "$child" ]; then
        return 0
    fi

    if has_jq; then
        echo "$input" | jq -r ".$parent.$child // empty" 2>/dev/null || true
    else
        # Fallback: try to find the nested value
        echo "$input" | grep -o "\"$child\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
    fi
}

# Extract session_id from hook input JSON
# Returns: session_id string or empty
get_session_id_from_input() {
    local input="${1:-$_HOOK_INPUT}"
    extract_json_field "$input" "session_id"
}

# Extract file_path from hook input JSON (from tool_input object)
# Usage: extract_file_path "$INPUT"
extract_file_path() {
    local input="$1"

    if [ -z "$input" ]; then
        log_debug "extract_file_path: empty input"
        return 0
    fi

    if has_jq; then
        # Try tool_input.file_path first, then top-level file_path
        local result=$(echo "$input" | jq -r '.tool_input.file_path // .file_path // empty' 2>/dev/null) || true
        echo "$result"
    else
        # Fallback to grep/sed
        echo "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
    fi
}

# Extract command from hook input JSON (from tool_input object)
# Usage: extract_command "$INPUT"
extract_command() {
    local input="$1"

    if [ -z "$input" ]; then
        log_debug "extract_command: empty input"
        return 0
    fi

    if has_jq; then
        local result=$(echo "$input" | jq -r '.tool_input.command // .command // empty' 2>/dev/null) || true
        echo "$result"
    else
        echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
    fi
}

# Extract tool_name from hook input JSON
# Usage: extract_tool_name "$INPUT"
extract_tool_name() {
    local input="$1"
    extract_json_field "$input" "tool_name"
}

# Extract tool_result from PostToolUse hook input
# Usage: extract_tool_result "$INPUT"
extract_tool_result() {
    local input="$1"

    if [ -z "$input" ]; then
        return 0
    fi

    if has_jq; then
        echo "$input" | jq -r '.tool_result // empty' 2>/dev/null || true
    else
        # Fallback: Try to extract tool_result (complex, may not work for all cases)
        echo "$input" | grep -o '"tool_result"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
    fi
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

# Extract value from JSON config
# Usage: get_config_value "project_id" "$CONFIG_PATH"
get_config_value() {
    local key="$1"
    local config_path="$2"

    if [ -z "$key" ] || [ -z "$config_path" ] || [ ! -f "$config_path" ]; then
        return 0
    fi

    if has_jq; then
        jq -r ".$key // empty" "$config_path" 2>/dev/null || true
    else
        grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$config_path" 2>/dev/null | \
            head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true
    fi
}

# ============================================================================
# SESSION STATE
# ============================================================================

# Ensure session directory exists with proper permissions
ensure_session_dir() {
    if [ ! -d "$TRIQUAL_SESSION_DIR" ]; then
        mkdir -p "$TRIQUAL_SESSION_DIR" 2>/dev/null || {
            log_warn "Could not create session directory: $TRIQUAL_SESSION_DIR"
            return 1
        }
        chmod 700 "$TRIQUAL_SESSION_DIR" 2>/dev/null || true
    fi
    return 0
}

# Get session marker file path
# Uses session_id from hook input JSON, falls back to a default
get_session_file() {
    ensure_session_dir || return 1

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
    local project_id="${1:-unknown}"
    local session_file

    session_file=$(get_session_file) || {
        log_debug "Could not get session file path"
        return 1
    }

    # Use file locking to prevent race conditions
    (
        flock -x 200 2>/dev/null || true
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
    ) 200>"$session_file.lock"

    rm -f "$session_file.lock" 2>/dev/null || true

    log_debug "Session initialized: $session_file"
    return 0
}

# Check if session exists
session_exists() {
    local session_file
    session_file=$(get_session_file) || return 1
    [ -f "$session_file" ]
}

# Read session state
# Returns: JSON content of session file
read_session() {
    local session_file
    session_file=$(get_session_file) || {
        echo '{}'
        return 0
    }

    if [ -f "$session_file" ]; then
        cat "$session_file"
    else
        echo '{}'
    fi
}

# Clean up session state
cleanup_session() {
    local session_file
    session_file=$(get_session_file) || return 0
    rm -f "$session_file" "$session_file.lock" 2>/dev/null || true
}

# ============================================================================
# HINT TRACKING HELPERS
# ============================================================================

# Check if hint was already delivered for a category
# Usage: hint_delivered_for "pre_edit_spec"
# Returns: 0 if delivered, 1 if not
hint_delivered_for() {
    local category="$1"
    local session_file

    session_file=$(get_session_file) || return 1

    if [ -f "$session_file" ]; then
        if has_jq; then
            local delivered=$(jq -r ".hints_delivered.$category // false" "$session_file" 2>/dev/null)
            [ "$delivered" = "true" ] && return 0
        else
            if grep -q "\"$category\"[[:space:]]*:[[:space:]]*true" "$session_file" 2>/dev/null; then
                return 0
            fi
        fi
    fi
    return 1
}

# Mark hint as delivered for a category
# Usage: mark_hint_delivered "pre_edit_spec"
mark_hint_delivered() {
    local category="$1"
    local session_file

    session_file=$(get_session_file) || return 1

    if [ ! -f "$session_file" ]; then
        return 1
    fi

    # Use file locking for safe modification
    (
        flock -x 200 2>/dev/null || true

        if has_jq; then
            local temp_file="${session_file}.tmp"
            jq ".hints_delivered.$category = true" "$session_file" > "$temp_file" 2>/dev/null && \
                mv "$temp_file" "$session_file"
        else
            # Fallback to sed
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s/\"$category\"[[:space:]]*:[[:space:]]*false/\"$category\": true/" "$session_file"
            else
                sed -i "s/\"$category\"[[:space:]]*:[[:space:]]*false/\"$category\": true/" "$session_file"
            fi
        fi
    ) 200>"$session_file.lock"

    rm -f "$session_file.lock" 2>/dev/null || true
}

# Increment a tool usage counter
# Usage: increment_tool_counter "quoth_search_index"
increment_tool_counter() {
    local tool_name="$1"
    local session_file

    session_file=$(get_session_file) || return 1

    if [ ! -f "$session_file" ]; then
        return 1
    fi

    (
        flock -x 200 2>/dev/null || true

        if has_jq; then
            local temp_file="${session_file}.tmp"
            jq ".tools_used.$tool_name += 1" "$session_file" > "$temp_file" 2>/dev/null && \
                mv "$temp_file" "$session_file"
        else
            local current=$(grep -o "\"$tool_name\"[[:space:]]*:[[:space:]]*[0-9]*" "$session_file" | grep -o '[0-9]*' | head -1 || echo "0")
            local new=$((current + 1))
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s/\"$tool_name\"[[:space:]]*:[[:space:]]*[0-9]*/\"$tool_name\": $new/" "$session_file"
            else
                sed -i "s/\"$tool_name\"[[:space:]]*:[[:space:]]*[0-9]*/\"$tool_name\": $new/" "$session_file"
            fi
        fi
    ) 200>"$session_file.lock"

    rm -f "$session_file.lock" 2>/dev/null || true
}

# Update test run statistics
# Usage: update_test_stats "total" 5 OR update_test_stats "passed" 3
update_test_stats() {
    local stat_name="$1"
    local value="$2"
    local session_file

    session_file=$(get_session_file) || return 1

    if [ ! -f "$session_file" ]; then
        return 1
    fi

    if has_jq; then
        (
            flock -x 200 2>/dev/null || true
            local temp_file="${session_file}.tmp"
            jq ".test_runs.$stat_name = $value" "$session_file" > "$temp_file" 2>/dev/null && \
                mv "$temp_file" "$session_file"
        ) 200>"$session_file.lock"
        rm -f "$session_file.lock" 2>/dev/null || true
    fi
}

# ============================================================================
# FILE CATEGORY DETECTION
# ============================================================================

# Check if file is a test/spec file
is_spec_file() {
    local file_path="$1"

    if [ -z "$file_path" ]; then
        return 1
    fi

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

    if [ -z "$file_path" ]; then
        return 1
    fi

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

    if [ -z "$file_path" ]; then
        return 1
    fi

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
# Detects: playwright test, pw test, npx playwright, yarn/npm/pnpm test variants
is_playwright_test_command() {
    local command="$1"

    if [ -z "$command" ]; then
        return 1
    fi

    # Direct playwright/pw commands
    if echo "$command" | grep -qE '(playwright|pw)[[:space:]]+test'; then
        return 0
    fi

    # npx playwright
    if echo "$command" | grep -qE 'npx[[:space:]]+(--[a-z-]+[[:space:]]+)*playwright'; then
        return 0
    fi

    # Package manager test commands that likely run Playwright
    if echo "$command" | grep -qE '(yarn|npm|pnpm)[[:space:]]+(run[[:space:]]+)?(test:?e2e|test:?playwright|playwright)'; then
        return 0
    fi

    return 1
}

# Check if command has dry-run flag
has_dry_run_flag() {
    local command="$1"

    if [ -z "$command" ]; then
        return 1
    fi

    if echo "$command" | grep -qE '\-\-dry-run'; then
        return 0
    fi
    return 1
}

# ============================================================================
# TEST OUTPUT PARSING
# ============================================================================

# Parse Playwright test output for pass/fail counts
# Returns: "passed:N failed:N" or empty string
parse_test_results() {
    local output="$1"

    if [ -z "$output" ]; then
        return 0
    fi

    local passed=""
    local failed=""

    # Match patterns like "5 passed", "2 failed"
    passed=$(echo "$output" | grep -oE '[0-9]+[[:space:]]+passed' | head -1 | grep -oE '[0-9]+' || echo "")
    failed=$(echo "$output" | grep -oE '[0-9]+[[:space:]]+failed' | head -1 | grep -oE '[0-9]+' || echo "")

    if [ -n "$passed" ] || [ -n "$failed" ]; then
        echo "passed:${passed:-0} failed:${failed:-0}"
    fi
}

# Check if test output indicates failures
# Returns: 0 if failures detected, 1 otherwise
has_test_failures() {
    local output="$1"

    if [ -z "$output" ]; then
        return 1
    fi

    # Check for explicit "N failed" pattern
    if echo "$output" | grep -qE '[1-9][0-9]*[[:space:]]+failed'; then
        return 0
    fi

    # Check for error indicators
    if echo "$output" | grep -qE '(Error:|FAILED|✘|×)'; then
        return 0
    fi

    return 1
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
