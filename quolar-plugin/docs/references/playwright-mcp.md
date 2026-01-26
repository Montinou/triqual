# Playwright MCP - Browser Control Tools

This document describes how to use the Playwright MCP tools for interactive browser automation. These tools enable Claude Code to see and interact with live web applications.

## Overview

The Playwright MCP provides browser automation capabilities through a set of tools:

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to URLs, back, forward |
| `browser_snapshot` | Get accessibility tree (see page state) |
| `browser_click` | Click on elements |
| `browser_type` | Enter text into inputs |
| `browser_hover` | Hover over elements |
| `browser_drag` | Drag and drop |
| `browser_select_option` | Select dropdown options |
| `browser_press_key` | Press keyboard keys |
| `browser_file_upload` | Upload files |
| `browser_handle_dialog` | Handle alerts/confirms/prompts |
| `browser_wait_for` | Wait for conditions |
| `browser_evaluate` | Run JavaScript in page |
| `browser_take_screenshot` | Capture visual screenshot |
| `browser_console_messages` | Read console output |
| `browser_network_requests` | Monitor network traffic |

## Getting Started

### Tab Management

Before using browser tools, get context about available tabs:

```
mcp__playwright-test__tabs_context_mcp({ createIfEmpty: true })
```

This returns:
- Available tab IDs
- Current tab group info
- Whether a new tab was created

**Important:** Each conversation should create its own tab rather than reusing existing tabs, unless the user explicitly asks to work with an existing tab.

### Creating a New Tab

```
mcp__playwright-test__tabs_create_mcp()
```

### Navigation

```
mcp__playwright-test__browser_navigate({
  url: "https://example.com",
  tabId: <tab_id>
})
```

Navigation also supports:
- `"back"` - Go back in history
- `"forward"` - Go forward in history

---

## Observing Page State

### browser_snapshot - See the Page

The most important tool for understanding page state. Returns an accessibility tree representation of the page.

```
mcp__playwright-test__browser_snapshot({
  tabId: <tab_id>
})
```

**Options:**
| Parameter | Description | Default |
|-----------|-------------|---------|
| `tabId` | Tab to snapshot | Required |
| `depth` | Max tree depth | 15 |
| `filter` | "interactive" or "all" | "all" |
| `ref_id` | Focus on specific element | None |

**Output format:**
```
[ref_1] button "Sign In"
[ref_2] textbox "Email" value=""
[ref_3] textbox "Password" value=""
[ref_4] link "Forgot password?"
[ref_5] heading "Welcome Back" level=1
```

Each element has a `ref_id` that can be used with other tools.

### When to Use Snapshots

1. **Before clicking** - Verify element exists and is visible
2. **After actions** - Verify state changed as expected
3. **When debugging** - Understand current page state
4. **Before writing tests** - Identify correct locators

### Filtering Snapshots

For large pages, filter to interactive elements only:

```
mcp__playwright-test__browser_snapshot({
  tabId: <tab_id>,
  filter: "interactive"
})
```

Or focus on a specific section:

```
mcp__playwright-test__browser_snapshot({
  tabId: <tab_id>,
  ref_id: "ref_10"  // Get children of this element
})
```

### browser_take_screenshot - Visual Capture

For visual inspection:

```
mcp__playwright-test__browser_take_screenshot({
  tabId: <tab_id>
})
```

Returns an image that Claude can analyze visually.

---

## Interacting with Elements

### browser_click - Click Elements

```
mcp__playwright-test__browser_click({
  tabId: <tab_id>,
  ref: "ref_1"  // Element reference from snapshot
})
```

**Or using coordinates:**
```
mcp__playwright-test__browser_click({
  tabId: <tab_id>,
  coordinate: [100, 200]  // x, y pixels
})
```

**With modifiers:**
```
mcp__playwright-test__browser_click({
  tabId: <tab_id>,
  ref: "ref_1",
  modifiers: "ctrl"  // ctrl, shift, alt, cmd
})
```

