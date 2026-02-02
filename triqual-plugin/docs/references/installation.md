# Installation & Setup

> **Category:** Getting Started | **Updated:** 2026-02-02

Learn how to install Triqual, connect MCP servers, and complete first-time setup.

---

## Overview

Triqual is distributed as a Claude Code plugin through the marketplace or for local development. Installation automatically configures:
- 3 MCP servers (Quoth, Exolar, Triqual-Context)
- 7 hooks for workflow enforcement
- 5 skills (slash commands)
- 5 specialized agents
- 31 Playwright best practice rules

---

## Installation Methods

### From Marketplace (Recommended)

```bash
# Add plugin from marketplace
/plugin marketplace add Montinou/triqual

# Install the plugin
/plugin install triqual-plugin@triqual
```

### Local Development

```bash
# Clone repository and point Claude Code to plugin directory
claude --plugin-dir /path/to/triqual/triqual-plugin
```

---

## What Gets Installed Automatically

### MCP Servers

| Server | Purpose | Auto-Installed |
|--------|---------|----------------|
| `quoth` | Pattern documentation and learning | ✅ Yes |
| `exolar-qa` | Test analytics and failure history | ✅ Yes |
| `triqual-context` | Context loading subprocess | ✅ Yes |

MCP servers are configured via `.mcp.json` at the plugin root and require OAuth authentication on first use.

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| SessionStart | Session begins + after compaction | Initialize session, detect active run logs |
| PreToolUse (Edit/Write) | Writing .spec.ts | Block if documentation incomplete |
| PreToolUse (Bash) | Before playwright test | Block if retry limits exceeded |
| PostToolUse (Bash) | After playwright test | Require run log update |
| SubagentStart | Before agent runs | Inject context (run log, knowledge) |
| SubagentStop | After agent completes | Guide next step |
| PreCompact | Before context compaction | Preserve run log state |
| Stop | Session ends | Check for missing learnings |

### Skills (Slash Commands)

| Skill | Command | Purpose |
|-------|---------|---------|
| init | `/init` | Initialize project with `.triqual/` directory |
| test | `/test login` | Full autonomous test generation |
| check | `/check` | Lint tests for violations |
| rules | `/rules` | View Playwright best practices |
| help | `/help` | Get help and troubleshooting |

### Agents

| Agent | Color | Role |
|-------|-------|------|
| test-planner | 🟣 Purple | ANALYZE/RESEARCH/PLAN stages |
| test-generator | 🟢 Green | WRITE stage - generate code |
| test-healer | 🔵 Blue | FIX stage - autonomous healing |
| failure-classifier | 🟠 Orange | Classify failure types |
| pattern-learner | 🟣 Purple | LEARN stage - extract patterns |

### Playwright Rules

31 best practice rules across 8 categories:
- Locators & Selectors
- Waits & Timing
- Assertions
- Page Objects
- Test Organization
- Network Mocking
- Parallelization
- Debugging

---

## First-Time Setup

### Step 1: Install Plugin

Use marketplace or local development method above.

### Step 2: Authenticate MCP Servers

On first run, Claude Code will prompt for OAuth:

**Quoth:**
- Visit: `https://quoth.ai-innovation.site/api/mcp`
- Authorize with your account
- Pattern documentation unlocked ✅

**Exolar:**
- Visit: `https://exolar.ai-innovation.site/api/mcp/mcp`
- Authorize with your account
- Test analytics unlocked ✅

**Verify MCP connection:**
```bash
/mcp
```

Should show `quoth`, `exolar-qa`, and `triqual-context` as connected.

### Step 3: Initialize Project

Navigate to your test project and run:

```bash
/init
```

This analyzes your project and generates:
- `.triqual/runs/` directory for run logs
- `.triqual/knowledge.md` for project patterns
- `triqual.config.ts` with detected settings
- Optional `Docs/context/` files

### Step 4: Start Testing

```bash
# Full autonomous test generation
/test login

# Interactive exploration only
/test --explore dashboard

# From Linear ticket
/test --ticket ENG-123
```

---

## Verification

Check installation is complete:

| Check | Command | Expected Result |
|-------|---------|-----------------|
| Plugin installed | `/plugin list` | Shows `triqual-plugin@triqual` |
| MCP connected | `/mcp` | Shows `quoth`, `exolar-qa`, `triqual-context` |
| Skills available | `/help` | Shows 5 skills |
| Project initialized | `ls .triqual` | Shows `runs/`, `knowledge.md` |

---

## Troubleshooting

### MCP Not Connected

**Symptom:** `/mcp` doesn't show Quoth or Exolar

**Solution:**
1. Check `.mcp.json` exists at plugin root
2. Restart Claude Code
3. Re-authenticate when prompted

### Hooks Not Triggering

**Symptom:** No enforcement messages when writing tests

**Solution:**
1. Verify `hooks/hooks.json` syntax
2. Check hook scripts are executable: `chmod +x hooks/*.sh`
3. Enable debug mode: `export TRIQUAL_DEBUG=true`

### Session State Stale

**Symptom:** Session behaves unexpectedly

**Solution:**
```bash
rm -rf ~/.cache/triqual/
```

---

## Related Documentation

- [Skills Reference](/docs/skills-reference) - Detailed skill usage
- [Learning Loop](/docs/learning-loop) - Workflow enforcement
- [Hooks System](/docs/hooks-system) - Hook architecture
- [Troubleshooting Guide](/docs/troubleshooting) - Common issues

---

**Next Steps:** Run `/init` in your project, then read [Skills Reference](/docs/skills-reference) to learn available commands.
