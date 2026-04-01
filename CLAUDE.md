# Triqual - Autonomous Test Automation Plugin

> **Version 1.4.0** | Opus 4.5 Agents | Dynamic Context Loading | macOS & Linux

Triqual is a **Claude Code plugin** that brings autonomous, self-healing test generation with enforced documentation and persistent learning. It combines three MCP integrations:

- **Quoth** - Semantic pattern documentation (auto-installed)
- **Exolar** - Test analytics and failure clustering (auto-installed)
- **Playwright MCP** - Browser automation for app exploration

## Installation

```bash
# From marketplace
/plugin marketplace add Montinou/triqual
/plugin install triqual-plugin@triqual

# Or local development
claude --plugin-dir /path/to/triqual/triqual-plugin
```

**What gets installed automatically:**
- MCP servers: `quoth`, `exolar-qa`, `triqual-context` (via `.mcp.json`)
- 7 hooks: SessionStart, PreToolUse (3), PostToolUse, SubagentStart, SubagentStop, PreCompact, Stop
- 5 skills: `/init`, `/test`, `/check`, `/rules`, `/help`
- 5 agents: test-planner, test-generator, test-healer, failure-classifier, pattern-learner
- 31 Playwright best practice rules (8 categories)
- Context templates for project configuration

## Quick Start

### Initialize (First Time)

```bash
/init                          # Analyze project & generate config + .triqual/ directory
```

### Unified Test Generation

```bash
/test login              # Full autonomous (analyze → research → plan → write → run → learn)
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

## Documented Learning Loop (NEW)

Triqual enforces a **documented learning loop** that prevents erratic workflows and ensures context survives compaction:

```
ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN
```

### How It Works

1. **Hooks use exit codes to BLOCK actions** until documentation is complete
2. **Run logs** at `.triqual/runs/{feature}.md` track each stage
3. **Knowledge file** at `.triqual/knowledge.md` accumulates project-specific patterns
4. **Context survives compaction** because it's in files, not just memory

### Gate-Based Enforcement

| Gate | Trigger | Block Condition | Unblock Action |
|------|---------|-----------------|----------------|
| **Draft Folder** | Write .spec.ts | **File path NOT in .draft/ (and file doesn't already exist)** | **Write to .draft/tests/ instead** |
| Pre-Write | Write .spec.ts | No run log or missing ANALYZE/RESEARCH/PLAN | Create log, document stages |
| **Context Files** | Write .spec.ts | **No context files at .triqual/context/{feature}/** | **Call triqual_load_context({ feature }) tool** |
| Post-Run | After playwright test | Log not updated with results | Add RUN stage with results |
| Retry Limit | 2+ same-category fails | No Quoth/Exolar search | Document external research |
| Deep Analysis | 12+ attempts | No deep analysis documented | Perform expanded Quoth/Exolar research |
| Max Attempts | 25+ total attempts | No .fixme() or justification | Mark fixme or justify |
| **Promotion** | test-healer SUCCESS | **Auto-promotion blocked** | **User must explicitly approve** |
| Session End | Stop hook | No learnings section | Add accumulated learnings |

### Intelligent Context Loading (v1.4.0)

**BEFORE writing ANY test code**, call the `triqual_load_context` MCP tool:

```javascript
triqual_load_context({ feature: "login" })
```

If you have a Linear ticket:
```javascript
triqual_load_context({ feature: "login", ticket: "ENG-123" })
```

#### How It Works

The tool **automatically analyzes your request** and optimizes context loading:

- **Feature complexity** — Complex features (auth, checkout, workflows) get deeper analysis
- **Test history** — Features with failed runs get additional failure patterns
- **Existing tests** — Simple features with existing tests use fast local scan
- **Successful patterns** — Features that passed before use lightweight refresh

This intelligent optimization **saves ~70% tokens on average** without any manual configuration.

#### Output Files

Context files are written to `.triqual/context/{feature}/` automatically:
- `patterns.md` — Proven patterns from Quoth
- `codebase.md` — Relevant source files, selectors, routes
- `existing-tests.md` — Reusable tests and page objects
- `summary.md` — Index of all context

Additional files are included when needed based on complexity:
- `anti-patterns.md` — Known failures to avoid
- `failures.md` — Exolar failure history
- `requirements.md` — Ticket details (when ticket provided)

This is **ENFORCED by hooks** — test writing and test-planner dispatch will be BLOCKED until context files exist.

**Why this is mandatory:**
- Context files contain proven patterns from Quoth and project history
- Intelligent optimization reduces token usage while ensuring quality
- Patterns learned from past failures help you succeed faster

### Run Log Structure

Each feature gets a run log at `.triqual/runs/{feature}.md`:

```markdown
# Test Run Log: login-flow

