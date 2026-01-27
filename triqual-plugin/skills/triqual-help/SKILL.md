---
name: triqual-help
description: Get help with Triqual plugin features, workflows, and troubleshooting. Use when user asks "how do I use triqual", "triqual help", "what skills are available", or needs guidance on test automation workflow.
argument-hint: [topic]
allowed-tools: Read, Glob
---

# Triqual Help - Plugin Guide & Troubleshooting

Get guidance on using Triqual's test automation features, understand the workflow, and troubleshoot common issues.

## Quick Start

```bash
/triqual-help                    # Show overview and available commands
/triqual-help skills             # List all skills with descriptions
/triqual-help agents             # List all agents and when to use them
/triqual-help workflow           # Explain the recommended workflow
/triqual-help mcp                # MCP server setup and troubleshooting
/triqual-help troubleshooting    # Common issues and fixes
```

## Topics

### Overview (Default)

Display this comprehensive overview when no topic is specified:

```markdown
# Triqual - Unified Test Automation Plugin

Triqual helps you create, run, and maintain Playwright tests with integrated
pattern documentation (Quoth) and test analytics (Exolar).

## Available Skills

| Skill | Command | Description |
|-------|---------|-------------|
| Initialize | `/triqual-init` | Set up Triqual for your project |
| Quick Test | `/quick-test` | Ad-hoc browser testing |
| Test Ticket | `/test-ticket ENG-123` | Generate tests from Linear tickets |
| Generate Test | `/generate-test` | Create production test files |
| Check Rules | `/check-rules` | Lint tests for best practices |
| Playwright Rules | `/playwright-rules` | View best practice documentation |
| Help | `/triqual-help` | This help guide |

## Available Agents

| Agent | Trigger | Description |
|-------|---------|-------------|
| test-healer | Test failures | Auto-fix failing tests |
| failure-classifier | "Is this a flake?" | Classify failure type |
| pattern-learner | Recurring patterns | Propose documentation updates |

## MCP Servers

| Server | Purpose | Tool Examples |
|--------|---------|---------------|
| Quoth | Pattern documentation | `quoth_search_index`, `quoth_read_doc` |
| Exolar | Test analytics | `query_exolar_data`, `perform_exolar_action` |

## Quick Commands

- Start fresh: `/triqual-init`
- Explore a feature: `/quick-test`
- Generate from ticket: `/test-ticket ENG-123`
- Check code quality: `/check-rules`
```

### Skills Topic

```markdown
## Triqual Skills Reference

### /triqual-init

**Purpose**: Initialize Triqual for a new project or after major changes.

**When to use**:
- First time using Triqual in a project
- After restructuring test directories
- After updating Triqual plugin

**What it does**:
1. Analyzes project structure
2. Detects existing tests and patterns
3. Generates `triqual.config.json`
4. Creates context files for personalized behavior

---

### /quick-test

**Purpose**: Fast, visible browser testing for exploration and debugging.

**When to use**:
- Testing if a page loads correctly
- Debugging a specific interaction
- Exploring UI before writing permanent tests
- Taking screenshots for documentation

**What it does**:
1. Detects running dev servers
2. Writes script to /tmp
3. Executes with visible browser (headless: false)
4. Shows results in real-time

---

### /test-ticket ENG-123

**Purpose**: Convert Linear tickets to comprehensive E2E tests.

**When to use**:
- Implementing tests for a new feature ticket
- Creating regression tests for a bug fix
- Following the ticket-driven development workflow

**What it does**:
1. Fetches ticket from Linear
2. Searches Quoth for existing patterns
3. Generates test scenarios from acceptance criteria
4. Creates test file with Page Objects
5. Runs with 3 auto-healing attempts
6. Provides PR instructions

---

### /generate-test

**Purpose**: Create production-ready test files from exploration or description.

**When to use**:
- After using /quick-test to explore
- When you have clear test requirements
- Creating regression tests manually

**What it does**:
1. Gathers context (from quick-test or user)
2. Searches Quoth for patterns
3. Creates properly structured test file
4. Creates Page Objects if needed
5. Runs and verifies tests pass

---

### /check-rules

**Purpose**: Lint test files for Playwright best practice violations.

**When to use**:
- Before committing new tests
- During code review
- When experiencing flaky tests
- As part of test maintenance

**What it does**:
1. Scans test files for violations
2. Reports issues by severity (ERROR/WARN/INFO)
3. Suggests fixes for each violation
4. Optionally applies auto-fixes

---

### /playwright-rules

**Purpose**: View comprehensive Playwright best practice documentation.

**When to use**:
- Learning Playwright patterns
- Understanding why a rule exists
- Finding the correct approach for a scenario

**What it provides**:
- 31 rules across 8 categories
- Examples of good and bad patterns
- Rationale for each rule
```