### browser_type - Enter Text

```
mcp__playwright-test__browser_type({
  tabId: <tab_id>,
  ref: "ref_2",  // Usually a textbox
  text: "user@example.com"
})
```

**Or type at current focus:**
```
mcp__playwright-test__browser_type({
  tabId: <tab_id>,
  text: "some text"
})
```

### browser_hover - Hover Over Elements

Useful for revealing dropdowns, tooltips:

```
mcp__playwright-test__browser_hover({
  tabId: <tab_id>,
  ref: "ref_5"
})
```

### browser_press_key - Keyboard Input

```
mcp__playwright-test__browser_press_key({
  tabId: <tab_id>,
  key: "Enter"
})
```

**Common keys:**
- `Enter`, `Tab`, `Escape`
- `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`
- `Backspace`, `Delete`
- `ctrl+a`, `ctrl+c`, `ctrl+v`

**Multiple presses:**
```
mcp__playwright-test__browser_press_key({
  tabId: <tab_id>,
  key: "Tab",
  repeat: 3
})
```

### browser_select_option - Dropdowns

```
mcp__playwright-test__browser_select_option({
  tabId: <tab_id>,
  ref: "ref_7",
  value: "option_value"  // or label text
})
```

### browser_file_upload - File Input

```
mcp__playwright-test__browser_file_upload({
  tabId: <tab_id>,
  ref: "ref_8",
  paths: ["/path/to/file.pdf"]
})
```

### browser_drag - Drag and Drop

```
mcp__playwright-test__browser_drag({
  tabId: <tab_id>,
  startCoordinate: [100, 100],
  endCoordinate: [200, 200]
})
```

---

## Waiting and Synchronization

### browser_wait_for - Wait for Conditions

```
mcp__playwright-test__browser_wait_for({
  tabId: <tab_id>,
  selector: "[data-testid='success-message']",
  state: "visible",
  timeout: 10000
})
```

**States:**
- `"visible"` - Element is visible
- `"hidden"` - Element is hidden
- `"attached"` - Element is in DOM
- `"detached"` - Element removed from DOM

### When to Wait

1. **After navigation** - Wait for key element before proceeding
2. **After clicking submit** - Wait for success/error indicator
3. **After AJAX actions** - Wait for content to load
4. **Before assertions** - Ensure state is stable

---

## Handling Dialogs

### browser_handle_dialog - Alerts, Confirms, Prompts

```
mcp__playwright-test__browser_handle_dialog({
  tabId: <tab_id>,
  action: "accept"  // or "dismiss"
})
```

**With prompt input:**
```
mcp__playwright-test__browser_handle_dialog({
  tabId: <tab_id>,
  action: "accept",
  promptText: "My input"
})
```

**Important:** Dialogs block browser interaction. Handle them promptly.

---

## Advanced Capabilities

### browser_evaluate - Run JavaScript

Execute JavaScript in page context:

```
mcp__playwright-test__browser_evaluate({
  tabId: <tab_id>,
  expression: "document.querySelectorAll('.item').length"
})
```

**Use cases:**
- Get computed values
- Check JavaScript state
- Trigger JavaScript functions
- Complex DOM queries

### browser_console_messages - Read Console

```
mcp__playwright-test__browser_console_messages({
  tabId: <tab_id>,
  pattern: "error",  // Filter by regex
  onlyErrors: true
})
```

### browser_network_requests - Monitor Network

```
mcp__playwright-test__browser_network_requests({
  tabId: <tab_id>,
  urlPattern: "/api/"  // Filter by URL pattern
})
```

---

## Common Workflows

### Workflow 1: Login Flow

```
1. Navigate to login page
   browser_navigate({ url: "/login", tabId })

2. Take snapshot to see form
   browser_snapshot({ tabId })

3. Type email
   browser_type({ tabId, ref: "ref_email", text: "user@example.com" })

4. Type password
   browser_type({ tabId, ref: "ref_password", text: "password123" })

5. Click submit
   browser_click({ tabId, ref: "ref_submit" })

6. Wait for redirect
   browser_wait_for({ tabId, selector: ".dashboard", state: "visible" })

7. Verify success
   browser_snapshot({ tabId })
```

