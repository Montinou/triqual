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
/plugin install triqual@triqual
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

### Quick Testing

Just ask Claude to test something:

```
"Test if the homepage loads"
"Check if the login form works"
"Take screenshots at different viewport sizes"
```

### Production Test Generation

Use the full workflow:

```
/test-ticket ENG-123
```

This will:
1. Fetch ticket from Linear
2. Search Quoth for patterns
3. Generate proper test files with Page Objects
4. Execute with auto-healing
5. Learn from failures (Exolar history + Playwright MCP verification)
6. Create PR

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
