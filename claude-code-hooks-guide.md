# Claude Code Hooks: The Definitive Implementation Guide

> Transform probabilistic AI suggestions into deterministic, guaranteed actions

## Table of Contents

1. [Introduction](#introduction)
2. [Core Concepts](#core-concepts)
3. [Hook Events Reference](#hook-events-reference)
4. [Configuration](#configuration)
5. [Control Mechanisms](#control-mechanisms)
6. [Implementation Patterns](#implementation-patterns)
7. [Advanced Techniques](#advanced-techniques)
8. [Security Best Practices](#security-best-practices)
9. [Debugging & Troubleshooting](#debugging--troubleshooting)
10. [Real-World Examples](#real-world-examples)

---

## Introduction

### What Are Hooks?

Claude Code hooks are user-defined shell commands that execute automatically at specific points during Claude Code's lifecycle. They provide **deterministic control** over Claude's behavior, ensuring certain actions always happen rather than relying on the LLM to choose to run them.

### The Problem Hooks Solve

Without hooks, you're dependent on Claude "remembering" instructions from your prompt:

```
❌ "Please run tests after writing code"     → May or may not happen
❌ "Always check documentation first"        → Probabilistic compliance
❌ "Format code before committing"           → Relies on LLM decision
```

With hooks, these become **guaranteed actions**:

```
✅ PostToolUse hook runs tests              → Always executes after code changes
✅ PreToolUse hook loads documentation      → Deterministically injected
✅ PreToolUse hook triggers formatter       → Runs before every commit
```

### Key Benefits

| Benefit | Description |
|---------|-------------|
| **Determinism** | Actions execute 100% of the time, not probabilistically |
| **Automation** | Remove repetitive manual interventions |
| **Consistency** | Enforce team standards across all sessions |
| **Security** | Block dangerous operations before they execute |
| **Context Injection** | Automatically provide relevant information to Claude |

---

## Core Concepts

### Hook Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLAUDE CODE SESSION                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐                                               │
│  │ SessionStart │ ← Fires when session begins                   │
│  └──────┬───────┘                                               │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────┐                                           │
│  │ UserPromptSubmit │ ← Fires when user sends a message         │
│  └──────┬───────────┘                                           │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────┐     ┌─────────────┐     ┌────────────┐        │
│  │ PreToolUse  │ ──► │ Tool Runs   │ ──► │ PostToolUse│        │
│  └─────────────┘     └─────────────┘     └────────────┘        │
│         │                                       │               │
│         │            ┌───────────────────┐      │               │
│         └──────────► │ PermissionRequest │ ◄────┘               │
│                      └───────────────────┘                      │
│                              │                                  │
│                              ▼                                  │
│                      ┌──────────────┐                           │
│                      │ Notification │ ← When Claude needs input │
│                      └──────────────┘                           │
│                              │                                  │
│                              ▼                                  │
│                      ┌──────────────┐                           │
│                      │     Stop     │ ← When Claude finishes    │
│                      └──────────────┘                           │
│                              │                                  │
│                              ▼                                  │
│                      ┌──────────────┐                           │
│                      │  SessionEnd  │ ← Session terminates      │
│                      └──────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Communication Channels

Hooks communicate with Claude through three channels:

| Channel | Purpose | How to Use |
|---------|---------|------------|
| **stdout** | Logging/transcript | `echo "message"` |
| **stderr** | Direct to Claude | `echo "message" >&2` |
| **Exit codes** | Flow control | `exit 0`, `exit 2`, etc. |

**Critical distinction:**
- `stdout` → Appears in transcript (Ctrl+O) but Claude doesn't see it
- `stderr` → **Claude processes this directly** and can act on it

---

## Hook Events Reference

### 1. SessionStart

**When:** Claude Code starts a new session or resumes an existing one

**Use Cases:**
- Load development context
- Set environment variables
- Display project status

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "cat $CLAUDE_PROJECT_DIR/.claude/context.md >&2"
      }]
    }]
  }
}
```

**Input Payload:**
```json
{
  "session_id": "abc123",
  "source": "startup" | "resume" | "clear",
  "timestamp": "2025-01-27T10:30:00Z"
}
```

### 2. Setup

**When:** Invoked with `--init`, `--init-only`, or `--maintenance` flags

**Use Cases:**
- Install dependencies
- Run migrations
- Periodic maintenance tasks

```json
{
  "hooks": {
    "Setup": [{
      "matcher": "maintenance",
      "hooks": [{
        "type": "command",
        "command": "npm install && npm run migrate"
      }]
    }]
  }
}
```

### 3. UserPromptSubmit

**When:** User submits a prompt, before Claude processes it

**Use Cases:**
- Validate prompts
- Inject additional context
- Security filtering
- Prompt enhancement

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/enhance-prompt.sh"
      }]
    }]
  }
}
```

**Input Payload:**
```json
{
  "prompt": "User's message text",
  "session_id": "abc123",
  "timestamp": "2025-01-27T10:30:00Z"
}
```

### 4. PreToolUse

**When:** Before any tool execution (after Claude creates parameters)

**Matchers:** Tool names (case-sensitive)
- `Write` - File creation
- `Edit` - File editing
- `MultiEdit` - Multiple file edits
- `Bash` - Shell commands
- `Task` - Subagent tasks
- `*` - All tools

**Use Cases:**
- Block dangerous commands
- Validate file paths
- Inject documentation
- Modify tool inputs (v2.0.10+)

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-edit.sh"
      }]
    }]
  }
}
```

**Input Payload:**
```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/src/index.ts",
    "content": "..."
  },
  "session_id": "abc123"
}
```

### 5. PostToolUse

**When:** After a tool completes successfully

**Matchers:** Same as PreToolUse

**Use Cases:**
- Run tests after code changes
- Auto-format code
- Update documentation
- Trigger CI/CD

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "npm run lint:fix && npm test"
      }]
    }]
  }
}
```