### Workflow 2: Debug Failing Test

```
1. Read the failing test file (understand steps)

2. Navigate to starting point
   browser_navigate({ url: "/feature", tabId })

3. Take snapshot
   browser_snapshot({ tabId })

4. Follow test steps one by one:
   - Click element
   - Snapshot to verify state
   - Compare to test expectations

5. When state diverges from expected:
   - Note the difference
   - Identify the fix (locator, assertion, flow)
```

### Workflow 3: Explore New Feature

```
1. Navigate to feature
   browser_navigate({ url: "/new-feature", tabId })

2. Take initial snapshot
   browser_snapshot({ tabId })

3. Explore interactively:
   - Click elements
   - Fill forms
   - Observe responses
   - Take screenshots at key states

4. Document the flow for test creation
```

---

## Best Practices

### 1. Always Snapshot Before Acting

Don't click blindly. See the page state first:

```
// Good
browser_snapshot({ tabId })  // See state
browser_click({ tabId, ref: "ref_5" })  // Click confidently

// Bad
browser_click({ tabId, ref: "ref_5" })  // Hope it exists
```

### 2. Use Element References Over Coordinates

```
// Good - precise, semantic
browser_click({ tabId, ref: "ref_5" })

// Risky - coordinates can change
browser_click({ tabId, coordinate: [150, 300] })
```

### 3. Wait After Actions That Trigger Changes

```
// Good
browser_click({ tabId, ref: "ref_submit" })
browser_wait_for({ tabId, selector: ".result", state: "visible" })
browser_snapshot({ tabId })

// Bad
browser_click({ tabId, ref: "ref_submit" })
browser_snapshot({ tabId })  // Might capture mid-transition state
```

### 4. Filter Snapshots for Large Pages

```
// For focused work
browser_snapshot({ tabId, filter: "interactive" })

// For specific section
browser_snapshot({ tabId, ref_id: "ref_form_container" })
```

### 5. Handle Errors Gracefully

If an action fails:
1. Take a snapshot to see current state
2. Check if element exists
3. Check if element is visible
4. Consider waiting for a condition

---

## Mapping to Test Code

When using MCP tools to explore, map discoveries to Playwright test code:

| MCP Observation | Test Code Equivalent |
|-----------------|---------------------|
| `[ref_1] button "Sign In"` | `page.getByRole('button', { name: 'Sign In' })` |
| `[ref_2] textbox "Email"` | `page.getByRole('textbox', { name: 'Email' })` |
| `[ref_3] link "Forgot password?"` | `page.getByRole('link', { name: 'Forgot password?' })` |
| `[ref_4] heading "Welcome" level=1` | `page.getByRole('heading', { name: 'Welcome', level: 1 })` |

### Locator Priority from Snapshots

1. **Role + name** (from snapshot) → `getByRole('button', { name: 'Submit' })`
2. **Label association** → `getByLabel('Email')`
3. **Text content** → `getByText('Welcome')`
4. **Test ID** (if visible in snapshot) → `getByTestId('submit-btn')`
5. **CSS selector** (last resort) → `locator('.btn-submit')`

---

## Troubleshooting

### Element Not Found

1. Take a fresh snapshot
2. Check if element exists in snapshot
3. Check if it's inside a frame/iframe
4. Check if page is still loading

### Click Not Working

1. Verify element is visible (not covered)
2. Try waiting for element first
3. Check if dialog is blocking
4. Try using coordinates as fallback

### Page Not Loading

1. Check URL is correct
2. Check network requests for errors
3. Check console for JavaScript errors
4. Verify authentication state

### Timeout Errors

1. Increase wait timeout
2. Check if condition is correct
3. Verify element actually appears
4. Check for redirect loops
