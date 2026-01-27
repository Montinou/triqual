# Triqual

**Unified test automation plugin for Claude Code**

Combines the power of:
- **Playwright** - Browser automation
- **Quoth** - Documentation patterns (semantic search)
- **Exolar** - Test analytics (failure clustering, dashboards)

## Installation

### From Marketplace (Recommended)

```bash
# Add marketplace
/plugin marketplace add Montinou/triqual

# Install plugin
/plugin install triqual-plugin@triqual
```

### Local Development

```bash
claude --plugin-dir /path/to/triqual/triqual-plugin
```

## Plugin Structure

```
triqual-plugin/
├── .claude-plugin/
│   └── plugin.json      # Manifest only
├── .mcp.json            # MCP servers (at root for auto-discovery)
├── skills/              # At root for auto-discovery
├── hooks/               # At root for auto-discovery
├── agents/              # At root for auto-discovery
├── lib/                 # Playwright helpers
├── docs/                # Reference documentation
└── context/             # Project configuration
```

**Note:** Claude Code uses auto-discovery. All components must be at the plugin root level, not inside `.claude-plugin/`.

## Usage

### Quick Start

```bash
/test login              # Full autonomous test generation
/test --explore login    # Interactive browser exploration
/test --ticket ENG-123   # Generate from Linear ticket
/test --describe "..."   # Generate from description
```

### Skills Overview

| Skill | Command | Description |
|-------|---------|-------------|
| Test | `/test login` | Full autonomous loop (explore → plan → generate → heal → learn) |
| Test Explore | `/test --explore` | Interactive browser exploration only |
| Test Ticket | `/test --ticket ENG-123` | Generate from Linear acceptance criteria |
| Test Describe | `/test --describe "..."` | Generate from text description |
| Check | `/check` | Lint tests for best practice violations |
| Rules | `/rules` | View Playwright best practices (31 rules) |
| Init | `/init` | Initialize Triqual for project |
| Help | `/help` | Get help with Triqual features |

### Autonomous Test Generation

The default `/test` mode runs the complete autonomous loop:

```bash
/test login
```

This runs:
1. **SETUP** - Auto-config, load credentials and existing patterns
2. **EXPLORE** - Use Playwright MCP to explore the feature
3. **PLAN** - Create test plan with Quoth patterns
4. **GENERATE** - Produce .spec.ts in draft folder
5. **HEAL LOOP** - Run tests, fix failures (max 5 iterations)
6. **PROMOTE** - Move passing tests to production location
7. **LEARN** - Save patterns and anti-patterns for future runs

### From Linear Tickets

Generate tests directly from acceptance criteria:

```bash
/test --ticket ENG-123
```

This will:
1. Fetch ticket from Linear
2. Parse acceptance criteria
3. Search Quoth for patterns
4. Generate proper test files with Page Objects
5. Execute with auto-healing
6. Provide PR instructions

### Interactive Exploration

For exploring the app before writing tests:

```bash
/test --explore login
```

Opens a visible browser for real-time exploration without generating tests.

## How It Works

### Automatic Pattern Lookup

When you write `.spec.ts` files, the plugin automatically:
1. Searches Quoth for relevant test patterns
2. Checks Exolar for similar existing tests
3. Applies project-specific best practices

### Autonomous Learning

When tests fail, the AI:
1. Fetches historic failures from Exolar to find similar issues
2. Uses Playwright MCP to explore the app and verify actual behavior
3. Compares expected vs actual to classify the failure
4. Proposes fixes or creates tickets based on classification

### Learning Loop

Repeated failures trigger the `pattern-learner` agent, which:
1. Analyzes failure clusters in Exolar
2. Proposes new documentation to Quoth
3. Improves future test generation

## Requirements

- Claude Code
- Node.js 18+
- Playwright (installed automatically)

### Optional MCPs

For full functionality, connect these MCP servers:
- `quoth` - Pattern documentation
- `exolar-qa` - Test analytics
- `linear` - Ticket management

## License

MIT