**Input Payload:**
```json
{
  "tool_name": "Write",
  "tool_input": { "file_path": "/src/index.ts", "content": "..." },
  "tool_response": { "success": true, "result": "..." },
  "session_id": "abc123"
}
```

### 6. PermissionRequest (v2.0.45+)

**When:** Claude requests permission for a tool

**Use Cases:**
- Auto-approve safe operations
- Auto-deny dangerous operations
- Custom permission logic

```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/permission-handler.sh"
      }]
    }]
  }
}
```

### 7. Notification

**When:** Claude needs user attention (permission requests, idle prompts)

**Use Cases:**
- Desktop notifications
- Slack/Discord alerts
- Mobile push notifications

```json
{
  "hooks": {
    "Notification": [{
      "hooks": [{
        "type": "command",
        "command": "ntfy publish my-alerts \"$CLAUDE_NOTIFICATION\""
      }]
    }]
  }
}
```

### 8. Stop

**When:** Claude finishes responding

**Use Cases:**
- Auto-commit changes
- Generate summaries
- Cleanup operations

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/auto-commit.sh"
      }]
    }]
  }
}
```

### 9. SubagentStop (v1.0.41+)

**When:** A subagent finishes execution

**Use Cases:**
- Aggregate subagent results
- Quality checks on subagent output

### 10. SessionEnd

**When:** Claude Code session terminates

**Use Cases:**
- Final cleanup
- Session logging
- Resource deallocation

---

## Configuration

### Configuration File Locations

Hooks can be configured at multiple levels (in order of precedence):

| Level | Location | Scope |
|-------|----------|-------|
| **User** | `~/.claude/settings.json` | All projects for this user |
| **Project** | `.claude/settings.json` | This project only |
| **Plugin** | Plugin-defined | Plugin-specific |
| **Managed** | Enterprise-controlled | Organization-wide |

### Basic Configuration Structure

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

### Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `matcher` | string | No | Pattern to match tool names (PreToolUse/PostToolUse only) |
| `hooks` | array | Yes | Array of hook definitions |
| `type` | string | Yes | `"command"` or `"prompt"` |
| `command` | string | Conditional | Shell command (for type: command) |
| `prompt` | string | Conditional | LLM prompt (for type: prompt) |
| `timeout` | number | No | Timeout in seconds (default: 60) |

### Matcher Patterns

```json
// Exact match
"matcher": "Write"

