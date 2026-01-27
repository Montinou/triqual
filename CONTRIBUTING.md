# Contributing to Triqual

Thank you for your interest in contributing to Triqual! This document provides guidelines for contributing to the project.

## Table of Contents

- [Development Setup](#development-setup)
- [Adding New Rules](#adding-new-rules)
- [Adding New Agents](#adding-new-agents)
- [Adding New Hooks](#adding-new-hooks)
- [Adding New Skills](#adding-new-skills)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)

## Development Setup

### Prerequisites

- Claude Code CLI installed
- Node.js 18+ (for Playwright tests)
- macOS or Linux

### Local Development

```bash
# Clone the repository
git clone https://github.com/Montinou/triqual.git
cd triqual

# Run Claude Code with the plugin
claude --plugin-dir ./triqual-plugin
```

### Debug Mode

Enable debug logging for hooks:

```bash
export TRIQUAL_DEBUG=true
```

## Adding New Rules

Playwright best practice rules live in `triqual-plugin/docs/playwright-rules/rules/`.

### 1. Create the Rule File

Create a new file following the naming convention: `{category}-{name}.md`

```bash
touch triqual-plugin/docs/playwright-rules/rules/locator-new-rule.md
```

### 2. Use the Template

Copy the template structure from `_template.md`:

```markdown
# Rule: {rule-name}

**Category:** {category}
**Severity:** error | warning | info

## Description

Brief description of what this rule checks.

## Why This Matters

Explanation of why this pattern is important.

## Bad Example

```typescript
// Anti-pattern
await page.locator('.bad-selector').click();
```

## Good Example

```typescript
// Best practice
await page.getByTestId('good-selector').click();
```

## Auto-Fix

If applicable, describe how to fix this automatically.

## References

- [Playwright Docs](https://playwright.dev/docs/...)
```

### 3. Add to Index

Update `_sections.md` to include your new rule:

```markdown
## Locators

- locator-visibility
- locator-first
- locator-new-rule  <!-- Add here -->
```

### 4. Verify Integration

Run `/check` to verify the rule is picked up:

```bash
/check --severity all
```

## Adding New Agents

Agents live in `triqual-plugin/.agents/`.

### 1. Create the Agent File

```bash
touch triqual-plugin/.agents/new-agent.md
```

### 2. Define Frontmatter

```yaml
---
model: opus
color: cyan
description: |
  Use this agent when [specific trigger conditions].

  Examples:
  - "do something specific"
  - "perform action X"
tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - mcp__quoth__*
  - mcp__exolar__*
---
```

### 3. Write the System Prompt

After the frontmatter, write the agent's instructions:

```markdown
# New Agent

You are a specialized agent for [purpose].

## Your Role

- [Responsibility 1]
- [Responsibility 2]

## Workflow

1. Step 1
2. Step 2
3. Step 3

## Output Requirements

- [Requirement 1]
- [Requirement 2]
```

### 4. Document in README

Add the agent to the README.md agent reference table.

## Adding New Hooks

Hooks live in `triqual-plugin/hooks/`.

### 1. Create the Hook Script

```bash
touch triqual-plugin/hooks/new-hook.sh
chmod +x triqual-plugin/hooks/new-hook.sh
```

### 2. Write the Hook

Use the common library:

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

# Read hook input
read_hook_input

# Get relevant fields
TOOL_NAME=$(get_tool_name)
FILE_PATH=$(get_file_path)

# Your logic here
if [[ "$TOOL_NAME" == "Write" ]]; then
    # Check conditions
    if ! some_condition; then
        echo "Error message for Claude" >&2
        exit 2  # Block with message
    fi
fi

# Allow action
exit 0
```

### 3. Register in hooks.json

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": { "tool_name": "^Write$" },
      "command": "./new-hook.sh"
    }
  ]
}
```

### Hook Events

| Event | Trigger |
|-------|---------|
| SessionStart | Session begins |
| PreToolUse | Before tool execution |
| PostToolUse | After tool execution |
| SubagentStart | Before agent runs |
| SubagentStop | After agent completes |
| PreCompact | Before context compaction |
| Stop | Session ends |

### Exit Codes

| Code | Effect |
|------|--------|
| 0 | Allow action |
| 1 | Block silently |
| 2 | Block + stderr message to Claude |

## Adding New Skills

Skills live in `triqual-plugin/skills/`.

### 1. Create Skill Directory

```bash
mkdir -p triqual-plugin/skills/new-skill
touch triqual-plugin/skills/new-skill/SKILL.md
```

### 2. Write Skill Content

```markdown
---
name: new-skill
description: Brief description for the skill list
---

# New Skill

Instructions for Claude when this skill is invoked.

## When to Use

- Scenario 1
- Scenario 2

## Workflow

1. Step 1
2. Step 2

## Examples

### Example 1

```
/new-skill argument
```

Result: [description]
```

### 3. Test the Skill

```bash
/new-skill
```

## Testing

### Manual Testing

1. Enable debug mode: `export TRIQUAL_DEBUG=true`
2. Run the plugin: `claude --plugin-dir ./triqual-plugin`
3. Test each component

### Hook Testing

```bash
# Test hook directly
echo '{"event":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"test.spec.ts"}}' | ./hooks/pre-spec-write.sh
echo "Exit code: $?"
```

### Skill Testing

```bash
# In Claude Code session
/new-skill test-argument
```

## Pull Request Process

### 1. Create a Branch

```bash
git checkout -b feature/your-feature
```

### 2. Make Changes

Follow the guidelines above for the type of change.

### 3. Update Documentation

- Update README.md if adding features
- Update CHANGELOG.md with your changes
- Add/update ARCHITECTURE.md if changing internals

### 4. Test Thoroughly

- Test on macOS and Linux if possible
- Verify hooks work correctly
- Test with `TRIQUAL_DEBUG=true`

### 5. Submit PR

- Clear description of changes
- Reference any related issues
- Include test results

## Code Style

### Shell Scripts

- Use `set -euo pipefail`
- Source `lib/common.sh` for utilities
- Use functions for reusable logic
- Quote all variables

### Markdown

- Use ATX headers (`#`, `##`, etc.)
- Code blocks with language specified
- Tables for structured data

### Agent Prompts

- Clear role definition
- Step-by-step workflow
- Specific output requirements
- Examples when helpful

## Questions?

Open an issue on GitHub or contact the maintainers.
