# Triqual Architecture

> Technical documentation for Triqual plugin internals

## Overview

Triqual is a Claude Code plugin that implements an **autonomous test generation loop** with enforced documentation, self-healing capabilities, and persistent learning. This document describes the technical architecture and component interactions.

## Core Design Principles

### 1. Documentation-First Development

Every test must be documented BEFORE code is written:

```
ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN
```

This is enforced through blocking hooks that prevent writing test code until documentation exists.

### 2. Draft-First Pattern

Tests are developed in a `.draft/` staging area:

```
.draft/tests/login.spec.ts    # Work in progress
tests/login.spec.ts           # Promoted after passing
```

This prevents broken tests from entering the main test suite.

### 3. Blocking Enforcement

Hooks use exit codes to control Claude's behavior:

| Exit Code | Effect |
|-----------|--------|
| 0 | Allow action |
| 1 | Block silently |
| 2 | Block + message to Claude |

### 4. Persistent Learning

Knowledge survives sessions through file-based storage:

- `.triqual/runs/{feature}.md` - Per-feature run logs
- `.triqual/knowledge.md` - Accumulated project patterns
- `~/.cache/triqual/` - Session state (ephemeral)

## Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TRIQUAL PLUGIN                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│   │   SKILLS    │  │    HOOKS    │  │   AGENTS    │                 │
│   │             │  │             │  │             │                 │
│   │  /init      │  │  session    │  │  planner    │                 │
│   │  /test      │  │  pre-write  │  │  generator  │                 │
│   │  /check     │  │  post-run   │  │  healer     │                 │
│   │  /rules     │  │  subagent   │  │  classifier │                 │
│   │  /help      │  │  compact    │  │  learner    │                 │
│   │             │  │  stop       │  │             │                 │
│   └─────────────┘  └─────────────┘  └─────────────┘                 │
│          │                │                │                         │
│          └────────────────┼────────────────┘                        │
│                           │                                          │
│                           ▼                                          │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                     MCP INTEGRATION                          │   │
│   │                                                              │   │
│   │  ┌───────────┐    ┌───────────┐    ┌───────────────────┐    │   │
│   │  │   Quoth   │    │  Exolar   │    │   Playwright MCP  │    │   │
│   │  │           │    │           │    │                   │    │   │
│   │  │ patterns  │    │ analytics │    │ browser control   │    │   │
│   │  │ docs      │    │ failures  │    │ app exploration   │    │   │
│   │  │ guidelines│    │ trends    │    │ verification      │    │   │
│   │  └───────────┘    └───────────┘    └───────────────────┘    │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Skills Layer

Skills are slash commands that users invoke directly.

### /init

**Purpose:** Initialize Triqual for a project

**Creates:**
- `.triqual/runs/` - Directory for run logs
- `.triqual/knowledge.md` - Project patterns file
- `triqual.config.ts` - Configuration file

**Detection:**
- Finds existing test directories
- Identifies Page Object patterns
- Detects authentication strategy
- Reads package.json for dependencies

### /test

**Purpose:** Unified test generation

**Modes:**
| Mode | Trigger | Behavior |
|------|---------|----------|
| Full | `/test login` | Complete autonomous loop |
| Explore | `/test --explore login` | Browser exploration only |
| Ticket | `/test --ticket ENG-123` | From Linear ticket |
| Describe | `/test --describe "..."` | From text description |

**Orchestration:**
1. Invokes `test-planner` agent
2. Invokes `test-generator` agent
3. Invokes `test-healer` agent (autonomous loop)
4. On success, invokes `pattern-learner` agent

### /check

**Purpose:** Lint tests for best practice violations

**Scans:**
- All `.spec.ts` files in test directory
- Checks against 31 Playwright rules
- Groups by category and severity

**Output:**
- Violation count per category
- File:line references
- Suggested fixes

### /rules

**Purpose:** Display Playwright best practices

**Categories:**
1. Locators (3 rules)
2. Selectors (3 rules)
3. Waits (4 rules)
4. Assertions (4 rules)
5. Page Objects (4 rules)
6. Test Organization (5 rules)
7. Networking (4 rules)
8. Debug (4 rules)

### /help

**Purpose:** Interactive help and troubleshooting

**Topics:**
- Getting started
- MCP setup
- Hook debugging
- Common issues

## Hooks Layer

Hooks intercept Claude Code events and enforce documentation requirements.

### Hook Configuration

```json
// hooks/hooks.json
{
  "hooks": [
    {
      "event": "SessionStart",
      "command": "./session-start.sh"
    },
    {
      "event": "PreToolUse",
      "matcher": { "tool_name": "^(Edit|Write)$" },
      "command": "./pre-spec-write.sh"
    }
  ]
}
```

### Hook Communication Protocol

