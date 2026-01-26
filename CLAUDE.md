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
- 4 skills: `/init`, `/quick-test`, `/test-ticket`, `/generate-test`
- 3 agents: test-healer, failure-classifier, pattern-learner

## Quick Start

### Initialize Triqual (First Time)

```bash
/init                          # Analyze project & generate config
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
| SessionStart | Session begins | Initialize session, show startup hint |
| PreToolUse (Edit/Write) | Writing .spec.ts | Remind to check Quoth patterns |
| PostToolUse (Bash) | After playwright test | Offer Exolar reporting & healing |
| Stop | Session ends | Cleanup, show summary |

### Hook Behavior

**On SessionStart:**
```
[Triqual] Test automation ready. Before writing tests: quoth_search_index({ query: "playwright patterns" })...
```

**Before writing .spec.ts:**
```
[Triqual] Writing test file. BEFORE generating: quoth_search_index({ query: "playwright test patterns" })...
```

**After running tests:**
```
[Triqual] Test failures detected. Options: (1) Analyze with failure-classifier (2) Auto-heal with test-healer...
```

## Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| init | `/init` | Initialize Triqual for project (first-time setup, generates config) |
| quick-test | `/quick-test` | Ad-hoc browser testing with visible browser |
| test-ticket | `/test-ticket ENG-123` | Full Linear ticket → test file workflow |
| generate-test | `/generate-test` | Create production .spec.ts files |

## Agents

| Agent | Triggers On | Action |
|-------|-------------|--------|
| test-healer | "fix failing tests" | Auto-heal with 3 attempts (asks first) |
| failure-classifier | "is this a flake?" | Classify as FLAKE/BUG/ENV |
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
│   │   ├── init/SKILL.md
│   │   ├── quick-test/SKILL.md
│   │   ├── test-ticket/SKILL.md
│   │   └── generate-test/SKILL.md
│   ├── hooks/                   # Hooks at plugin root (auto-discovered)
│   │   ├── hooks.json
│   │   ├── lib/common.sh
│   │   ├── session-start.sh
│   │   ├── pre-spec-write.sh
│   │   ├── post-test-run.sh
│   │   └── stop.sh
│   ├── agents/                  # Agents at plugin root (auto-discovered)
│   │   ├── test-healer.md
│   │   ├── failure-classifier.md
│   │   └── pattern-learner.md
│   ├── lib/                     # Playwright executor & helpers
│   ├── docs/references/         # Comprehensive guides
│   └── context/                 # Project configuration
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

1. **SessionStart** → Initialize session, hint to use Quoth
2. **Writing tests** → pre-spec-write hook reminds to search Quoth
3. **Running tests** → post-test-run hook offers Exolar reporting
4. **Failures** → failure-classifier analyzes, test-healer fixes
5. **Patterns** → pattern-learner proposes Quoth updates
6. **SessionStop** → Cleanup, show usage summary

## Session State

Hooks maintain session state in `/tmp/triqual/`:
- Tracks which hints have been delivered (once per session)
- Counts tool usage for summary
- Tracks test runs (passed/failed/healed)

## Project Configuration

Create `triqual.config.json` or `triqual.config.ts` in your project root:

```json
{
  "testDir": "./automation/playwright/tests",
  "project_id": "your-project-id"
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP not connected | Check `/mcp` - authenticate when prompted |
| Quoth search fails | Verify OAuth at quoth.ai-innovation.site |
| Exolar query fails | Verify OAuth at exolar.ai-innovation.site |
| Hooks not triggering | Check `hooks.json` syntax, verify scripts are executable |
| Session state stale | Delete `/tmp/triqual/` directory |

## First Time Setup

1. **Install plugin** - `claude --plugin-dir /path/to/triqual`
2. **Initialize Triqual** - Run `/init` to analyze your project and generate personalized configuration
3. **Authenticate MCPs** - Follow OAuth prompts for Quoth and Exolar
4. **Start using** - `/quick-test` or `/test-ticket ENG-123`

The `/init` skill detects your project structure, existing tests, and generates:
- `triqual.config.json` - Main configuration
- `Docs/context/project.json` - Project metadata
- `Docs/context/patterns.json` - Test patterns & conventions
- `Docs/context/selectors.json` - Locator strategies