// Multiple tools (OR)
"matcher": "Write|Edit|MultiEdit"

// All tools
"matcher": "*"

// Empty/omitted = all tools
"matcher": ""
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_PROJECT_DIR` | Absolute path to project root |
| `CLAUDE_CODE_REMOTE` | `"true"` if running in web environment |
| `CLAUDE_ENV_FILE` | Path for persisting env vars (SessionStart) |
| `CLAUDE_NOTIFICATION` | Notification message (Notification hook) |

---

## Control Mechanisms

### Exit Codes

Exit codes determine how Claude Code responds to hook execution:

| Exit Code | Behavior | Use Case |
|-----------|----------|----------|
| `0` | Success - continue normally | Hook completed without issues |
| `1` | Error - operation blocked | Generic error, stops the action |
| `2` | Error + stderr shown to Claude | Block and explain why to Claude |
| `3` | Deferred execution | Postpone until conditions met |

### Practical Exit Code Examples

**Exit 0 - Allow operation:**
```bash
#!/bin/bash
# Always allow, just log
echo "Tool $TOOL_NAME executed" >> /tmp/claude-log.txt
exit 0
```

**Exit 1 - Block without explanation:**
```bash
#!/bin/bash
# Block if file is protected
if [[ "$FILE_PATH" == *".env"* ]]; then
  exit 1
fi
exit 0
```

**Exit 2 - Block with explanation to Claude:**
```bash
#!/bin/bash
# Block dangerous commands and explain to Claude
if [[ "$COMMAND" == *"rm -rf"* ]]; then
  echo "BLOCKED: Destructive command detected. Use safer alternatives." >&2
  exit 2
fi
exit 0
```

### Structured JSON Output

For complex responses, output JSON to stderr:

```bash
#!/bin/bash
cat >&2 << 'EOF'
{
  "decision": "block",
  "reason": "File is in protected directory",
  "suggestion": "Use the /tmp directory instead"
}
EOF
exit 2
```

### Input Modification (v2.0.10+)

PreToolUse hooks can modify tool inputs by outputting modified JSON to stdout:

```python
#!/usr/bin/env python3
import json
import sys

# Read original input
input_data = json.load(sys.stdin)

# Modify parameters
if input_data.get("tool_name") == "Bash":
    # Add dry-run flag to all bash commands
    original_cmd = input_data["tool_input"]["command"]
    input_data["tool_input"]["command"] = f"echo '[DRY RUN] {original_cmd}'"

# Output modified input
print(json.dumps(input_data))
```

**Key points:**
- Modifications are **invisible to Claude**
- Tool executes with modified parameters
- Enables transparent sandboxing and security enforcement

---

## Implementation Patterns

### Pattern 1: Force Documentation Reading

Ensure Claude reads relevant documentation before making changes:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/inject-docs.sh"
      }]
    }]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/inject-docs.sh

# Read the file path from stdin
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.files[0].file_path // ""')

# Determine relevant documentation based on file type/path
DOC_FILE=""

if [[ "$FILE_PATH" == *.ts ]] || [[ "$FILE_PATH" == *.tsx ]]; then
  DOC_FILE="$CLAUDE_PROJECT_DIR/docs/TYPESCRIPT_CONVENTIONS.md"
elif [[ "$FILE_PATH" == *.py ]]; then
  DOC_FILE="$CLAUDE_PROJECT_DIR/docs/PYTHON_STYLE.md"
elif [[ "$FILE_PATH" == *"api/"* ]]; then
  DOC_FILE="$CLAUDE_PROJECT_DIR/docs/API_GUIDELINES.md"
fi

# Inject documentation to stderr (Claude sees this)
if [[ -f "$DOC_FILE" ]]; then
  echo "=== REQUIRED READING: $(basename $DOC_FILE) ===" >&2
  cat "$DOC_FILE" >&2
  echo "=== END DOCUMENTATION ===" >&2
fi

exit 0
```

