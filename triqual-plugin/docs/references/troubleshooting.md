# Troubleshooting Guide

> **Category:** Reference | **Updated:** 2026-02-02

Common issues, solutions, and debugging techniques for Triqual.

---

## Quick Fixes

| Issue | Solution |
|-------|----------|
| MCP not connected | Check `/mcp` - authenticate when prompted |
| Quoth search fails | Verify OAuth at quoth.ai-innovation.site |
| Exolar query fails | Verify OAuth at exolar.ai-innovation.site |
| Hooks not triggering | Check `hooks.json` syntax, verify scripts executable |
| Session state stale | Delete `~/.cache/triqual/` directory |
| Action blocked | Read error message, create/update run log |
| Run logs not found | Run `/init` to create `.triqual/` directory |
| Need help | Run `/help` for guidance |

---

## MCP Connection Issues

### Issue: MCP Servers Not Connected

**Symptom:**
```bash
/mcp
# Shows: No MCP servers connected
```

**Diagnosis:**

1. **Check .mcp.json exists:**
```bash
ls triqual-plugin/.mcp.json
```

2. **Verify MCP configuration:**
```bash
cat triqual-plugin/.mcp.json
```

Should show:
```json
{
  "servers": {
    "quoth": {
      "url": "https://quoth.ai-innovation.site/api/mcp",
      "transport": "sse"
    },
    "exolar-qa": {
      "url": "https://exolar.ai-innovation.site/api/mcp/mcp",
      "transport": "sse"
    }
  }
}
```

**Solutions:**

1. **Restart Claude Code:**
```bash
# Exit and restart
claude
```

2. **Re-authenticate MCP servers:**
- Visit URLs and authorize
- Quoth: `https://quoth.ai-innovation.site/api/mcp`
- Exolar: `https://exolar.ai-innovation.site/api/mcp/mcp`

3. **Check plugin installation:**
```bash
/plugin list
# Should show: triqual-plugin@triqual
```

### Issue: Quoth Search Fails

**Symptom:**
```
❌ Error: Quoth search failed - unauthorized
```

**Solution:**

1. **Re-authenticate:**
```bash
# Visit Quoth OAuth
open https://quoth.ai-innovation.site/api/mcp
```

2. **Verify connection:**
```bash
/mcp
# Should show: quoth (connected)
```

3. **Test search:**
```bash
# Try a simple search
quoth_search_index({ query: "login patterns" })
```

### Issue: Exolar Query Fails

**Symptom:**
```
❌ Error: Exolar query failed - unauthorized
```

**Solution:**

1. **Re-authenticate:**
```bash
# Visit Exolar OAuth
open https://exolar.ai-innovation.site/api/mcp/mcp
```

2. **Verify project ID:**
```typescript
// triqual.config.ts
export default defineConfig({
  mcp: {
    exolar: {
      enabled: true,
      projectId: 'correct-project-id', // Check this
    },
  },
});
```

3. **Test query:**
```bash
query_exolar_data({
  dataset: "test_search",
  filters: { search: "login" }
})
```

---

## Hook Issues

### Issue: Hooks Not Triggering

**Symptom:** Can write tests to `tests/` directly (should be blocked)

**Diagnosis:**

1. **Check hooks.json syntax:**
```bash
cat triqual-plugin/hooks/hooks.json | jq
```

Should show valid JSON, no errors.

2. **Verify scripts executable:**
```bash
ls -l triqual-plugin/hooks/*.sh
# Should show: -rwxr-xr-x (executable)
```

**Solutions:**

1. **Make scripts executable:**
```bash
chmod +x triqual-plugin/hooks/*.sh
```

2. **Test hook manually:**
```bash
echo '{"tool":"Write","parameters":{"file_path":"tests/new.spec.ts"}}' | \
  triqual-plugin/hooks/pre-spec-write.sh

echo $? # Should be 2 (blocked)
```

3. **Enable debug mode:**
```bash
export TRIQUAL_DEBUG=true
```

### Issue: Hook Blocks Incorrectly

**Symptom:** Hook blocks action that should be allowed

**Diagnosis:**

Enable debug mode to see hook logic:

```bash
export TRIQUAL_DEBUG=true
```

**Example output:**
```
[DEBUG] pre-spec-write: Checking file path
[DEBUG] File: tests/login.spec.ts
[DEBUG] File already exists: YES
[DEBUG] Allow overwrite: YES
[DEBUG] Exit code: 0 (allow)
```

