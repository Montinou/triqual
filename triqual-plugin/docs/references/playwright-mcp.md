# Playwright MCP Integration

Browser automation via Model Context Protocol for Claude Code.

## Overview

Playwright MCP provides browser automation tools directly to Claude through the Model Context Protocol. Unlike traditional Playwright scripts, MCP tools allow Claude to:

- Control browsers conversationally
- Take screenshots and inspect pages
- Fill forms and click elements
- Navigate and interact with web content

## Auto-Installation

Triqual automatically installs Playwright MCP via `.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

No manual setup required - the server starts automatically when needed.

## Available Tools

### Navigation

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_navigate_back` | Go back in history |
| `browser_tabs` | List, create, close, or select tabs |

### Interaction

| Tool | Description |
|------|-------------|
| `browser_click` | Click on an element |
| `browser_type` | Type text into an element |
| `browser_fill_form` | Fill multiple form fields |
| `browser_select_option` | Select dropdown option |
| `browser_hover` | Hover over element |
| `browser_drag` | Drag and drop |
| `browser_press_key` | Press keyboard key |

### Inspection

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get accessibility tree (preferred) |
| `browser_take_screenshot` | Capture visual screenshot |
| `browser_console_messages` | Read console logs |
| `browser_network_requests` | View network activity |

### Execution

| Tool | Description |
|------|-------------|
| `browser_evaluate` | Execute JavaScript on page |
| `browser_run_code` | Run Playwright code snippet |
| `browser_wait_for` | Wait for text or condition |

### File Operations

| Tool | Description |
|------|-------------|
| `browser_file_upload` | Upload files |
| `browser_handle_dialog` | Handle alerts/confirms |

## Playwright MCP vs Script Execution

### When to Use Playwright MCP

- **Ad-hoc exploration**: Quick page inspection
- **Conversational testing**: "Click the login button"
- **Debugging**: Inspect page state interactively
- **Form filling**: Guided multi-step workflows

```
User: Check if the login page works
Claude: [Uses browser_navigate, browser_snapshot, browser_fill_form, browser_click]
```

### When to Use Script Execution

- **Repeatable tests**: Tests that run in CI/CD
- **Complex flows**: Multi-page transactions
- **Performance testing**: Consistent timing
- **Production test files**: `.spec.ts` files

```bash
# Use /quick-test or /generate-test for script-based testing
cd ${CLAUDE_PLUGIN_ROOT}/lib && node run.js /tmp/test.js
```

## Integration with Triqual Skills

### /quick-test

Uses **script execution** (Playwright library) for:
- Running custom test code
- Consistent, repeatable automation
- Screenshot workflows
- Local development testing

### /test-ticket

Uses **script execution** to:
- Generate production test files
- Follow project patterns
- Create Page Objects
- Integrate with CI/CD

### Manual MCP Usage

For ad-hoc exploration, use MCP tools directly:

```
User: Navigate to localhost:3000 and take a screenshot

Claude: [Uses browser_navigate to localhost:3000]
        [Uses browser_take_screenshot]
        Here's the screenshot of your homepage...
```

## Best Practices

### Use Snapshots Over Screenshots

```typescript
// Preferred - returns accessibility tree
browser_snapshot({})

// Visual only - harder for Claude to parse
browser_take_screenshot({ type: "png" })
```

### Wait for Page Load

```typescript
// Navigate then wait
browser_navigate({ url: "https://example.com" })
browser_wait_for({ text: "Welcome" })
```

### Use Refs from Snapshots

```typescript
// Get snapshot first
browser_snapshot({})
// Returns refs like "ref_1", "ref_2"

// Then interact using refs
browser_click({ ref: "ref_1", element: "Login button" })
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Browser not installed | Run `browser_install` tool |
| MCP not connected | Check `/mcp` and reconnect |
| Element not found | Use `browser_snapshot` to see available refs |
| Timeout errors | Use `browser_wait_for` before interactions |

## Comparison Table

| Feature | Playwright MCP | Script Execution |
|---------|---------------|------------------|
| Setup | Auto-installed | Requires `npm install` |
| Interaction | Conversational | Programmatic |
| Repeatability | Ad-hoc | Consistent |
| CI/CD | Not suitable | Production-ready |
| Debugging | Interactive | Log-based |
| Best for | Exploration | Test automation |