## Session: 2026-01-27T10:30:00Z

### Stage: ANALYZE
- Acceptance criteria from requirements
- User flows to test
- Test cases identified

### Stage: RESEARCH
- Quoth patterns found
- Exolar similar tests
- Available Page Objects, helpers, fixtures, test data

### Stage: PLAN
- Test strategy and priorities
- Tools/resources to use
- New artifacts to create

### Stage: WRITE
**Hypothesis:** [Approach and rationale]

### Stage: RUN (Attempt 1)
**Result:** FAILED
**Category:** WAIT
**Analysis:** Dashboard loads async, URL changes before content ready

### Stage: FIX (Attempt 1)
**Hypothesis:** Add networkidle wait after login

### Stage: RUN (Attempt 2)
**Result:** PASSED

### Stage: LEARN
**Pattern:** This project requires networkidle wait after auth redirects

## Accumulated Learnings
1. Login buttons use data-testid="login-submit"
2. Dashboard requires networkidle wait after redirect
```

## MCP Servers (Auto-Installed)

The plugin automatically installs these MCP servers:

| Server | URL | Purpose |
|--------|-----|---------|
| `quoth` | `https://quoth.triqual.dev/api/mcp/sse` | Pattern documentation |
| `exolar-qa` | `https://exolar.triqual.dev/api/mcp/mcp` | Test analytics |
| `quoth-learning` | `~/.quoth/daemon.js` (local stdio) | Pattern scoring and outcome logging |

**On first run**, Claude Code will prompt for OAuth authentication for each server.

### Available MCP Tools

**Quoth Tools (Persisting Live Docs):**
- `quoth_search_index({ query })` - Search documentation patterns
- `quoth_read_doc({ docId })` - Read full document
- `quoth_guidelines({ mode })` - Get coding guidelines

**Exolar Tools (CI Analytics Database):**
- `query_exolar_data({ dataset, filters })` - Fetch test results, failures, trends

**Quoth-Learning Tools (Local stdio — pattern scoring):**
- `quoth_log_outcome({ patternId, result })` - Record success/failure for a pattern
- `quoth_score_pattern({ patternId, delta })` - Manually adjust confidence score
- `quoth_top_patterns({ limit?, tags? })` - Get top-N patterns by confidence
- `quoth_seed_from_exolar({ dataset?, projectId? })` - Import Exolar failure clusters as candidates
- `quoth_daemon_status({})` - Check if learning daemon is running

**Playwright MCP (Autonomous App Verification):**
- `browser_navigate`, `browser_snapshot`, `browser_click`, etc. - Explore app behavior

## Hooks (BLOCKING Enforcement)

| Hook | Trigger | Action |
|------|---------|--------|
| SessionStart | Session begins + after compaction | Initialize session, detect active run logs, show guidance |
| PreToolUse (Edit/Write) | Writing .spec.ts | **BLOCK** if ANALYZE/RESEARCH/PLAN/WRITE stages not documented |
| PreToolUse (Bash) | Before playwright test | **BLOCK** if retry limits exceeded without external research |
| PostToolUse (Bash) | After playwright test | Set flag requiring run log update before next action |
| **SubagentStart** | Before agent runs | **INJECT CONTEXT** - tells agent what to read (run log, knowledge, Quoth) |
| SubagentStop | After agent completes | Instruct to update run log with agent findings, suggest next step |
| PreCompact | Before context compaction | Preserve run log state and critical context |
| Stop | Session ends | Check for missing accumulated learnings |

