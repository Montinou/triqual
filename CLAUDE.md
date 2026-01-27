# Triqual - Unified Test Automation Plugin

Unified plugin for Playwright test automation with **seamless MCP integration**:
- **Quoth** - Pattern documentation (auto-installed)
- **Exolar** - Test analytics (auto-installed)
- **Playwright** - Test execution (ad-hoc and production)

## Installation

```bash
# From marketplace
/plugin marketplace add Montinou/triqual
/plugin install triqual@triqual

# Or local development
claude --plugin-dir /path/to/triqual/triqual-plugin
```

**What gets installed automatically:**
- MCP servers: `quoth` and `exolar-qa` (via `.mcp.json`)
- 4 hooks: SessionStart, PreToolUse, PostToolUse, Stop
- 7 skills: `/triqual-init`, `/quick-test`, `/test-ticket`, `/generate-test`, `/check-rules`, `/playwright-rules`, `/triqual-help`
- 3 agents: test-healer, failure-classifier, pattern-learner
- 31 Playwright best practice rules (8 categories)
- Context templates for project configuration

## Quick Start

### Initialize Triqual (First Time)

```bash
/triqual-init                         # Analyze project & generate config
```

### Ad-hoc Testing

```bash
/quick-test                    # Interactive browser testing
```

### Generate Tests from Tickets

```bash
/test-ticket ENG-123           # Full Linear → test workflow
```

### Create Permanent Tests

```bash
/generate-test login           # Create production test file
```

### Check Test Quality

```bash
/check-rules                   # Lint tests for best practice violations
```

### Get Help

```bash
/triqual-help                  # Show available commands and guidance
```

## MCP Servers (Auto-Installed)

The plugin automatically installs these MCP servers:

| Server | URL | Purpose |
|--------|-----|---------|
| `quoth` | `https://quoth.ai-innovation.site/api/mcp` | Pattern documentation |
| `exolar-qa` | `https://exolar.ai-innovation.site/api/mcp/mcp` | Test analytics |

**On first run**, Claude Code will prompt for OAuth authentication for each server.

### Available MCP Tools

**Quoth Tools:**
- `quoth_search_index({ query })` - Search documentation patterns
- `quoth_read_doc({ docId })` - Read full document
- `quoth_guidelines({ mode })` - Get coding guidelines

**Exolar Tools:**
- `query_exolar_data({ dataset, filters })` - Query test data
- `perform_exolar_action({ action, params })` - Report/classify

## Hooks (Automatic)

| Hook | Trigger | Action |
|------|---------|--------|
| SessionStart | Session begins | Initialize session, show startup guidance |
| PreToolUse (Edit/Write) | Writing .spec.ts | Recommend checking Quoth patterns |
| PostToolUse (Bash) | After playwright test | Offer Exolar reporting & suggest failure analysis |
| Stop | Session ends | Cleanup, show summary tips |

### Hook Behavior

Hooks provide **recommendations** (not mandates) and respect user autonomy:

**On SessionStart:**
```
[Triqual] Test automation initialized.

Recommended workflow:
1. Before writing test code: Search for existing patterns with quoth_search_index(...)
2. After test runs: Report results to Exolar
3. If tests fail: Use failure-classifier agent

Tip: If Quoth/Exolar searches fail, verify MCP is connected with /mcp
```

**Before writing .spec.ts:**
```
[Triqual] Writing test file detected.

Recommended steps before proceeding:
1. Search for existing patterns
2. Check for similar tests
3. Review results and reuse existing Page Objects

Following existing patterns reduces maintenance debt.
```

**After running tests (with failures):**
```
[Triqual] Test execution completed with failures.

Recommended next steps:
1. Classify the failure: Use failure-classifier agent
2. For FLAKE or TEST_ISSUE: Consider using test-healer agent
3. For BUG: Create a Linear ticket

Would you like me to run the failure-classifier agent?
```

## Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| triqual-init | `/triqual-init` | Initialize Triqual for project (first-time setup, generates config) |
| quick-test | `/quick-test` | Ad-hoc browser testing with visible browser |
| test-ticket | `/test-ticket ENG-123` | Full Linear ticket → test file workflow |
| generate-test | `/generate-test` | Create production .spec.ts files |
| check-rules | `/check-rules` | Lint tests for Playwright best practice violations |
| playwright-rules | `/playwright-rules` | Comprehensive Playwright best practices (31 rules, 8 categories) |
| triqual-help | `/triqual-help` | Get help with Triqual features and troubleshooting |

## Agents

| Agent | Triggers On | Action |
|-------|-------------|--------|
| test-healer | "fix failing tests" | Auto-heal with attempts (always asks before applying) |
| failure-classifier | "is this a flake?" | Classify as FLAKE/BUG/ENV/TEST_ISSUE |
| pattern-learner | Repeated failures | Propose Quoth documentation updates |