### Pattern 2: Automatic Testing After Changes

Run tests automatically after code modifications:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/auto-test.sh"
      }]
    }]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/auto-test.sh

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only run tests for source files
if [[ "$FILE_PATH" == *.ts ]] || [[ "$FILE_PATH" == *.tsx ]]; then
  echo "Running tests for changed files..." >&2
  
  # Run related tests
  TEST_FILE="${FILE_PATH%.ts}.test.ts"
  if [[ -f "$CLAUDE_PROJECT_DIR/$TEST_FILE" ]]; then
    npm test -- "$TEST_FILE" 2>&1 | tail -20 >&2
  else
    echo "No test file found at $TEST_FILE" >&2
  fi
fi

exit 0
```

### Pattern 3: Security Guardrails

Block dangerous operations before they execute:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/security-check.sh"
      }]
    }]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/security-check.sh

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Dangerous patterns
DANGEROUS_PATTERNS=(
  "rm -rf /"
  "rm -rf ~"
  "rm -rf \$HOME"
  "> /dev/sda"
  "mkfs"
  "dd if="
  ":(){:|:&};:"
  "chmod -R 777 /"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    echo "🚫 BLOCKED: Potentially destructive command detected" >&2
    echo "Command: $COMMAND" >&2
    echo "Pattern matched: $pattern" >&2
    exit 2
  fi
done

# Block access to sensitive files
SENSITIVE_FILES=(".env" ".ssh" "id_rsa" "credentials" "secrets")
for file in "${SENSITIVE_FILES[@]}"; do
  if [[ "$COMMAND" == *"$file"* ]]; then
    echo "🚫 BLOCKED: Access to sensitive file/directory" >&2
    exit 2
  fi
done

exit 0
```

### Pattern 4: Context Injection on Every Prompt

Automatically provide project context with every user message:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/inject-context.sh"
      }]
    }]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/inject-context.sh

echo "=== PROJECT CONTEXT ===" >&2

# Git status
echo "📁 Git Status:" >&2
git status --short 2>/dev/null | head -10 >&2

# Recent commits
echo "" >&2
echo "📜 Recent Commits:" >&2
git log --oneline -5 2>/dev/null >&2

# Active branch
echo "" >&2
echo "🌿 Current Branch: $(git branch --show-current 2>/dev/null)" >&2

# TODO items
if [[ -f "$CLAUDE_PROJECT_DIR/TODO.md" ]]; then
  echo "" >&2
  echo "📋 Current TODOs:" >&2
  head -10 "$CLAUDE_PROJECT_DIR/TODO.md" >&2
fi

echo "=== END CONTEXT ===" >&2
exit 0
```

### Pattern 5: Auto-Format Code

Automatically format code after every edit:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/auto-format.sh"
      }]
    }]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/auto-format.sh

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.files[0].file_path // ""')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

FULL_PATH="$CLAUDE_PROJECT_DIR/$FILE_PATH"

# Format based on file type
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx)
    npx prettier --write "$FULL_PATH" 2>/dev/null
    echo "✨ Formatted with Prettier: $FILE_PATH" >&2
    ;;
  *.py)
    black "$FULL_PATH" 2>/dev/null
    ruff check --fix "$FULL_PATH" 2>/dev/null
    echo "✨ Formatted with Black & Ruff: $FILE_PATH" >&2
    ;;
  *.go)
    gofmt -w "$FULL_PATH" 2>/dev/null
    echo "✨ Formatted with gofmt: $FILE_PATH" >&2
    ;;
  *.rs)
    rustfmt "$FULL_PATH" 2>/dev/null
    echo "✨ Formatted with rustfmt: $FILE_PATH" >&2
    ;;
esac

exit 0
```

### Pattern 6: Desktop Notifications

Get notified when Claude needs attention:

```json
{
  "hooks": {
    "Notification": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/notify.sh"
      }]
    }]
  }
}
```

