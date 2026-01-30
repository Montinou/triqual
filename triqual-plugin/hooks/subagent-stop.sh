#!/usr/bin/env bash
# Triqual Plugin - SubagentStop Hook
# Triggered when a subagent (test-healer, failure-classifier, pattern-learner) completes
# Verifies run log was updated and provides next step guidance

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

# Get the latest run log for context
LATEST_LOG=$(get_latest_run_log)
RUN_LOG_PATH=""
FEATURE=""

if [ -n "$LATEST_LOG" ]; then
    RUN_LOG_PATH="$LATEST_LOG"
    FEATURE=$(basename "$LATEST_LOG" .md)
fi

# Check if run log was updated recently (within 60 seconds)
LOG_UPDATED=false
if [ -n "$FEATURE" ] && run_log_recently_updated "$FEATURE" 60; then
    LOG_UPDATED=true
fi

# Provide context based on which agent completed
case "$AGENT_NAME" in
    *test-planner*)
        if [ "$LOG_UPDATED" = "true" ]; then
            # Check if required stages exist
            ANALYZE_EXISTS=$(grep -c "### Stage: ANALYZE" "$LATEST_LOG" 2>/dev/null || echo "0")
            RESEARCH_EXISTS=$(grep -c "### Stage: RESEARCH" "$LATEST_LOG" 2>/dev/null || echo "0")
            PLAN_EXISTS=$(grep -c "### Stage: PLAN" "$LATEST_LOG" 2>/dev/null || echo "0")

            output_context "[Triqual] ✓ Test planner completed and run log created.

**Run log:** $RUN_LOG_PATH

**Stages documented:**
- ANALYZE: $([ "$ANALYZE_EXISTS" -ge 1 ] && echo "✓" || echo "✗ MISSING")
- RESEARCH: $([ "$RESEARCH_EXISTS" -ge 1 ] && echo "✓" || echo "✗ MISSING")
- PLAN: $([ "$PLAN_EXISTS" -ge 1 ] && echo "✓" || echo "✗ MISSING")

**Next step in the loop:**
→ Use **triqual-plugin:test-generator** agent to generate test code from this plan.

**To continue:**
Say: 'Use triqual-plugin:test-generator agent to generate tests from the plan'" "SubagentStop"
        else
            output_context "[Triqual] ⚠️ Test planner completed but run log may not be updated.

**Expected:** Agent should have created $RUN_LOG_PATH with:
- ANALYZE stage (requirements, acceptance criteria)
- RESEARCH stage (Quoth patterns, Exolar tests, available resources)
- PLAN stage (test cases, tools, artifacts)

**If not created, please run test-planner again:**

'Use triqual-plugin:test-planner agent to plan tests for {feature}'

A valid run log is REQUIRED before test-generator can proceed." "SubagentStop"
        fi
        ;;

    *test-generator*)
        if [ "$LOG_UPDATED" = "true" ]; then
            # Check if WRITE stage was added
            WRITE_EXISTS=$(grep -c "### Stage: WRITE" "$LATEST_LOG" 2>/dev/null || echo "0")

            # Find any newly created test files
            RECENT_SPECS=""
            if [ -d "tests" ]; then
                RECENT_SPECS=$(find tests -name "*.spec.ts" -mmin -2 2>/dev/null | head -3) || true
            fi

            output_context "[Triqual] ✓ Test generator completed and run log updated.

**Run log:** $RUN_LOG_PATH
**WRITE stage:** $([ "$WRITE_EXISTS" -ge 1 ] && echo "✓ Documented" || echo "✗ MISSING - please add")

**Files created recently:**
$([ -n "$RECENT_SPECS" ] && echo "$RECENT_SPECS" || echo "  (check run log for file paths)")

**Next step in the loop:**
→ Run the tests to verify they work.