### Hook Exit Codes

| Exit Code | Effect |
|-----------|--------|
| 0 | Continue - action proceeds |
| 1 | Block silently |
| **2** | **Block + stderr message sent to Claude** |

Hooks use exit code 2 to block actions AND tell Claude what documentation is needed.

### Example: Blocked Action

```
🚫 BLOCKED: No run log found for "login"

Before writing test code, you MUST create a run log at:
.triqual/runs/login.md

Required stages:
1. ANALYZE - Review requirements, identify test cases
2. RESEARCH - Search Quoth for patterns, check Exolar for similar tests
3. PLAN - Document test strategy, tools/helpers to use
4. WRITE - Document hypothesis

Then retry this write operation.
```

## Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| init | `/init` | Initialize Triqual (creates .triqual/ directory, generates config) |
| test | `/test login` | Full autonomous test generation with documented loop |
| test (explore) | `/test --explore login` | Interactive browser exploration only |
| test (ticket) | `/test --ticket ENG-123` | Generate tests from Linear ticket acceptance criteria |
| test (describe) | `/test --describe "..."` | Generate tests from user text description |
| check | `/check` | Lint tests for Playwright best practice violations |
| rules | `/rules` | Comprehensive Playwright best practices (31 rules, 8 categories) |
| help | `/help` | Get help with Triqual features and troubleshooting |

## Agents

Triqual includes 5 specialized agents plus the `triqual_load_context` MCP tool:

### The Agentic Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRIQUAL AGENT LOOP                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Request (ticket, description, feature name)               │
│        ↓                                                         │
│  ┌──────────────────┐                                            │
│  │LOAD CONTEXT (MCP)│ ← triqual_load_context({ feature })        │
│  │  (subprocess)    │   Writes .triqual/context/{feature}/       │
│  └──────┬───────────┘                                            │
│         ↓                                                        │
│  ┌──────────────┐                                                │
│  │ TEST-PLANNER │ ← Reads context files, creates ANALYZE/PLAN    │
│  │   (purple)   │   Creates run log with test plan               │
│  └──────┬───────┘                                                │
│         ↓                                                        │
│  ┌──────────────┐                                                │
│  │TEST-GENERATOR│ ← WRITE stage                                  │
│  │   (green)    │   Generates test code from plan                │
│  └──────┬───────┘                                                │
│         ↓                                                        │
│  ┌──────────────┐                                                │
│  │   RUN TEST   │ ← RUN stage                                    │
│  │   (bash)     │   npx playwright test                          │
│  └──────┬───────┘                                                │
│         │                                                        │
│    ┌────┴────┐                                                   │
│   PASS      FAIL                                                 │
│    ↓         ↓                                                   │
│  LEARN   ┌──────────────────┐                                    │
│    ↓     │FAILURE-CLASSIFIER│ ← Categorizes the failure          │
│ pattern- │    (orange)      │                                    │
│ learner  └────────┬─────────┘                                    │
│                   ↓                                              │
│            ┌──────────────┐                                      │
│            │ TEST-HEALER  │ ← FIX stage (up to 3 attempts)       │
│            │    (blue)    │   Then back to RUN                   │
│            └──────┬───────┘                                      │
│                   ↓                                              │
│              RUN TEST (loop)                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Agent Reference

| Agent | Role | Triggers On | Action |
|-------|------|-------------|--------|
| **test-planner** | 🎯 Plan | "plan tests for X", Linear ticket, `/test` start | Creates run log with ANALYZE/RESEARCH/PLAN stages |
| **test-generator** | 🔨 Generate | After test-planner, "generate from plan" | Reads PLAN, generates test code, documents WRITE stage |
| **test-healer** | 🔧 Fix | Test failure, "fix failing tests" | Analyzes failure, applies fix, documents FIX stage |
| **failure-classifier** | 📊 Classify | "is this a flake?", unclear failures | Classifies as FLAKE/BUG/ENV/TEST_ISSUE |
| **pattern-learner** | 📚 Learn | Repeated fixes, session end, explicit request | Extracts patterns, updates knowledge.md, proposes to Quoth |

