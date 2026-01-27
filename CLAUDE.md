# Triqual - Unified Test Automation Plugin

Unified plugin for Playwright test automation with **seamless MCP integration**:
- **Quoth** - Pattern documentation (auto-installed)
- **Exolar** - Test analytics (auto-installed)
- **Playwright** - Test execution (ad-hoc and production)

## Installation

```bash
# From marketplace
/plugin marketplace add Montinou/triqual
/plugin install triqual-plugin@triqual

# Or local development
claude --plugin-dir /path/to/triqual/triqual-plugin
```

**What gets installed automatically:**
- MCP servers: `quoth` and `exolar-qa` (via `.mcp.json`)
- 4 hooks: SessionStart, PreToolUse, PostToolUse, Stop
- 5 skills: `/init`, `/test`, `/check`, `/rules`, `/help`
- 3 agents: test-healer, failure-classifier, pattern-learner
- 31 Playwright best practice rules (8 categories)
- Context templates for project configuration

## Quick Start

### Initialize (First Time)

```bash
/init                          # Analyze project & generate config
```

### Unified Test Generation

```bash
/test login              # Full autonomous (explore → plan → generate → heal → learn)
/test --explore login    # Interactive exploration only
/test --ticket ENG-123   # From Linear ticket
/test --describe "..."   # From user description
```

### Check Test Quality

```bash
/check                   # Lint tests for best practice violations
```

### View Best Practices

```bash
/rules                   # View Playwright best practices (31 rules)
```

### Get Help

```bash
/help                    # Show available commands and guidance
```

## MCP Servers (Auto-Installed)

The plugin automatically installs these MCP servers:

| Server | URL | Purpose |
|--------|-----|---------|
| `quoth` | `https://quoth.ai-innovation.site/api/mcp` | Pattern documentation |
| `exolar-qa` | `https://exolar.ai-innovation.site/api/mcp/mcp` | Test analytics |

**On first run**, Claude Code will prompt for OAuth authentication for each server.

### Available MCP Tools

**Quoth Tools (Persisting Live Docs):**
- `quoth_search_index({ query })` - Search documentation patterns
- `quoth_read_doc({ docId })` - Read full document
- `quoth_guidelines({ mode })` - Get coding guidelines

**Exolar Tools (CI Analytics Database):**
- `query_exolar_data({ dataset, filters })` - Fetch test results, failures, trends

**Playwright MCP (Autonomous App Verification):**
- `browser_navigate`, `browser_snapshot`, `browser_click`, etc. - Explore app behavior

## Hooks (Automatic)

| Hook | Trigger | Action |
|------|---------|--------|
| SessionStart | Session begins + after compaction | Initialize session, show startup guidance |
| PreToolUse (Edit/Write) | Writing .spec.ts | Recommend checking Quoth patterns |
| PostToolUse (Bash) | After playwright test | Suggest fetching Exolar data & failure analysis |
| SubagentStop | After agent completes | Provide follow-up guidance based on agent type |
| PreCompact | Before context compaction | Preserve critical patterns and session state |
| Stop | Session ends | Cleanup, show summary tips |

### Hook Behavior

Hooks provide **recommendations** (not mandates) and respect user autonomy:

**On SessionStart:**
```
[Triqual] Test automation initialized.

Recommended workflow:
1. Before writing test code: Search for existing patterns with quoth_search_index(...)
2. When tests fail: Fetch historic results from Exolar to find similar failures
3. Use Playwright MCP to explore the app and verify actual behavior
4. Use failure-classifier agent to determine if FLAKE/BUG/ENV

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
| init | `/init` | Initialize Triqual for project (first-time setup, generates config) |
| test | `/test login` | Full autonomous test generation (explore → plan → generate → heal → learn) |
| test (explore) | `/test --explore login` | Interactive browser exploration only |
| test (ticket) | `/test --ticket ENG-123` | Generate tests from Linear ticket acceptance criteria |
| test (describe) | `/test --describe "..."` | Generate tests from user text description |
| check | `/check` | Lint tests for Playwright best practice violations |
| rules | `/rules` | Comprehensive Playwright best practices (31 rules, 8 categories) |
| help | `/help` | Get help with Triqual features and troubleshooting |

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
│   │   ├── init/SKILL.md        # /init - project initialization
│   │   ├── test/SKILL.md        # /test - unified test generation
│   │   ├── check/SKILL.md       # /check - best practice linting
│   │   ├── rules/SKILL.md       # /rules - best practice docs
│   │   └── help/SKILL.md        # /help - plugin guidance
│   ├── hooks/                   # Hooks at plugin root (auto-discovered)
│   │   ├── hooks.json
│   │   ├── lib/common.sh        # Shared functions with error handling
│   │   ├── session-start.sh
│   │   ├── pre-spec-write.sh
│   │   ├── post-test-run.sh
│   │   ├── subagent-stop.sh     # After agent completes
│   │   ├── pre-compact.sh       # Before context compaction
│   │   └── stop.sh
│   ├── agents/                  # Agents at plugin root (auto-discovered)
│   │   ├── test-healer.md
│   │   ├── failure-classifier.md
│   │   └── pattern-learner.md
│   ├── context/                 # Configuration templates & learned patterns
│   │   ├── config.template.ts   # TypeScript config template
│   │   ├── project.template.json
│   │   ├── patterns.template.json
│   │   ├── selectors.template.json
│   │   ├── patterns-learned.json
│   │   └── anti-patterns-learned.json
│   ├── lib/                     # TypeScript types & helpers
│   │   └── config.ts            # defineConfig and type definitions
│   └── docs/
│       ├── references/          # Comprehensive guides
│       └── playwright-rules/    # 31 best practice rules (8 categories)
│           └── rules/           # Individual rule files
├── web/                         # Landing page (triqual.vercel.app)
└── CLAUDE.md
```

