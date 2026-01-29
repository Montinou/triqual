#!/usr/bin/env bash
# Triqual Plugin - SessionStart Hook
# Initializes session, detects active run logs, and provides startup guidance

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    # Read JSON from stdin (Claude Code passes hook input this way)
    if ! read_hook_input > /dev/null; then
        log_debug "Failed to read hook input"
        output_empty
        exit 0
    fi

    local input="$_HOOK_INPUT"

    # Validate input
    if ! validate_hook_input "$input"; then
        log_debug "Invalid hook input, skipping"
        output_empty
        exit 0
    fi

    # Find project config
    local config_path=$(find_triqual_config)
    local project_id=""

    if [ -n "$config_path" ]; then
        project_id=$(get_config_value "project_id" "$config_path")
    fi

    # Initialize session state
    if ! init_session "$project_id"; then
        log_debug "Failed to initialize session"
    fi

    # Clear any stale awaiting_log_update flags from previous sessions
    clear_awaiting_log_update

    # Build context message
    local context="[Triqual] Test automation initialized."

    # Check for existing run logs
    local runs_dir=$(get_runs_dir)
    local active_logs=""

    if [ -d "$runs_dir" ]; then
        active_logs=$(list_active_run_logs)
    fi

    if [ -n "$active_logs" ]; then
        context="$context

=== ACTIVE RUN LOGS DETECTED ===
$(echo "$active_logs" | while read log; do
    local feature=$(basename "$log" .md)
    local last_stage=$(grep -E "^### Stage:" "$log" 2>/dev/null | tail -1 | sed 's/### Stage: //')
    echo "- $feature: Last stage was $last_stage"
done)

**ACTION REQUIRED:** Read the most recent run log to restore context before continuing.
Use: Read tool on the run log file path above."
    fi

    # Check for knowledge.md
    local knowledge_file=$(get_knowledge_file)
    if [ -f "$knowledge_file" ]; then
        context="$context

Project knowledge file exists at: $knowledge_file
Read this file to apply project-specific patterns and conventions."
    fi

    # Add workflow guidance
    context="$context

## Documented Learning Loop

Before writing any test code, you MUST:
1. **ANALYZE** - Review requirements, identify test cases, acceptance criteria
2. **RESEARCH** - **MANDATORY: Search Quoth FIRST**, then check Exolar for similar tests
3. **PLAN** - Document test strategy, tools/helpers/data to use, new artifacts to create
4. **WRITE** - Document hypothesis, then write test code
5. **RUN** - Execute and document results
6. **LEARN** - Extract patterns, update knowledge

All stages must be documented in run logs at: .triqual/runs/{feature}.md

## ⚠️ MANDATORY: Quoth Context Loading

**Invoke the quoth-context agent** to load project patterns from Quoth and local knowledge:

> Use the quoth-context agent in **session inject** mode to load project context.

The quoth-context agent will:
1. Search Quoth for project-relevant patterns
2. Read .triqual/knowledge.md for local conventions
3. Return a ~500 token context summary

This is the **recommended first action** in every session. During /test, quoth-context is **mandatory** before test-planner.

**Why:** Quoth contains proven patterns from past successes and failures. Loading context first prevents reinventing solutions and avoids common mistakes.

## Available Skills
- /test login        (full autonomous: analyze → research → plan → write → run → learn)
- /test --explore    (interactive browser exploration)
- /test --ticket     (generate from Linear ticket)
- /test --describe   (generate from description)
- /check             (lint tests for best practices)
- /rules             (view best practice documentation)
- /init              (initialize project config)

## Available Agents
- test-planner       (creates test plan - searches Quoth FIRST)
- test-generator     (generates code from plan)
- test-healer        (auto-fix failing tests)
- failure-classifier (classify failures: FLAKE/BUG/ENV/TEST_ISSUE)
- pattern-learner    (learn and document patterns)
- quoth-context      (searches Quoth, loads context, proposes patterns)

Tip: If Quoth/Exolar searches fail, verify MCP is connected with /mcp"

    output_context "$context" "SessionStart"
}

main "$@"