### Agents Topic

```markdown
## Triqual Agents Reference

### test-healer

**Purpose**: Automatically diagnose and fix failing Playwright tests.

**Triggered by**:
- User mentions "test failures", "failing tests", "flaky tests"
- User shares Playwright error output
- Post-test-run hook when failures detected

**What it does**:
1. Parses error message and stack trace
2. Identifies root cause from known patterns
3. Proposes specific fix
4. **Asks for approval before applying**
5. Verifies fix worked

**Common fixes**:
- Add `:visible` to ambiguous selectors
- Use `getTimeout()` for dynamic timeouts
- Add `.first()` for strict mode violations
- Clear stale auth state

---

### failure-classifier

**Purpose**: Classify test failures to guide appropriate action.

**Triggered by**:
- User asks "is this a flake or bug?"
- User wants to analyze failure patterns
- Post-test-run hook recommends it

**Classification types**:
- **FLAKE**: Intermittent, use test-healer
- **BUG**: Consistent failure, create ticket
- **ENV_ISSUE**: Infrastructure problem, check environment
- **TEST_ISSUE**: Test is incorrect, fix test

**What it does**:
1. Gathers failure data
2. Queries Exolar for history (if available)
3. Applies classification rules
4. Generates report with confidence level
5. Recommends next action

---

### pattern-learner

**Purpose**: Identify recurring patterns and propose Quoth documentation updates.

**Triggered by**:
- Same error appears across multiple tests
- A fix works successfully 3+ times
- User asks to "document this pattern"

**What it does**:
1. Identifies recurring failure/fix patterns
2. Validates pattern is generalizable
3. Checks if pattern already documented in Quoth
4. Proposes new pattern documentation
5. **Asks for approval before submitting**
```

### Workflow Topic

```markdown
## Recommended Triqual Workflow

### For New Projects

1. **Initialize**: `/triqual-init`
2. **Explore**: `/quick-test` to understand the app
3. **Generate**: `/generate-test` or `/test-ticket` for permanent tests
4. **Verify**: `/check-rules` before committing

### For Existing Projects

1. **Audit**: `/check-rules` to find violations
2. **Fix**: Address ERROR-level issues first
3. **Standardize**: Search Quoth for patterns to follow

### Daily Workflow

```
Start Session
    │
    ▼
[Triqual] Session initialized (hook shows guidance)
    │
    ▼
Writing tests? ──────────────────────────────────────┐
    │                                                │
    ▼                                                │
Search Quoth: quoth_search_index({ query: "..." })   │
    │                                                │
    ▼                                                │
Write test code                                      │
    │                                                │
    ▼                                                │
[Triqual] Pre-write hook reminds about patterns      │
    │                                                │
    ▼                                                │
Run tests: npx playwright test                       │
    │                                                │
    ▼                                                │
[Triqual] Post-run hook offers next steps            │
    │                                                │
    ├── Tests passed? ── Report to Exolar ──────────┤
    │                                                │
    └── Tests failed? ── failure-classifier ────────┤
                              │                      │
                              ▼                      │
                        test-healer (if FLAKE)       │
                              │                      │
                              ▼                      │