```bash
#!/bin/bash
# .claude/hooks/notify.sh

MESSAGE="$CLAUDE_NOTIFICATION"

# macOS
if command -v osascript &> /dev/null; then
  osascript -e "display notification \"$MESSAGE\" with title \"Claude Code\""
fi

# Linux (notify-send)
if command -v notify-send &> /dev/null; then
  notify-send "Claude Code" "$MESSAGE"
fi

# ntfy (cross-platform push notifications)
if command -v curl &> /dev/null; then
  curl -s -d "$MESSAGE" ntfy.sh/my-claude-alerts &>/dev/null &
fi

exit 0
```

### Pattern 7: Auto-Commit with GitButler

Automatically manage commits after each session:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|MultiEdit|Write",
      "hooks": [{
        "type": "command",
        "command": "but claude pre-tool"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|MultiEdit|Write",
      "hooks": [{
        "type": "command",
        "command": "but claude post-tool"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "but claude stop"
      }]
    }]
  }
}
```

---

## Advanced Techniques

### Using Prompt-Type Hooks

For complex decisions, use LLM-based evaluation:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write",
      "hooks": [{
        "type": "prompt",
        "prompt": "Review this code for security vulnerabilities. If you find any issues, respond with 'BLOCK' and explain. Otherwise respond 'ALLOW'."
      }]
    }]
  }
}
```

**When to use prompt hooks:**
- Complex decisions requiring reasoning
- Context-dependent validations
- Style/quality checks

**When to use command hooks:**
- Deterministic rules
- Performance-critical checks
- External tool integrations

### Chaining Multiple Hooks

Multiple hooks on the same event run in parallel:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "npm run lint:fix"
        },
        {
          "type": "command",
          "command": "npm run test:related"
        },
        {
          "type": "command",
          "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/update-docs.sh"
        }
      ]
    }]
  }
}
```

### Conditional Execution

Use environment variables and conditionals:

```bash
#!/bin/bash
# Only run in CI environment
if [[ "$CI" == "true" ]]; then
  npm run test:coverage
  exit $?
fi

# Only run during work hours
HOUR=$(date +%H)
if [[ $HOUR -ge 9 ]] && [[ $HOUR -lt 17 ]]; then
  # Business hours logic
  echo "Running full test suite..." >&2
  npm test
else
  # Off hours - quick tests only
  npm run test:quick
fi

exit 0
```

### Stateful Hooks with Temp Files

Track state across hook invocations:

```bash
#!/bin/bash
# .claude/hooks/track-changes.sh

STATE_FILE="/tmp/claude-session-state.json"

# Initialize state if needed
if [[ ! -f "$STATE_FILE" ]]; then
  echo '{"files_changed": [], "tests_run": 0}' > "$STATE_FILE"
fi

# Read input
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Update state
jq --arg file "$FILE_PATH" '.files_changed += [$file]' "$STATE_FILE" > "${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "$STATE_FILE"

# Report state to Claude
echo "Session stats: $(cat $STATE_FILE)" >&2

exit 0
```

### Python Hooks with UV

Use UV for isolated Python hooks:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pydantic>=2.0",
# ]
# ///

import json
import sys
from pydantic import BaseModel

class ToolInput(BaseModel):
    tool_name: str
    tool_input: dict
    session_id: str

def main():
    # Parse input
    raw_input = sys.stdin.read()
    data = ToolInput.model_validate_json(raw_input)
    
    # Your logic here
    if data.tool_name == "Write":
        file_path = data.tool_input.get("file_path", "")
        if ".env" in file_path:
            print("BLOCKED: Cannot write to .env files", file=sys.stderr)
            sys.exit(2)
    
    sys.exit(0)

if __name__ == "__main__":
    main()
```

---

## Security Best Practices

### Input Validation

```bash
#!/bin/bash

# Always quote variables
FILE_PATH="$1"  # ✅ Correct
FILE_PATH=$1    # ❌ Vulnerable to injection

# Validate input exists
if [[ -z "$FILE_PATH" ]]; then
  echo "Error: No file path provided" >&2
  exit 1
fi

# Block path traversal
if [[ "$FILE_PATH" == *".."* ]]; then
  echo "Error: Path traversal detected" >&2
  exit 2
fi
```

