#!/usr/bin/env bash
# Triqual Plugin - SubagentStart Hook
# Triggered BEFORE a subagent runs - injects context and instructions
#
# This hook tells agents what they MUST read before starting work.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Read hook input
INPUT=$(read_hook_input) || true

# Extract agent info
AGENT_TYPE=""
AGENT_ID=""

if has_jq; then
    AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // empty' 2>/dev/null) || true
    AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || true
fi

# Fallback to grep if jq didn't work
if [ -z "$AGENT_TYPE" ]; then
    AGENT_TYPE=$(echo "$INPUT" | grep -oE '"(agent_type|subagent_type)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/') || true
fi

log_debug "SubagentStart triggered for agent: $AGENT_TYPE (ID: $AGENT_ID)"

# Get context paths
RUNS_DIR=$(get_runs_dir)
LATEST_LOG=$(get_latest_run_log)
KNOWLEDGE_FILE=$(get_knowledge_file)
TRIQUAL_DIR=$(get_triqual_dir)

# Build context based on what exists
RUN_LOG_MSG=""
KNOWLEDGE_MSG=""
FEATURE=""

if [ -n "$LATEST_LOG" ]; then
    FEATURE=$(basename "$LATEST_LOG" .md)
    RUN_LOG_MSG="**Active Run Log:** $LATEST_LOG (Feature: $FEATURE)"
fi

if [ -f "$KNOWLEDGE_FILE" ]; then
    KNOWLEDGE_MSG="**Project Knowledge:** $KNOWLEDGE_FILE"
fi

# Provide context based on which agent is starting
case "$AGENT_TYPE" in
    *test-planner*)
        output_context "[Triqual] 🎯 Test Planner Agent Starting

=== MANDATORY: READ BEFORE PROCEEDING ===

You MUST read the following before creating the test plan:

1. **Project Knowledge** (if exists):
   - Path: $KNOWLEDGE_FILE
   - Contains: Selector strategies, wait patterns, auth methods, gotchas
   - Action: \`Read $KNOWLEDGE_FILE\`

2. **Existing Run Logs** (check for similar features):
   - Path: $RUNS_DIR/
   - Action: \`ls $RUNS_DIR/\` then read relevant ones

3. **Quoth Context** (MANDATORY FIRST STEP):
   - **BEFORE doing anything else**, invoke the **quoth-context** agent:
     > Use quoth-context agent to research patterns for '{feature}' (pre-agent research mode)
   - quoth-context will search Quoth for '{feature} playwright patterns'
   - quoth-context will read .triqual/knowledge.md
   - quoth-context will return structured research output
   - Use its output to populate your RESEARCH stage
   - If quoth-context is unavailable, search Quoth manually:
     \`quoth_search_index({ query: \"$FEATURE playwright patterns\" })\`

4. **Exolar Tests** (REQUIRED):
   - Search: \`query_exolar_data({ dataset: \"test_search\", filters: { search: \"{feature}\" } })\`
   - This finds existing tests and coverage gaps

5. **Linear Ticket** (if provided):
   - Fetch ticket details for acceptance criteria

=== YOUR OUTPUT ===

Create a run log at: $RUNS_DIR/{feature}.md

The run log MUST include:
- **ANALYZE stage**: Requirements, acceptance criteria, user flows
- **RESEARCH stage**: Quoth patterns, Exolar tests, available resources
- **PLAN stage**: Test cases, tools to use, new artifacts to create

Only after creating the run log can test-generator proceed." "SubagentStart"
        ;;

    *test-generator*)
        if [ -z "$LATEST_LOG" ]; then
            output_context "[Triqual] ⚠️ Test Generator Agent Starting - NO RUN LOG FOUND

=== BLOCKED: Run log required ===

Cannot generate tests without a plan. You need:
1. Run test-planner agent first, OR
2. Create run log manually with ANALYZE/RESEARCH/PLAN stages

Run log should be at: $RUNS_DIR/{feature}.md" "SubagentStart"
        else
            # Count stages in run log
            ANALYZE_EXISTS=$(grep -c "### Stage: ANALYZE" "$LATEST_LOG" 2>/dev/null || echo "0")
            RESEARCH_EXISTS=$(grep -c "### Stage: RESEARCH" "$LATEST_LOG" 2>/dev/null || echo "0")
            PLAN_EXISTS=$(grep -c "### Stage: PLAN" "$LATEST_LOG" 2>/dev/null || echo "0")

            output_context "[Triqual] 🔨 Test Generator Agent Starting

=== MANDATORY: READ BEFORE GENERATING ===

1. **Run Log** (REQUIRED - contains your plan):
   - Path: $LATEST_LOG
   - Action: \`Read $LATEST_LOG\`
   - Stages present: ANALYZE($ANALYZE_EXISTS) RESEARCH($RESEARCH_EXISTS) PLAN($PLAN_EXISTS)

2. **Project Knowledge** (patterns to follow):
   - Path: $KNOWLEDGE_FILE
   - Action: \`Read $KNOWLEDGE_FILE\`

3. **Seed File** (fixtures and setup):
   - Look for: \`seed.spec.ts\` or similar in test directory
   - Copy setup patterns from seed file

4. **Existing Page Objects** (from RESEARCH stage):
   - Reuse existing Page Objects listed in run log
   - Create new ones only if needed

=== YOUR OUTPUT ===

1. Generate test file following the PLAN in run log
2. Update run log with WRITE stage:

### Stage: WRITE
**Hypothesis:** {approach and rationale}
**Files created:**
- {path/to/test.spec.ts}
- {path/to/NewPage.ts} (if created)

After generation, test-healer will run and fix any failures." "SubagentStart"
        fi
        ;;

    *test-healer*)
        if [ -z "$LATEST_LOG" ]; then
            output_context "[Triqual] 🔧 Test Healer Agent Starting (Autonomous Loop)

=== CONTEXT ===

No active run log found. If healing ad-hoc failures:
1. Check .triqual/knowledge.md for project patterns
2. Search Quoth for fix patterns
3. Consider creating a run log for documentation

$KNOWLEDGE_MSG

=== AUTONOMOUS MODE ===

You are an autonomous loop agent. Run tests, analyze, fix, repeat until:
- Tests PASS (move from .draft/ to final location)
- 25 attempts reached (mark as .fixme())" "SubagentStart"
        else
            ATTEMPT_COUNT=$(count_run_attempts "$FEATURE")

            output_context "[Triqual] 🔧 Test Healer Agent Starting (Autonomous Loop)

=== MANDATORY: READ BEFORE HEALING ===

1. **Run Log** (REQUIRED - contains failure history):
   - Path: $LATEST_LOG
   - Feature: $FEATURE
   - Current attempts: $ATTEMPT_COUNT of 25 max
   - Action: \`Read $LATEST_LOG\`

2. **Project Knowledge** (fix patterns):
   - Path: $KNOWLEDGE_FILE
   - Action: \`Read $KNOWLEDGE_FILE\`

3. **Test Files in .draft/**:
   - Tests are in \`.draft/tests/\` folder
   - On SUCCESS: Move to \`tests/\` folder

=== AUTONOMOUS LOOP ===

You run the full loop autonomously:
1. RUN test → if PASS, promote from .draft/ and exit
2. If FAIL → analyze, document RUN stage
3. Search Quoth/knowledge for patterns
4. Apply FIX, document FIX stage
5. REPEAT until PASS or 25 attempts

=== HOOKS WILL ENFORCE ===

- **Attempt 12+**: Hook requires DEEP ANALYSIS phase
- **Attempt 25+**: Hook requires .fixme() or strong justification
- **2+ same category**: Hook requires Quoth/Exolar search

=== DEEP ANALYSIS (at attempt 12) ===

When you reach attempt 12, perform extended research:
- Broader Quoth searches
- Exolar historical data
- App exploration with Playwright MCP
- Consider fundamentally different approaches

=== YOUR OUTPUT ===

Document every iteration:

### Stage: RUN (Attempt N)
**Result:** {PASSED | FAILED}
**Error:** {if failed}

### Stage: FIX (Attempt N)
**Hypothesis:** {fix and rationale}
**Pattern Used:** {from Quoth/knowledge}
**Changes:** {what you changed}

On SUCCESS:
- Move files from .draft/ to tests/
- Document SUCCESS stage" "SubagentStart"
        fi
        ;;

    *failure-classifier*)
        output_context "[Triqual] 📊 Failure Classifier Agent Starting

=== MANDATORY: READ BEFORE CLASSIFYING ===

1. **Run Log** (failure context):
   - Path: $LATEST_LOG
   - Contains: RUN stages with error details
   - Action: \`Read $LATEST_LOG\`

2. **Project Knowledge** (known issues):
   - Path: $KNOWLEDGE_FILE
   - Contains: Known flakes, gotchas
   - Action: \`Read $KNOWLEDGE_FILE\`

3. **Query Exolar** (historical data):
   - Search: \`query_exolar_data({ dataset: \"test_history\", filters: { test_signature: \"{test}\" } })\`

=== YOUR OUTPUT ===

Update run log with classification:

### Agent: failure-classifier
**Classification:** {FLAKE | BUG | ENV_ISSUE | TEST_ISSUE}
**Confidence:** {High | Medium | Low}
**Evidence:** {supporting data}
**Next Action:** {what agent/action to use next}" "SubagentStart"
        ;;

    *quoth-context*)
        output_context "[Triqual] 🔮 Quoth Context Agent Starting

=== CONTEXT ===

$RUN_LOG_MSG
$KNOWLEDGE_MSG

You are loading semantic patterns from Quoth for the current feature.

=== YOUR OUTPUT ===

1. Search Quoth for relevant patterns
2. Read .triqual/knowledge.md for project-specific patterns
3. Return structured context summary for downstream agents" "SubagentStart"
        ;;

    *pattern-learner*)
        output_context "[Triqual] 📚 Pattern Learner Agent Starting

=== MANDATORY: READ BEFORE LEARNING ===

1. **ALL Run Logs** (find patterns across features):
   - Path: $RUNS_DIR/
   - Action: \`ls $RUNS_DIR/\` then read each

2. **Project Knowledge** (check what's documented):
   - Path: $KNOWLEDGE_FILE
   - Action: \`Read $KNOWLEDGE_FILE\`
   - Avoid documenting duplicates

3. **Check Quoth** (avoid duplicating global patterns):
   - Search: \`quoth_search_index({ query: \"{pattern keywords}\" })\`

=== LOOK FOR ===

- Same error fixed the same way 3+ times
- Same selector pattern working across features
- Same wait pattern needed repeatedly
- Anti-patterns that caused failures

=== YOUR OUTPUT ===

1. Update knowledge.md with project-specific patterns
2. Propose to Quoth if pattern is generalizable
3. Update run logs with agent summary" "SubagentStart"
        ;;

    *)
        # Generic agent or unknown
        if [ -n "$AGENT_TYPE" ]; then
            output_context "[Triqual] 🤖 Agent '$AGENT_TYPE' Starting

=== RECOMMENDED: READ CONTEXT ===

$RUN_LOG_MSG
$KNOWLEDGE_MSG

If this agent modifies tests or documentation, update the run log with findings." "SubagentStart"
        else
            output_empty
        fi
        ;;
esac