```
┌──────────────────────────────────────────────────────────────────┐
│                    HOOK COMMUNICATION                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│   Claude Code                              Hook Script            │
│       │                                        │                  │
│       │─────── JSON via stdin ────────────────►│                  │
│       │        {                               │                  │
│       │          "event": "PreToolUse",        │                  │
│       │          "tool_name": "Write",         │                  │
│       │          "tool_input": {...}           │                  │
│       │        }                               │                  │
│       │                                        │                  │
│       │◄────── exit code + stderr ─────────────│                  │
│       │        exit 0 = allow                  │                  │
│       │        exit 1 = block silent           │                  │
│       │        exit 2 = block + message        │                  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Hook Implementations

#### session-start.sh
- Initializes session state in `~/.cache/triqual/`
- Detects active run logs
- Clears stale flags
- Provides session guidance

#### pre-spec-write.sh (BLOCKING)
- Triggers on Edit/Write of `.spec.ts` files
- Checks for run log existence
- Verifies ANALYZE/RESEARCH/PLAN/WRITE stages documented
- Blocks with instructions if missing

#### pre-retry-gate.sh (BLOCKING)
- Triggers before `playwright test` commands
- Tracks attempt count per feature
- At 2+ same-category failures: Requires external research
- At 12+ attempts: Requires deep analysis
- At 25+ attempts: Requires `.fixme()` or justification

#### post-test-run.sh
- Triggers after `playwright test` commands
- Sets `awaiting_log_update` flag
- Captures test results for logging

#### subagent-start.sh
- Triggers before agent execution
- Injects context (run log, knowledge file)
- Tells agent what to read

#### subagent-stop.sh
- Triggers after agent completion
- Instructs agent to update run log
- Suggests next agent in sequence

#### pre-compact.sh
- Triggers before context compaction
- Preserves critical state
- Ensures learnings survive

#### stop.sh
- Triggers at session end
- Checks for missing accumulated learnings
- Writes session summary

### Shared Utilities (lib/common.sh)

~1000 lines of helper functions:

```bash
# Input handling
read_hook_input()      # Read JSON from stdin (macOS compatible)
get_hook_input()       # Return cached input
validate_hook_input()  # Validate JSON structure

# JSON parsing
get_json_field()       # Extract field (jq with fallback)
get_tool_name()        # Get tool_name from input
get_file_path()        # Extract file path from tool_input

# Run log helpers
get_run_log_path()     # Get path for feature
run_log_exists()       # Check existence
has_stage()            # Check if stage documented
get_attempt_count()    # Get current attempt number

# Session state
init_session_state()   # Initialize session
get_session_value()    # Read session state
set_session_value()    # Write session state
increment_counter()    # Atomic counter increment

# Configuration
find_config()          # Find triqual.config.ts
read_config_value()    # Read config field
get_test_dir()         # Get configured test directory
```

## Agents Layer

All agents run on **Opus 4.5** for maximum capability.

### Agent Frontmatter Format

```yaml
---
model: opus
color: purple
description: |
  Use this agent when [trigger conditions].
  Examples: "plan tests for X", "create test plan"
tools:
  - Read
  - Write
  - Bash
  - mcp__quoth__*
  - mcp__exolar__*