**To continue:**
\`\`\`bash
npx playwright test ${FEATURE}.spec.ts
\`\`\`

If tests fail, triqual-plugin:test-healer agent will analyze and fix issues." "SubagentStop"
        else
            output_context "[Triqual] ⚠️ Test generator completed but run log may not be updated.

**Expected:** Agent should have updated $RUN_LOG_PATH with:
- WRITE stage with hypothesis
- List of files created
- Patterns applied

**If not updated, please add:**

### Stage: WRITE
**Hypothesis:** {approach and rationale}
**Files created:**
- {path/to/test.spec.ts}

**Next steps:**
1. Verify test files were created
2. Add WRITE stage to run log
3. Run tests to verify: \`npx playwright test\`" "SubagentStop"
        fi
        ;;

    *test-healer*)
        if [ "$LOG_UPDATED" = "true" ]; then
            output_context "[Triqual] ✓ Test healer completed and run log updated.

**Run log:** $RUN_LOG_PATH

**Next steps in the loop:**
1. If fix was applied → Run the test to verify
2. If PASSED → Add to LEARN stage, update knowledge.md if pattern is reusable
3. If STILL FAILING → Check attempt count:
   - Under 25 attempts: Try another fix hypothesis
   - 25+ attempts: Mark as .fixme() or justify another attempt
4. Consider running pattern-learner if a reusable pattern was discovered

**To continue:**
- Run the test: \`npx playwright test {file} --grep \"{test}\"\`
- Or move to next feature" "SubagentStop"
        else
            output_context "[Triqual] ⚠️ Test healer completed but run log may not be updated.

**Expected:** Agent should have updated $RUN_LOG_PATH with:
- FIX stage with hypothesis and changes
- Verification results

**If not updated, please add manually:**

### Agent: test-healer

**Fix Applied:**
- Pattern: {pattern used}
- Changes: {summary}

**Verification:**
- Result: {PASSED | STILL FAILING}

**Next steps:**
1. Verify run log is updated
2. Run test to confirm fix
3. Proceed based on result" "SubagentStop"
        fi
        ;;

    *failure-classifier*)
        if [ "$LOG_UPDATED" = "true" ]; then
            output_context "[Triqual] ✓ Failure classifier completed and run log updated.

**Run log:** $RUN_LOG_PATH

**Based on classification, next agent to use:**

| Classification | Next Step |
|----------------|-----------|
| FLAKE | → Use **triqual-plugin:test-healer** agent to add stability fixes |
| TEST_ISSUE | → Use **triqual-plugin:test-healer** agent to fix test logic |
| BUG | → Create Linear ticket, do NOT modify test |
| ENV_ISSUE | → Check environment, then retry |

**To continue:**
- For FLAKE/TEST_ISSUE: 'Use triqual-plugin:test-healer agent to fix this'
- For BUG: 'Create a Linear ticket for this bug'
- For ENV_ISSUE: Fix environment, then retry tests" "SubagentStop"
        else
            output_context "[Triqual] ⚠️ Failure classifier completed but run log may not be updated.

**Expected:** Agent should have updated $RUN_LOG_PATH with:
- Classification (FLAKE/BUG/ENV_ISSUE/TEST_ISSUE)
- Confidence level
- Evidence and analysis
- Recommended action

**If not updated, please add manually:**

### Agent: failure-classifier

**Classification:** {FLAKE | BUG | ENV_ISSUE | TEST_ISSUE}
**Confidence:** {High | Medium | Low}

**Evidence:**
- {evidence supporting classification}

**Recommended Action:**
- {next step based on classification}

**Use the classification to decide next agent/action.**" "SubagentStop"
        fi
        ;;

    *quoth-context*)
        # ROOT FIX: Set the session flag that downstream gates check
        local qc_mode="pre-agent-research"
        if [ -n "$FEATURE" ]; then
            mark_quoth_context_invoked "$qc_mode" "$FEATURE"
            log_debug "Marked quoth-context as invoked: mode=$qc_mode feature=$FEATURE"
        else
            mark_quoth_context_invoked "$qc_mode" ""
            log_debug "Marked quoth-context as invoked: mode=$qc_mode (no feature)"
        fi

        output_context "[Triqual] ✓ Quoth context agent completed — session flag SET.

**Run log:** $RUN_LOG_PATH
**Session flag:** quoth_context.invoked = true (mode: $qc_mode, feature: $FEATURE)

**Next step:**
Use the context returned by quoth-context to inform your test planning or generation.
If patterns were found, they should be referenced in the RESEARCH stage of the run log.

Downstream gates (pre-spec-write, pre-retry-gate) will now allow writes and test runs." "SubagentStop"
        ;;

    *pattern-learner*)
        # Check if knowledge.md was updated
        KNOWLEDGE_FILE=$(get_knowledge_file)
        KNOWLEDGE_UPDATED=false
        if [ -f "$KNOWLEDGE_FILE" ]; then
            # Check if modified in last 60 seconds
            knowledge_mtime=""
            if [[ "$OSTYPE" == "darwin"* ]]; then
                knowledge_mtime=$(stat -f %m "$KNOWLEDGE_FILE" 2>/dev/null)
            else
                knowledge_mtime=$(stat -c %Y "$KNOWLEDGE_FILE" 2>/dev/null)
            fi
            now=$(date +%s)
            if [ -n "$knowledge_mtime" ] && (( now - knowledge_mtime < 60 )); then
                KNOWLEDGE_UPDATED=true
            fi
        fi

        if [ "$LOG_UPDATED" = "true" ] || [ "$KNOWLEDGE_UPDATED" = "true" ]; then
            output_context "[Triqual] ✓ Pattern learner completed.

**Documentation updated:**
- Run log: $([ "$LOG_UPDATED" = "true" ] && echo "✓ Updated" || echo "Not updated")
- knowledge.md: $([ "$KNOWLEDGE_UPDATED" = "true" ] && echo "✓ Updated" || echo "Not updated")

**Patterns documented will help future test development:**
- New tests will find patterns via RESEARCH stage
- test-healer will apply documented fixes
- Anti-patterns will be avoided

**Promote patterns to Quoth:**
- Invoke **triqual-plugin:quoth-context** agent in **capture mode** to propose patterns to Quoth:
  > Use triqual-plugin:quoth-context agent to capture and propose patterns from $FEATURE (capture mode)
- quoth-context will read run log learnings and propose updates
- You will be asked to confirm before anything is sent to Quoth
- Promoted patterns will be available via quoth_search_index for all projects

**Session learnings are now persisted!**" "SubagentStop"
        else
            output_context "[Triqual] ⚠️ Pattern learner completed but documentation may not be updated.

**Expected updates:**
- Run log: Pattern analysis summary
- knowledge.md: New patterns discovered

**If patterns were identified, ensure they're documented:**

For knowledge.md:
### {date} - {pattern name}
- {learning}
- Source: Run logs

For run log:
### Agent: pattern-learner
**Patterns Identified:**
- {pattern description}
**Added to:** {knowledge.md / Quoth}

**Undocumented patterns are lost after session ends!**" "SubagentStop"
        fi
        ;;

    *)
        # Unknown or no agent name - provide generic guidance
        if [ -n "$AGENT_NAME" ]; then
            log_debug "Unknown agent completed: $AGENT_NAME"
            output_context "[Triqual] Agent '$AGENT_NAME' completed.

**Run log:** $RUN_LOG_PATH

If this agent made changes or findings, update the run log:

### Agent: $AGENT_NAME

**Task:** {what the agent was asked to do}
**Result:** {what the agent produced}
**Findings:** {key findings}
**Next Steps:** {recommended actions}

Keeping the run log updated ensures context survives compaction." "SubagentStop"
        else
            output_empty
        fi
        ;;
esac