**Solutions:**

1. **Check run log exists:**
```bash
ls .triqual/runs/login.md
```

2. **Verify run log has required stages:**
```bash
cat .triqual/runs/login.md | grep "Stage:"
```

Should show:
```
### Stage: ANALYZE
### Stage: RESEARCH
### Stage: PLAN
### Stage: WRITE
```

3. **Check context files exist:**
```bash
ls .triqual/context/login/
```

Should show:
```
patterns.md
anti-patterns.md
codebase.md
existing-tests.md
failures.md
requirements.md
summary.md
```

### Issue: Hook Exit Code Always 0

**Symptom:** Hooks never block

**Check hook script logic:**

```bash
# pre-spec-write.sh
if [[ "$file_path" != *".draft/"* ]] && ! file_exists; then
  echo "🚫 BLOCKED: Write to .draft/ instead" >&2
  exit 2  # Should exit 2 to block
fi
```

**Verify:**
- `exit 2` present (not `exit 0` or `exit 1`)
- Condition logic correct
- `>&2` used for stderr

---

## Session State Issues

### Issue: Session State Stale

**Symptom:**
- Old hints showing again
- Tool counts incorrect
- Test run tracking wrong

**Solution:**

```bash
# Delete session state
rm -rf ~/.cache/triqual/

# Restart Claude Code
claude
```

**Effect:** Fresh session state created

### Issue: File Locking Error

**Symptom:**
```
❌ Error: Failed to acquire lock on session state
```

**Diagnosis:**

Check for stale lock file:

```bash
ls ~/.cache/triqual/.lock
```

**Solutions:**

1. **Remove stale lock:**
```bash
rm ~/.cache/triqual/.lock
```

2. **Kill hung processes:**
```bash
# Find processes holding lock
lsof ~/.cache/triqual/.lock

# Kill if necessary
kill <PID>
```

3. **Wait and retry:**
```bash
# Wait 5 seconds for lock release
sleep 5
# Retry operation
```

---

## Run Log Issues

### Issue: Run Logs Not Found

**Symptom:**
```
❌ Error: No run log found for "login"
```

**Diagnosis:**

```bash
# Check directory exists
ls -la .triqual/runs/
```

**Solutions:**

1. **Create directory:**
```bash
mkdir -p .triqual/runs/
```

2. **Run /init:**
```bash
/init
```

3. **Create run log manually:**
```bash
cat > .triqual/runs/login.md <<'EOF'
# Test Run Log: login

## Session: $(date -Iseconds)

### Stage: ANALYZE
(To be filled)

### Stage: RESEARCH
(To be filled)

### Stage: PLAN
(To be filled)
EOF
```

### Issue: Run Log Missing Stages

**Symptom:**
```
🚫 BLOCKED: Missing RESEARCH stage in run log
```

**Solution:**

Edit run log to add missing stage:

```bash
# Edit run log
cat >> .triqual/runs/login.md <<'EOF'

### Stage: RESEARCH

**Quoth Patterns:**
(To be filled)

**Exolar History:**
(To be filled)

**Existing Code:**
(To be filled)
EOF
```

---

## Agent Issues

### Issue: Agent Not Dispatching

**Symptom:** `/test login` doesn't start test-planner

**Diagnosis:**

1. **Check agent definition:**
```bash
ls triqual-plugin/agents/test-planner.md
```

2. **Verify frontmatter:**
```bash
head -n 10 triqual-plugin/agents/test-planner.md
```

Should show:
```yaml
---
model: opus
color: purple
tools:
  - Read
  - Write
---
```

**Solutions:**

1. **Verify plugin loaded:**
```bash
/plugin list
```

2. **Check agent accessible:**
```bash
cat triqual-plugin/agents/test-planner.md
```

3. **Restart Claude Code:**
```bash
claude
```

### Issue: Agent Loops Infinitely

**Symptom:** test-healer runs 100+ times, doesn't stop

**Diagnosis:**

Check run log for attempt count:

```bash
grep "Stage: RUN" .triqual/runs/login.md | wc -l
```

**Solutions:**

1. **Check retry gate hook:**
```bash
cat triqual-plugin/hooks/pre-retry-gate.sh
```

Should block at 25 attempts.

2. **Manually stop agent:**
```bash
# Stop current operation (Ctrl+C in terminal)
# Or kill process
```

3. **Mark test as .fixme():**
```typescript
// .draft/tests/login.spec.ts
test.fixme('login flow', async ({ page }) => {
  // Test code
});
```