### MCP Tool: triqual_load_context

Deterministic MCP tool that spawns a headless Sonnet subprocess to build comprehensive context:

```
triqual_load_context({ feature: "login", ticket?: "ENG-123", description?: "...", force?: false })
```

Spawns a headless Claude subprocess (Sonnet) that builds `.triqual/context/{feature}/` with:
- `patterns.md` — Quoth proven patterns
- `anti-patterns.md` — Known failures to avoid
- `codebase.md` — Relevant source files, selectors, routes
- `existing-tests.md` — Reusable tests and page objects
- `failures.md` — Exolar failure history
- `requirements.md` — Ticket/description (if provided)
- `summary.md` — Index of all context

### Agent Details

**test-planner (purple)**
- Reads pre-built context files at `.triqual/context/{feature}/`
- Explores app with Playwright MCP
- Fetches Linear ticket details (if provided)
- Creates run log with comprehensive plan

**test-generator (green)**
- Reads PLAN stage from run log
- Reads project knowledge.md
- Generates Playwright test code
- Creates Page Objects if needed
- Documents WRITE stage with hypothesis

**test-healer (blue)** - Autonomous Loop Agent
- Runs tests, analyzes failures, applies fixes autonomously
- Loops until tests PASS or 25 attempts reached
- Deep analysis phase at attempt 12
- Works on files in `.draft/` folder
- Promotes to final location on SUCCESS
- Documents every RUN and FIX stage

**failure-classifier (orange)**
- Analyzes failure patterns
- Queries Exolar for historical data
- Classifies failure type
- Recommends next action

**pattern-learner (purple)**
- Reviews all run logs
- Identifies recurring patterns
- Updates knowledge.md
- Proposes patterns to Quoth

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
│   │   ├── test/SKILL.md
│   │   ├── check/SKILL.md
│   │   ├── rules/SKILL.md
│   │   └── help/SKILL.md
│   ├── hooks/                   # Hooks at plugin root (auto-discovered)
│   │   ├── hooks.json
│   │   ├── lib/common.sh        # Shared functions (run log helpers, etc.)
│   │   ├── session-start.sh
│   │   ├── pre-spec-write.sh    # BLOCKING: enforces documentation
│   │   ├── pre-retry-gate.sh    # BLOCKING: enforces retry limits
│   │   ├── post-test-run.sh
│   │   ├── subagent-start.sh    # INJECT: context before agents run
│   │   ├── subagent-stop.sh     # GUIDE: next steps after agents complete
│   │   ├── pre-compact.sh
│   │   └── stop.sh
│   ├── agents/
│   │   ├── test-planner.md       # ANALYZE/RESEARCH/PLAN stages
│   │   ├── test-generator.md     # WRITE stage - generates code from plan
│   │   ├── test-healer.md        # FIX stage - auto-heal failures
│   │   ├── failure-classifier.md # Classify failures (FLAKE/BUG/ENV/TEST)
│   │   └── pattern-learner.md    # LEARN stage - extract patterns, Quoth capture
│   ├── context/                 # Templates & learned patterns
│   │   ├── run-log.template.md  # Template for run logs
│   │   ├── knowledge.template.md # Template for project knowledge
│   │   ├── config.template.ts
│   │   ├── project.template.json
│   │   ├── patterns.template.json
│   │   ├── selectors.template.json
│   │   ├── patterns-learned.json
│   │   └── anti-patterns-learned.json
│   ├── lib/
│   │   └── config.ts
│   └── docs/
│       ├── references/
│       └── playwright-rules/
├── web/
└── CLAUDE.md
```

### Project .triqual Directory

Created by `/init`, required for the documented learning loop:

```
your-project/
├── .triqual/
│   ├── runs/                    # Run logs (one per feature)
│   │   ├── login.md
│   │   ├── dashboard.md
│   │   └── checkout.md
│   └── knowledge.md             # Accumulated project-specific patterns
├── triqual.config.ts            # Main configuration
└── ...
```

### Draft Folder Pattern (ENFORCED BY HOOKS)

Tests are developed in `.draft/` folder ONLY. Promotion requires explicit user approval.

```
.draft/
├── tests/
│   └── login.spec.ts            # Work in progress (test-generator creates here)
└── pages/
    └── LoginPage.ts             # New Page Objects (if created)