## Directory Structure

```
triqual/
├── .claude-plugin/
│   └── marketplace.json         # Marketplace distribution config
├── triqual-plugin/              # The actual plugin (source in marketplace.json)
│   ├── .claude-plugin/
│   │   └── plugin.json          # Plugin manifest only
│   ├── .mcp.json                # MCP server auto-install (at plugin root)
│   ├── skills/                  # Skills at plugin root (auto-discovered)
│   │   ├── triqual-init/SKILL.md
│   │   ├── quick-test/SKILL.md
│   │   ├── test-ticket/SKILL.md
│   │   ├── generate-test/SKILL.md
│   │   ├── check-rules/SKILL.md     # NEW: Rule linting
│   │   ├── triqual-help/SKILL.md    # NEW: Help system
│   │   └── playwright-rules/SKILL.md
│   ├── hooks/                   # Hooks at plugin root (auto-discovered)
│   │   ├── hooks.json
│   │   ├── lib/common.sh        # Shared functions with error handling
│   │   ├── session-start.sh
│   │   ├── pre-spec-write.sh
│   │   ├── post-test-run.sh
│   │   └── stop.sh
│   ├── agents/                  # Agents at plugin root (auto-discovered)
│   │   ├── test-healer.md
│   │   ├── failure-classifier.md
│   │   └── pattern-learner.md
│   ├── context/                 # NEW: Configuration templates
│   │   ├── project.template.json
│   │   ├── patterns.template.json
│   │   └── selectors.template.json
│   ├── lib/                     # Playwright executor & helpers
│   └── docs/
│       ├── references/          # Comprehensive guides
│       └── playwright-rules/    # 31 best practice rules (8 categories)
│           ├── SKILL.md
│           └── rules/           # Individual rule files
├── web/                         # Landing page (triqual.vercel.app)
└── CLAUDE.md
```

**Important:** Claude Code uses auto-discovery. Components (skills, hooks, agents, .mcp.json) must be at the **plugin root level**, not inside `.claude-plugin/`.

## The Learning Loop

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   QUOTH     │────────▶│  PLAYWRIGHT │────────▶│   EXOLAR    │
│  (Patterns) │         │  (Execute)  │         │ (Analytics) │
└─────────────┘         └─────────────┘         └─────────────┘
      ▲                                                │
      │                                                │
      └────────── PATTERN LEARNER AGENT ───────────────┘
```

1. **SessionStart** → Initialize session, suggest using Quoth
2. **Writing tests** → pre-spec-write hook recommends searching Quoth
3. **Running tests** → post-test-run hook offers Exolar reporting
4. **Failures** → Recommend failure-classifier, then test-healer
5. **Patterns** → pattern-learner proposes Quoth updates
6. **SessionStop** → Cleanup, show usage tips

## Session State

Hooks maintain session state in `~/.cache/triqual/`:
- Tracks which hints have been delivered (once per session)
- Counts tool usage for summary
- Tracks test runs (passed/failed/healed)
- Uses file locking to prevent race conditions
- Supports jq for reliable JSON parsing (with fallback)

## Project Configuration

Create `triqual.config.json` or `triqual.config.ts` in your project root:

```json
{
  "testDir": "./automation/playwright/tests",
  "project_id": "your-project-id",
  "baseUrl": "http://localhost:3000"
}
```

Or run `/triqual-init` to auto-generate based on your project structure.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP not connected | Check `/mcp` - authenticate when prompted |
| Quoth search fails | Verify OAuth at quoth.ai-innovation.site |
| Exolar query fails | Verify OAuth at exolar.ai-innovation.site |
| Hooks not triggering | Check `hooks.json` syntax, verify scripts are executable |
| Session state stale | Delete `~/.cache/triqual/` directory |
| Need help | Run `/triqual-help` for guidance |

## First Time Setup

1. **Install plugin** - `claude --plugin-dir /path/to/triqual`
2. **Initialize Triqual** - Run `/triqual-init` to analyze your project and generate personalized configuration
3. **Authenticate MCPs** - Follow OAuth prompts for Quoth and Exolar
4. **Start using** - `/quick-test` or `/test-ticket ENG-123`

The `/triqual-init` skill detects your project structure, existing tests, and generates:
- `triqual.config.json` - Main configuration
- `Docs/context/project.json` - Project metadata
- `Docs/context/patterns.json` - Test patterns & conventions
- `Docs/context/selectors.json` - Locator strategies

## Debugging Hooks

Set `TRIQUAL_DEBUG=true` environment variable to enable debug logging:

```bash
export TRIQUAL_DEBUG=true
```

Debug messages will appear in stderr.