End Session ◄────────────────────────────────────────┘
```

### The Learning Loop

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   QUOTH     │────────▶│  PLAYWRIGHT │────────▶│   EXOLAR    │
│  (Patterns) │         │  (Execute)  │         │ (Analytics) │
└─────────────┘         └─────────────┘         └─────────────┘
      ▲                                                │
      │                                                │
      └──────────── pattern-learner agent ─────────────┘
```

1. Search **Quoth** for patterns before writing
2. Execute tests with **Playwright**
3. Report results to **Exolar**
4. **pattern-learner** proposes updates to Quoth
5. Cycle continues, improving over time
```

### MCP Topic

```markdown
## MCP Server Configuration

### Servers Auto-Installed

Triqual automatically configures these MCP servers via `.mcp.json`:

| Server | URL | Auth |
|--------|-----|------|
| quoth | https://quoth.ai-innovation.site/api/mcp | OAuth |
| exolar-qa | https://exolar.ai-innovation.site/api/mcp/mcp | OAuth |

### Checking MCP Status

Run `/mcp` to see connected servers and authenticate if needed.

### Quoth Tools

| Tool | Purpose |
|------|---------|
| `quoth_search_index` | Search for patterns |
| `quoth_read_doc` | Read full document |
| `quoth_guidelines` | Get coding guidelines |
| `quoth_propose_update` | Propose new pattern |

**Example**:
```
mcp__quoth__quoth_search_index({ query: "playwright login pattern" })
```

### Exolar Tools

| Tool | Purpose |
|------|---------|
| `query_exolar_data` | Query test data |
| `perform_exolar_action` | Report results |
| `get_semantic_definition` | Get field definitions |

**Example**:
```
mcp__exolar-qa__query_exolar_data({
  dataset: "test_history",
  filters: { test_name: "login" }
})
```

### Troubleshooting MCP

**"MCP not connected"**:
1. Run `/mcp` to check status
2. Click authenticate link for each server
3. Complete OAuth flow
4. Refresh Claude session

**"Quoth search returns empty"**:
1. Verify OAuth completed
2. Check query is relevant
3. Try broader search terms

**"Exolar query fails"**:
1. Check project_id in triqual.config.json
2. Verify Exolar OAuth completed
3. Check dataset name is correct
```

### Troubleshooting Topic

```markdown
## Troubleshooting Common Issues

### Hooks Not Triggering

**Symptoms**: No [Triqual] messages appear

**Solutions**:
1. Verify plugin is installed: Check `/plugins`
2. Check hook scripts are executable:
   ```bash
   chmod +x triqual-plugin/hooks/*.sh
   ```
3. Check hooks.json syntax
4. Set `TRIQUAL_DEBUG=true` and check stderr

---

### Session State Issues

**Symptoms**: Hints keep repeating, stats don't track

**Solutions**:
1. Delete stale session:
   ```bash
   rm -rf ~/.cache/triqual/
   ```
2. Restart Claude session

---

### Tests Keep Failing

**Symptoms**: Tests fail despite fixes

**Steps**:
1. Run `/check-rules` to find violations
2. Run failure-classifier to understand why
3. Check if dev server is running
4. Verify auth state is fresh

---

### Quoth/Exolar Not Working

**Symptoms**: "MCP not connected" or searches fail

**Solutions**:
1. Run `/mcp` to check status
2. Re-authenticate via OAuth
3. Check network connectivity
4. Verify URLs in .mcp.json

---

### Config File Issues

**Symptoms**: Wrong paths, missing settings

**Solutions**:
1. Re-run `/triqual-init --force`
2. Manually edit `triqual.config.json`
3. Check paths are relative to project root

---

### Auto-Fixes Not Working

**Symptoms**: check-rules finds issues but fixes fail

**Solutions**:
1. Some fixes require manual code changes
2. Check file permissions
3. Ensure file paths are correct
```

## Output Format

When displaying help, use clear markdown formatting with:
- Section headers for organization
- Tables for quick reference
- Code blocks for examples
- Bullet points for lists

Adjust detail level based on topic:
- Overview: High-level, all features
- Specific topic: Detailed with examples