---

## Test Generation Issues

### Issue: Tests Created in Wrong Location

**Symptom:** Test created at `tests/login.spec.ts` instead of `.draft/tests/login.spec.ts`

**Diagnosis:**

Check pre-spec-write hook:

```bash
cat triqual-plugin/hooks/pre-spec-write.sh | grep -A 5 "draft"
```

**Solutions:**

1. **Move to draft:**
```bash
mkdir -p .draft/tests/
mv tests/login.spec.ts .draft/tests/
```

2. **Fix hook:**
```bash
# Ensure hook blocks non-draft writes
# Check exit code 2 present
```

### Issue: Page Objects Not Reused

**Symptom:** New Page Object created when existing one covers the need

**Diagnosis:**

Check context files:

```bash
cat .triqual/context/login/existing-tests.md
```

Should list existing Page Objects.

**Solutions:**

1. **Regenerate context:**
```bash
triqual_load_context({ feature: "login", force: true })
```

2. **Manually verify existing code:**
```bash
ls pages/
grep -r "LoginPage" pages/
```

3. **Update run log RESEARCH stage:**
```markdown
### Stage: RESEARCH

**Existing Code to Reuse:**
- `pages/LoginPage.ts` ✅
```

---

## Performance Issues

### Issue: Context Loading Slow

**Symptom:** `triqual_load_context` takes 2+ minutes

**Diagnosis:**

Large codebase or many Quoth patterns.

**Solutions:**

1. **Use cached context:**
```bash
# Don't force reload
triqual_load_context({ feature: "login", force: false })
```

2. **Narrow search scope:**
```typescript
// Only search specific patterns
quoth_search_index({ query: "login auth patterns" })
```

3. **Reduce Exolar query range:**
```typescript
query_exolar_data({
  dataset: "test_history",
  filters: { days: 7 } // Last 7 days only
})
```

### Issue: Test Healing Slow

**Symptom:** test-healer takes 30+ minutes

**Diagnosis:**

Many test attempts, slow test execution.

**Solutions:**

1. **Run tests in headed mode locally:**
```bash
npx playwright test --headed .draft/tests/login.spec.ts
# Manually observe failures
```

2. **Add debug logging:**
```typescript
test('login', async ({ page }) => {
  console.log('Starting login test');
  // ... test code
  console.log('Login complete');
});
```

3. **Use .only for faster iteration:**
```typescript
test.only('login', async ({ page }) => {
  // Focus on this test only
});
```

---

## Debug Mode

### Enable Debug Logging

```bash
export TRIQUAL_DEBUG=true
```

### Debug Output

**Hooks:**
```
[DEBUG] SessionStart: Initializing session
[DEBUG] Session state: ~/.cache/triqual/session-state.json
[DEBUG] Active run logs: 2 found
```

**MCP Tools:**
```
[DEBUG] triqual_load_context: Starting subprocess
[DEBUG] Quoth search: "login patterns" (5 results)
[DEBUG] Exolar query: test_history (12 results)
[DEBUG] Context files written: 7 files
```

**Agents:**
```
[DEBUG] test-planner: Reading context files
[DEBUG] test-planner: Creating run log
[DEBUG] test-generator: Reading PLAN stage
[DEBUG] test-healer: Attempt 1 - FAIL (WAIT)
[DEBUG] test-healer: Attempt 2 - PASS
```

### Disable Debug Mode

```bash
unset TRIQUAL_DEBUG
```

---

## Getting Help

### /help Command

```bash
# General help
/help

# Topic-specific
/help installation
/help workflow
/help debugging
```

### Check Documentation

- [Installation](/docs/installation)
- [Skills Reference](/docs/skills-reference)
- [Learning Loop](/docs/learning-loop)
- [Hooks System](/docs/hooks-system)
- [Agents Guide](/docs/agents-guide)

### Report Issues

GitHub: `https://github.com/Montinou/triqual/issues`

Include:
- Triqual version
- Claude Code version
- Error messages
- Debug logs (`TRIQUAL_DEBUG=true`)
- Steps to reproduce

---

## Related Documentation

- [Installation](/docs/installation) - Setup verification
- [Hooks System](/docs/hooks-system) - Hook debugging
- [Session State](/docs/session-state) - State management
- [API Reference](/docs/api-reference) - MCP tool signatures

---

**Next Steps:** If issue persists, enable debug mode and report with logs. Check [Installation](/docs/installation) for setup verification.