### Sensitive File Protection

```bash
#!/bin/bash

SENSITIVE_PATTERNS=(
  ".env"
  ".env.*"
  "*.pem"
  "*.key"
  "*credentials*"
  "*secret*"
  ".ssh/*"
  ".git/config"
)

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

for pattern in "${SENSITIVE_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == $pattern ]]; then
    echo "🔒 BLOCKED: Access to sensitive file: $FILE_PATH" >&2
    exit 2
  fi
done

exit 0
```

### Command Sanitization

```bash
#!/bin/bash

# Never pass user input directly to eval
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Use allowlist approach
ALLOWED_COMMANDS=("npm" "yarn" "pnpm" "git" "python" "node")

FIRST_WORD=$(echo "$COMMAND" | awk '{print $1}')

ALLOWED=false
for cmd in "${ALLOWED_COMMANDS[@]}"; do
  if [[ "$FIRST_WORD" == "$cmd" ]]; then
    ALLOWED=true
    break
  fi
done

if [[ "$ALLOWED" == "false" ]]; then
  echo "BLOCKED: Command not in allowlist: $FIRST_WORD" >&2
  exit 2
fi

exit 0
```

### Timeout Configuration

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "npm test",
        "timeout": 120
      }]
    }]
  }
}
```

---

## Debugging & Troubleshooting

### Enable Hook Logging

Create a wrapper that logs all hook executions:

```bash
#!/bin/bash
# .claude/hooks/wrapper.sh

LOG_FILE="$CLAUDE_PROJECT_DIR/.claude/hooks.log"

# Log invocation
echo "[$(date -Iseconds)] Hook: $0" >> "$LOG_FILE"
echo "  Input: $(cat | tee /dev/stdin)" >> "$LOG_FILE"

# Run actual hook
"$CLAUDE_PROJECT_DIR/.claude/hooks/actual-hook.sh"
EXIT_CODE=$?

echo "  Exit: $EXIT_CODE" >> "$LOG_FILE"
exit $EXIT_CODE
```

### Common Issues

**1. Hooks not firing:**
- Check `/hooks` menu in Claude Code - changes require review
- Verify matcher pattern matches tool name exactly (case-sensitive)
- Ensure hook file is executable: `chmod +x hook.sh`

**2. Hooks timeout:**
- Default timeout is 60 seconds
- Long-running tasks should use `run_in_background: true`
- Increase timeout in configuration

**3. stderr not reaching Claude:**
- Ensure output goes to stderr: `echo "message" >&2`
- Check exit code is 2 for messages to be processed

**4. Input parsing fails:**
- Use `jq` for JSON parsing
- Handle missing fields with defaults: `jq -r '.field // ""'`

### Testing Hooks Manually

```bash
# Test hook with sample input
echo '{"tool_name":"Write","tool_input":{"file_path":"test.ts"}}' | \
  .claude/hooks/my-hook.sh

# Check exit code
echo "Exit code: $?"
```

---

## Real-World Examples

### Example 1: Full Development Workflow

Complete configuration for a TypeScript project:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "cat $CLAUDE_PROJECT_DIR/CLAUDE.md >&2"
      }]
    }],
    
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "echo '📍 Branch: '$(git branch --show-current) >&2"
      }]
    }],
    
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{
          "type": "command",
          "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-conventions.sh"
        }]
      },
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/security-check.sh"
        }]
      }
    ],
    
    "PostToolUse": [{
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [
        {
          "type": "command",
          "command": "npx prettier --write $(echo '$INPUT' | jq -r '.tool_input.file_path')"
        },
        {
          "type": "command",
          "command": "npx eslint --fix $(echo '$INPUT' | jq -r '.tool_input.file_path')"
        }
      ]
    }],
    
    "Notification": [{
      "hooks": [{
        "type": "command",
        "command": "osascript -e 'display notification \"$CLAUDE_NOTIFICATION\" with title \"Claude\"'"
      }]
    }],
    
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-summary.sh"
      }]
    }]
  }
}
```

### Example 2: Documentation-First Development