---
```

### test-planner

**Color:** Purple
**Role:** Creates test plan from requirements

**Workflow:**
1. Parse input (feature name, ticket, description)
2. Search Quoth for relevant patterns
3. Query Exolar for similar tests
4. Explore app with Playwright MCP (if enabled)
5. Fetch Linear ticket details (if provided)
6. Create run log with ANALYZE/RESEARCH/PLAN stages

**Output:** `.triqual/runs/{feature}.md` with documented plan

### test-generator

**Color:** Green
**Role:** Generate test code from plan

**Workflow:**
1. Read PLAN stage from run log
2. Read `.triqual/knowledge.md` for patterns
3. Generate Playwright test code
4. Create Page Objects if needed
5. Write to `.draft/tests/{feature}.spec.ts`
6. Document WRITE stage with hypothesis

**Output:** Draft test file ready for execution

### test-healer

**Color:** Blue
**Role:** Autonomous test fixing loop

**Workflow:**
```
┌─────────────────────────────────────────────┐
│           TEST-HEALER LOOP                   │
├─────────────────────────────────────────────┤
│                                              │
│   START                                      │
│     │                                        │
│     ▼                                        │
│   RUN TEST ◄─────────────────────┐          │
│     │                             │          │
│     ├── PASS ──► PROMOTE ──► EXIT │          │
│     │                             │          │
│     └── FAIL ──► CLASSIFY ──► FIX ┘          │
│                    │                         │
│                    ├── Attempt 12: Deep      │
│                    │   analysis phase        │
│                    │                         │
│                    └── Attempt 25: .fixme()  │
│                        or justify            │
│                                              │
└─────────────────────────────────────────────┘
```

**Autonomous Behavior:**
- No user confirmation at each step
- Loops until PASS or max attempts
- Documents every RUN and FIX stage

### failure-classifier

**Color:** Orange
**Role:** Categorize test failures

**Categories:**
| Category | Description | Action |
|----------|-------------|--------|
| FLAKE | Intermittent failure | Add retry, investigate timing |
| BUG | Application bug | Report issue, mark test |
| ENV_ISSUE | Environment problem | Fix environment, retry |
| TEST_ISSUE | Test code problem | Fix test code |

**Workflow:**
1. Analyze error message and stack trace
2. Query Exolar for historical patterns
3. Check for known flaky patterns
4. Classify and recommend action

### pattern-learner

**Color:** Purple
**Role:** Extract and persist learnings

**Triggers:**
- Same error type 3+ times
- Same fix works 3+ times
- User requests "document this pattern"
- Session ending

**Workflow:**
1. Review all run logs
2. Identify recurring patterns
3. Update `.triqual/knowledge.md`
4. Propose patterns to Quoth (optional)

## MCP Integration

### Configuration (.mcp.json)

```json
{
  "mcpServers": {
    "quoth": {
      "type": "http",
      "url": "https://quoth.ai-innovation.site/api/mcp"
    },
    "exolar-qa": {
      "type": "http",
      "url": "https://exolar.ai-innovation.site/api/mcp/mcp"
    }
  }
}
```

### Quoth Integration

**Purpose:** Semantic pattern documentation

**Tools:**
- `quoth_search_index({ query })` - Search for patterns
- `quoth_read_doc({ docId })` - Read full documentation
- `quoth_guidelines({ mode })` - Get coding guidelines

**Use Cases:**
- Find existing patterns for common scenarios
- Learn best practices for specific frameworks
- Share learned patterns with team

### Exolar Integration

**Purpose:** Test analytics and failure clustering

**Datasets:**
- `test_search` - Find existing tests by name/content
- `test_history` - Get failure history for a test
- `failure_patterns` - Analyze failure clusters

**Use Cases:**
- Find similar tests in project
- Check if failure is known flake
- Analyze failure trends

### Playwright MCP Integration

**Purpose:** Browser automation for app exploration

**Tools:**
- `browser_navigate({ url })` - Navigate to page
- `browser_snapshot()` - Get accessibility tree
- `browser_click({ element, ref })` - Click element
- `browser_type({ element, ref, text })` - Type text

**Use Cases:**
- Explore app behavior during RESEARCH phase
- Verify test expectations
- Discover element selectors

## File System Layout

### Plugin Structure

```
triqual-plugin/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── .mcp.json                     # MCP server config
├── skills/                       # Slash commands
│   ├── init/SKILL.md
│   ├── test/SKILL.md
│   ├── check/SKILL.md
│   ├── rules/SKILL.md
│   └── help/SKILL.md
├── hooks/                        # Event handlers
│   ├── hooks.json
│   ├── lib/common.sh
│   └── *.sh
├── .agents/                      # AI agents
│   └── *.md
├── context/                      # Templates
│   ├── run-log.template.md
│   ├── knowledge.template.md
│   └── config.template.ts
└── docs/
    ├── playwright-rules/
    └── references/
```

### Project Structure (After /init)

```
your-project/
├── .triqual/
│   ├── runs/                    # Run logs
│   │   └── {feature}.md
│   └── knowledge.md             # Project patterns
├── .draft/                      # Staging area
│   ├── tests/
│   └── pages/
├── tests/                       # Production tests
├── pages/                       # Page Objects
└── triqual.config.ts            # Configuration
```

### Session State

```
~/.cache/triqual/
└── session-{id}.json
    {
      "hints_delivered": ["welcome", "mcp_auth"],
      "tool_counts": { "Edit": 5, "Bash": 12 },
      "test_runs": { "passed": 3, "failed": 1, "healed": 1 },
      "awaiting_log_update": false,
      "active_feature": "login"
    }
```

## Error Handling

### Hook Failures

When a hook fails unexpectedly:
1. Exit code 1 silently blocks
2. Exit code 2 provides error message
3. Non-zero exits other than 1/2 are logged

### MCP Failures

When MCP servers are unreachable:
1. Agents continue without external data
2. Warning message shown to user
3. Local patterns used as fallback

### Agent Failures

When an agent fails:
1. Error captured in run log
2. SubagentStop hook provides guidance
3. User can resume or start fresh

## Performance Considerations

### Hook Efficiency

- Hooks should complete in <100ms
- Use file caching for repeated reads
- Avoid network calls in hooks

### Agent Context

- Agents receive minimal necessary context
- SubagentStart injects only relevant files
- Knowledge file kept concise

### Session State

- Uses file locking for concurrent access
- JSON parsing with jq (with fallback)
- Atomic writes for state updates

## Security

### File Access

- Hooks only access project files
- Session state in user cache directory
- No network access from hooks

### MCP Authentication

- OAuth flow for Quoth/Exolar
- Credentials stored by Claude Code
- Per-session authentication

### Input Validation

- All hook inputs validated
- File paths sanitized
- JSON parsed safely
