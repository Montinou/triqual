# Triqual

**Unified test automation plugin for Claude Code**

Combines the power of:
- **Playwright** - Browser automation
- **Quoth** - Documentation patterns (semantic search)
- **Exolar** - Test analytics (failure clustering, dashboards)

## Installation

### As Plugin (Recommended)

```bash
# Add marketplace
/plugin marketplace add Montinou/triqual

# Install
/plugin install triqual@triqual
```

### Manual Installation

```bash
# Clone to plugins directory
git clone https://github.com/Montinou/triqual ~/.claude/plugins/triqual

# Install Playwright
cd ~/.claude/plugins/triqual/lib
npm run setup
```

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
5. Report to Exolar
6. Create PR

## How It Works

### Automatic Pattern Lookup

When you write `.spec.ts` files, the plugin automatically:
1. Searches Quoth for relevant test patterns
2. Checks Exolar for similar existing tests
3. Applies project-specific best practices

### Automatic Analytics

After running tests:
1. Results are reported to Exolar dashboard
2. Failures are analyzed for patterns
3. Similar past failures are surfaced
4. Healing suggestions are offered

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