**Important:** Claude Code uses auto-discovery. Components (skills, hooks, agents, .mcp.json) must be at the **plugin root level**, not inside `.claude-plugin/`.

## The Learning Loop

Triqual is an **autonomous learning loop** - AI learns and improves from past mistakes automatically:

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   QUOTH     │         │  PLAYWRIGHT │         │   EXOLAR    │
│             │         │     MCP     │         │             │
│ Persisting  │◀────────│ AI verifies │────────▶│ AI fetches  │
│ live docs   │         │ app behavior│         │ CI results, │
│ for patterns│         │ autonomously│         │ logs, trends│
└─────────────┘         └─────────────┘         └─────────────┘
      ▲                       │                       │
      │                       │                       │
      └───────── PATTERN LEARNER (learns from both) ──┘
```

### MCP Server Purposes

| Server | Purpose | AI Action |
|--------|---------|-----------|
| **Quoth** | Persisting yet live documentation | AI stores & retrieves learned patterns |
| **Exolar** | CI analytics database | AI **fetches** results, logs, history |
| **Playwright MCP** | App verification | AI **autonomously explores** app with test creds |

### Workflow

1. **SessionStart** → Initialize session, suggest using Quoth
2. **Writing tests** → pre-spec-write hook recommends searching Quoth
3. **Running tests** → post-test-run hook suggests fetching Exolar data
4. **Failures** → Fetch history, explore with Playwright MCP, classify
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

Create `triqual.config.ts` in your project root:

```typescript
import { defineConfig } from 'triqual';

export default defineConfig({
  project_id: 'your-project-id',
  testDir: './automation/playwright/tests',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  auth: {
    strategy: 'storageState', // or 'uiLogin' | 'setupProject' | 'none'
    storageState: { path: '.auth/user.json' },
  },
});
```

Or run `/init` to auto-generate based on your project structure. The TypeScript config provides:
- Full type safety with `defineConfig`
- Import credentials from separate files
- Environment variable support
- IDE autocomplete for all options

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP not connected | Check `/mcp` - authenticate when prompted |
| Quoth search fails | Verify OAuth at quoth.ai-innovation.site |
| Exolar query fails | Verify OAuth at exolar.ai-innovation.site |
| Hooks not triggering | Check `hooks.json` syntax, verify scripts are executable |
| Session state stale | Delete `~/.cache/triqual/` directory |
| Need help | Run `/help` for guidance |

## First Time Setup

1. **Install plugin** - `claude --plugin-dir /path/to/triqual`
2. **Initialize Triqual** - Run `/init` to analyze your project and generate personalized configuration
3. **Authenticate MCPs** - Follow OAuth prompts for Quoth and Exolar
4. **Start using** - `/test login` or `/test --ticket ENG-123`

The `/init` skill detects your project structure, existing tests, and generates:
- `triqual.config.ts` - Main configuration with TypeScript types
- `Docs/context/project.json` - Project metadata
- `Docs/context/patterns.json` - Test patterns & conventions
- `Docs/context/selectors.json` - Locator strategies

## Debugging Hooks

Set `TRIQUAL_DEBUG=true` environment variable to enable debug logging:

```bash
export TRIQUAL_DEBUG=true
```

Debug messages will appear in stderr.