Force Claude to read and follow documentation:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo '=== PROJECT DOCUMENTATION ===' >&2 && find $CLAUDE_PROJECT_DIR/docs -name '*.md' -exec echo '📄 {}' \\; >&2"
      }]
    }],
    
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/inject-relevant-docs.sh"
        },
        {
          "type": "prompt",
          "prompt": "Before proceeding, verify this change follows the project's documented conventions. If it doesn't, suggest modifications."
        }
      ]
    }],
    
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "prompt",
        "prompt": "Check if this code change requires documentation updates. If yes, list the documentation files that should be updated."
      }]
    }]
  }
}
```

### Example 3: Secret Detection Hook

Prevent accidental secret commits:

```python
#!/usr/bin/env python3
# .claude/hooks/secret-detector.py

import json
import re
import sys

# Patterns that indicate potential secrets
SECRET_PATTERNS = [
    (r'api[_-]?key\s*[=:]\s*["\']?[\w-]{20,}', 'API Key'),
    (r'secret[_-]?key\s*[=:]\s*["\']?[\w-]{20,}', 'Secret Key'),
    (r'password\s*[=:]\s*["\']?[^\s"\']{8,}', 'Password'),
    (r'token\s*[=:]\s*["\']?[\w-]{20,}', 'Token'),
    (r'-----BEGIN (?:RSA |DSA |EC )?PRIVATE KEY-----', 'Private Key'),
    (r'ghp_[a-zA-Z0-9]{36}', 'GitHub PAT'),
    (r'sk-[a-zA-Z0-9]{48}', 'OpenAI API Key'),
    (r'AKIA[0-9A-Z]{16}', 'AWS Access Key'),
]

def main():
    input_data = json.load(sys.stdin)
    content = input_data.get('tool_input', {}).get('content', '')
    
    findings = []
    for pattern, name in SECRET_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            findings.append(name)
    
    if findings:
        print(f"🚨 BLOCKED: Potential secrets detected: {', '.join(findings)}", file=sys.stderr)
        print("Please remove sensitive data before committing.", file=sys.stderr)
        sys.exit(2)
    
    sys.exit(0)

if __name__ == "__main__":
    main()
```

---

## Quick Reference

### Hook Events Summary

| Event | When | Has Matcher | Common Use |
|-------|------|-------------|------------|
| SessionStart | Session begins | No | Context loading |
| Setup | With init/maintenance flags | Yes | Dependencies |
| UserPromptSubmit | User sends message | No | Prompt enhancement |
| PreToolUse | Before tool runs | Yes | Validation, blocking |
| PostToolUse | After tool completes | Yes | Testing, formatting |
| PermissionRequest | Claude asks permission | Yes | Auto-approve/deny |
| Notification | Claude needs attention | No | Alerts |
| Stop | Claude finishes | No | Commits, cleanup |
| SubagentStop | Subagent finishes | No | Aggregation |
| SessionEnd | Session terminates | No | Final cleanup |

### Exit Codes Quick Reference

| Code | Result | Claude Sees stderr? |
|------|--------|---------------------|
| 0 | Continue | No |
| 1 | Block | No |
| 2 | Block | Yes |
| 3 | Defer | No |

### Essential Commands

```bash
# View/manage hooks
/hooks

# Review pending hook changes
# (Required after editing settings.json)

# Test a hook manually
echo '{"tool_name":"Write","tool_input":{}}' | ./hook.sh
echo $?

# Debug hook output
./hook.sh 2>&1 | cat

# Make hook executable
chmod +x .claude/hooks/*.sh
```

---

## Conclusion

Claude Code hooks transform AI-assisted development from probabilistic suggestions to deterministic automation. By implementing hooks strategically, you can:

- **Enforce standards** automatically
- **Inject context** at the right moments
- **Block dangerous operations** before they execute
- **Automate repetitive tasks** reliably
- **Integrate with your existing toolchain** seamlessly

Start with simple logging hooks to understand the lifecycle, then progressively add more sophisticated automation as your confidence grows.

---

*Last updated: January 2025*
*Compatible with Claude Code v2.0.45+*