tests/
└── login.spec.ts                # ONLY after user explicitly approves promotion
```

- **test-generator** → Creates files in `.draft/` (hook BLOCKS writing to `tests/` directly)
- **test-healer** → Works on `.draft/` files, **STOPS on SUCCESS** (does NOT auto-promote)
- **Promotion** → Requires explicit user approval ("promote" command)
- **Hook enforcement** → `pre-spec-write.sh` blocks new `.spec.ts` outside `.draft/`

### Reuse Existing Code (MANDATORY)

Before creating new Page Objects, helpers, or fixtures:
1. Check `.triqual/context/{feature}/existing-tests.md` for available resources
2. Read all existing Page Objects, helpers, and fixtures referenced in RESEARCH stage
3. **REUSE what exists** — only create new when nothing covers the need
4. If creating something new, document WHY existing code doesn't work

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

### What Persists

| Location | Content | Survives |
|----------|---------|----------|
| `.triqual/runs/*.md` | Run logs (per feature) | Sessions, compaction |
| `.triqual/knowledge.md` | Project patterns | Sessions, compaction |
| `~/.cache/triqual/` | Session state | Current session only |

### Workflow with Documentation

1. **SessionStart** → Initialize session, detect active run logs, suggest reading them
2. **ANALYZE** → Review requirements, document test cases in run log
3. **RESEARCH** → Search Quoth/Exolar, document findings in run log
4. **PLAN** → Document test strategy, tools to use, artifacts to create
5. **Writing tests** → Hook checks run log has all stages, blocks if missing
6. **Running tests** → Hook sets flag requiring log update
7. **Failures** → Document in run log, classify, fix with hypothesis
8. **2+ same failures** → Hook requires external research (Quoth/Exolar)
9. **12+ attempts** → Hook requires deep analysis phase
10. **25+ attempts** → Hook requires .fixme() or justification
11. **Success** → Document learnings, update knowledge.md
12. **SessionStop** → Check for missing accumulated learnings

## Session State

Hooks maintain session state in `~/.cache/triqual/`:
- Tracks which hints have been delivered (once per session)
- Counts tool usage for summary
- Tracks test runs (passed/failed/healed)
- Tracks `awaiting_log_update` flag
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
| Quoth search fails | Verify OAuth at quoth.triqual.dev |
| Exolar query fails | Verify OAuth at exolar.triqual.dev |
| Hooks not triggering | Check `hooks.json` syntax, verify scripts are executable |
| Session state stale | Delete `~/.cache/triqual/` directory |
| Action blocked | Read the error message, create/update run log as instructed |
| Run logs not found | Run `/init` to create `.triqual/` directory |
| Need help | Run `/help` for guidance |

## First Time Setup

1. **Install plugin** - `claude --plugin-dir /path/to/triqual`
2. **Initialize Triqual** - Run `/init` to create `.triqual/` directory and generate config
3. **Authenticate MCPs** - Follow OAuth prompts for Quoth and Exolar
4. **Start using** - `/test login` or `/test --ticket ENG-123`

The `/init` skill:
- Creates `.triqual/runs/` directory for run logs
- Creates `.triqual/knowledge.md` for project patterns
- Creates `triqual.config.ts` with detected settings
- Optionally creates `Docs/context/` files

## Debugging Hooks

Set `TRIQUAL_DEBUG=true` environment variable to enable debug logging:

```bash
export TRIQUAL_DEBUG=true
```

Debug messages will appear in stderr.

## Architecture Overview

### Core Principles

1. **Documentation-First Development** - No test code is written until requirements are documented
2. **Blocking Enforcement** - Hooks use exit code 2 to BLOCK actions and message Claude
3. **Draft-First Pattern** - Tests live in `.draft/` until passing, preventing broken commits
4. **Persistent Learning** - Knowledge survives sessions via file-based storage
5. **Autonomous Healing** - Up to 25 fix attempts with escalating analysis phases

### Component Interactions

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           TRIQUAL ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   USER INPUT                                                             │
│   ├── /test login                                                        │
│   ├── /test --ticket ENG-123                                             │
│   └── /test --describe "..."                                             │
│         │                                                                │
│         ▼                                                                │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                        SKILL LAYER                               │   │
│   │  /init  │  /test  │  /check  │  /rules  │  /help                │   │
│   └────────────────────────┬────────────────────────────────────────┘   │
│                            │                                             │
│         ┌──────────────────┼──────────────────┐                         │
│         ▼                  ▼                  ▼                          │
│   ┌───────────┐     ┌───────────┐     ┌───────────┐                     │
│   │   HOOKS   │     │  AGENTS   │     │    MCP    │                     │
│   │           │     │           │     │  SERVERS  │                     │
│   │ session   │     │ planner   │     │           │                     │
│   │ pre-write │◄────│ generator │────►│ quoth     │                     │
│   │ post-run  │     │ healer    │     │ exolar    │                     │
│   │ subagent  │     │ classifier│     │ playwright│                     │
│   │ compact   │     │ learner   │     │           │                     │
│   └─────┬─────┘     └─────┬─────┘     └─────┬─────┘                     │
│         │                 │                 │                            │
│         └────────────┬────┴─────────────────┘                           │
│                      ▼                                                   │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                      FILE SYSTEM LAYER                           │   │
│   │                                                                  │   │
│   │  .triqual/                    .draft/                            │   │
│   │  ├── runs/                    ├── tests/                         │   │
│   │  │   └── {feature}.md         │   └── {feature}.spec.ts          │   │
│   │  └── knowledge.md             └── pages/                         │   │
│   │                                   └── {Page}.ts                  │   │
│   │                                                                  │   │
│   │  ~/.cache/triqual/            tests/                             │   │
│   │  └── session-state.json       └── {feature}.spec.ts (promoted)   │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hook Communication Protocol

Hooks communicate with Claude using a stdin/stdout/stderr protocol:

```
┌──────────┐    JSON stdin    ┌──────────┐
│  Claude  │─────────────────►│   Hook   │
│   Code   │                  │  Script  │
│          │◄─────────────────│          │
└──────────┘   exit code +    └──────────┘
               stderr message
```

| Input | Description |
|-------|-------------|
| `stdin` | JSON with event details (tool name, parameters, etc.) |
| Environment | `TRIQUAL_DEBUG`, session variables |

| Output | Description |
|--------|-------------|
| Exit 0 | Allow action to proceed |
| Exit 1 | Block action silently |
| Exit 2 | Block action + send stderr to Claude |
| `stderr` | Message displayed to Claude (with exit 2) |

### Agent Orchestration

The `/test` skill orchestrates agents in sequence:

```
/test login
    │
    ├─► test-planner
    │       │
    │       ├── Search Quoth patterns
    │       ├── Query Exolar similar tests
    │       ├── Explore app with Playwright MCP
    │       └── Create .triqual/runs/login.md
    │
    ├─► test-generator
    │       │
    │       ├── Read run log PLAN stage
    │       ├── Apply knowledge.md patterns
    │       └── Write .draft/tests/login.spec.ts
    │
    └─► test-healer (AUTONOMOUS LOOP)
            │
            ├── Run: npx playwright test
            │       │
            │       ├─ PASS ──► STOP (await user approval to promote)
            │       │           └─► pattern-learner
            │       │
            │       └─ FAIL ──► failure-classifier
            │                   └─► Apply fix
            │                   └─► Loop (max 25)
            │
            ├── Attempt 12: Deep analysis phase
            └── Attempt 25: Mark .fixme() or justify
```

## API Reference

### Skills (Slash Commands)

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/init` | none | Initialize `.triqual/` directory and config |
| `/test` | `{feature}` | Full autonomous test generation |
| `/test` | `--explore {feature}` | Interactive browser exploration only |
| `/test` | `--ticket {id}` | Generate from Linear ticket |
| `/test` | `--describe "{text}"` | Generate from description |
| `/check` | `[--severity {level}]` | Lint tests for violations |
| `/rules` | `[{category}]` | View Playwright best practices |
| `/help` | `[{topic}]` | Get help and troubleshooting |

### MCP Tools Available

**Triqual Context (v1.4.0):**
```typescript
// Load context - automatically optimizes depth based on feature complexity
triqual_load_context({
  feature: string,                    // Required - feature name
  ticket?: string,                    // Optional - Linear ticket ID
  description?: string,               // Optional - test description
  force?: boolean                     // Optional - regenerate even if cached
})

// Extend existing context (rarely needed - auto-detection handles most cases)
triqual_extend_context({
  feature: string,                    // Required
  add: ("anti-patterns" | "failures" | "requirements")[],
  ticket?: string                     // Required if adding requirements
})
```

**Quoth (Pattern Documentation):**
```typescript
quoth_search_index({ query: string })     // Search patterns
quoth_read_doc({ docId: string })         // Read full doc
quoth_guidelines({ mode: string })        // Get guidelines
```

**Exolar (Test Analytics):**
```typescript
query_exolar_data({
  dataset: "test_search" | "test_history" | "failure_patterns",
  filters: { search?: string, test_signature?: string, error_type?: string }
})
```

**Playwright MCP (Browser):**
```typescript
browser_navigate({ url: string })
browser_snapshot()
browser_click({ element: string, ref: string })
browser_type({ element: string, ref: string, text: string })
```

### Configuration Schema

```typescript
// triqual.config.ts
import { defineConfig } from 'triqual';

export default defineConfig({
  // Required
  project_id: string,           // Unique project identifier
  testDir: string,              // Test directory path
  baseUrl: string,              // Application base URL

  // Authentication (optional)
  auth: {
    strategy: 'storageState' | 'uiLogin' | 'setupProject' | 'none',
    storageState?: { path: string },
    credentials?: { username: string, password: string },
  },

  // Patterns (optional)
  patterns: {
    selectors: 'data-testid' | 'role' | 'text' | 'css',
    waitStrategy: 'networkidle' | 'domcontentloaded' | 'load',
  },

  // MCP Configuration (optional)
  mcp: {
    quoth: { enabled: boolean },
    exolar: { enabled: boolean, projectId?: string },
  },
});
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **1.4.0** | 2026-02-02 | **Intelligent context loading: auto-detects optimal depth based on feature complexity, ~70% token savings, chunk-first Quoth searching** |
| **1.3.0** | 2026-02-01 | **Enforced .draft/ folder: hook blocks writing tests/ directly, promotion requires user approval, mandatory reuse of existing code** |
| **1.2.0** | 2026-01-31 | **MCP context orchestration: replaced quoth-context agent with triqual_load_context MCP tool + headless subprocess** |
| **1.1.0** | 2026-01-29 | **Quoth v2 integration: context injection, enhanced hooks** |
| **1.0.5** | 2026-01-27 | **Mandatory Quoth pattern search enforcement** |
| **1.0.4** | 2026-01-27 | All agents on Opus 4.5, comprehensive documentation |
| **1.0.3** | 2026-01-26 | macOS stdin compatibility fix for hooks |
| **1.0.2** | 2026-01-25 | SubagentStart/Stop hooks, 25 attempt limit |
| **1.0.1** | 2026-01-24 | Initial documented learning loop |
| **1.0.0** | 2026-01-23 | Initial release |

## Contributing

### Adding New Rules

1. Create rule file in `docs/playwright-rules/rules/{category}-{name}.md`
2. Follow template in `_template.md`
3. Add to `_sections.md` index
4. Run `/check` to verify integration

### Adding New Agents

1. Create agent in `.agents/{name}.md`
2. Define frontmatter with `model: opus`, `color`, `tools`
3. Add trigger conditions in `description`
4. Document in README.md agent reference

### Adding New Hooks

1. Create script in `hooks/{event}-{name}.sh`
2. Add entry to `hooks/hooks.json`
3. Use `lib/common.sh` helpers
4. Test with `TRIQUAL_DEBUG=true`

## License

MIT - See LICENSE file
