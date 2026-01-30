# Triqual

> **Version 1.1.0** | Opus 4.5 + Sonnet Agents | Quoth v2 Context Agent | macOS & Linux

**Autonomous Test Automation for Claude Code**

Triqual is a powerful Claude Code plugin that brings **autonomous, self-healing test generation** with enforced documentation and learning loops. It combines three MCP integrations:

- **Playwright MCP** - Browser automation and app exploration
- **Quoth** - Semantic pattern documentation search
- **Exolar** - Test analytics and failure clustering

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blue)](https://claude.ai/claude-code)

## Why Triqual?

Traditional test automation is brittle. Triqual solves this with:

1. **Enforced Documentation** - Hooks BLOCK actions until you document your approach
2. **Autonomous Healing** - Up to 25 fix attempts with deep analysis at attempt 12
3. **Persistent Learning** - Patterns survive session compaction in run logs
4. **Draft-First Development** - Tests live in `.draft/` until passing, then get promoted

## Installation

### From Marketplace

```bash
# Add the Triqual marketplace
/plugin marketplace add Montinou/triqual

# Install the plugin (scoped to current project)
/plugin install triqual-plugin@triqual
```

### Local Development

```bash
claude --plugin-dir /path/to/triqual/triqual-plugin
```

## What Gets Installed

| Component | Count | Description |
|-----------|-------|-------------|
| MCP Servers | 2 | `quoth` (patterns), `exolar-qa` (analytics) |
| Hooks | 7 | Blocking enforcement for documentation |
| Skills | 5 | `/init`, `/test`, `/check`, `/rules`, `/help` |
| Agents | 6 | 5 Opus 4.5 + 1 Sonnet (quoth-context) |
| Rules | 31 | Playwright best practices (8 categories) |

## Quick Start

### 1. Initialize Your Project

```bash
/init
```

This creates:
- `.triqual/runs/` - Directory for run logs
- `.triqual/knowledge.md` - Project-specific patterns
- `triqual.config.ts` - Configuration file

### 2. Generate Tests

```bash
# Full autonomous loop
/test login

# From Linear ticket
/test --ticket ENG-123

# From description
/test --describe "User can filter search results by date"

# Interactive exploration only
/test --explore checkout
```

### 3. Check Test Quality

```bash
/check
```

### 4. View Best Practices

```bash
/rules
```

## The Documented Learning Loop

Triqual enforces a **documented learning loop** that prevents erratic AI behavior:

```
ANALYZE → RESEARCH → PLAN → WRITE → RUN → FIX → LEARN
```

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TRIQUAL WORKFLOW                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  User: "/test login"                                                 │
│         │                                                            │
│         ▼                                                            │
│  ┌─────────────────┐                                                 │
│  │  TEST-PLANNER   │  ANALYZE: Review requirements                   │
│  │    (Opus 4.5)   │  RESEARCH: Search Quoth + Exolar                │
│  │                 │  PLAN: Document test strategy                   │
│  └────────┬────────┘                                                 │
│           │ Creates: .triqual/runs/login.md                          │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │ TEST-GENERATOR  │  WRITE: Generate code in .draft/                │
│  │    (Opus 4.5)   │  Creates: .draft/tests/login.spec.ts            │
│  └────────┬────────┘                                                 │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │  TEST-HEALER    │  AUTONOMOUS LOOP (up to 25 attempts)            │
│  │    (Opus 4.5)   │                                                 │
│  │                 │  ┌──────────────────────────────┐               │
│  │                 │  │  RUN → FAIL → FIX → RUN ...  │               │
│  │                 │  │                              │               │
│  │                 │  │  Attempt 12: DEEP ANALYSIS   │               │
│  │                 │  │  Attempt 25: Mark .fixme()   │               │
│  │                 │  └──────────────────────────────┘               │
│  └────────┬────────┘                                                 │
│           │ On SUCCESS: mv .draft/tests/* → tests/                   │
│           ▼                                                          │
│  ┌─────────────────┐                                                 │
│  │ PATTERN-LEARNER │  LEARN: Extract patterns                        │
│  │    (Opus 4.5)   │  Update: .triqual/knowledge.md                  │
│  └─────────────────┘                                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Gate-Based Enforcement

Hooks **BLOCK** actions until documentation is complete:

| Gate | Trigger | Block Condition | Resolution |
|------|---------|-----------------|------------|
| **Pre-Write** | Write `.spec.ts` | No run log or missing stages | Create run log with ANALYZE/RESEARCH/PLAN/WRITE |
| **Quoth Context** | Write `.spec.ts` | **No Quoth context loaded** | **Invoke triqual-plugin:quoth-context agent or search Quoth manually** |
| **Post-Run** | After `playwright test` | Results not documented | Add RUN stage to log |
| **Retry Limit** | 2+ same-category fails | No external research | Search Quoth/Exolar, document findings |
| **Deep Analysis** | 12+ attempts | No deep analysis | Expand research, explore app, try new approaches |
| **Max Attempts** | 25+ attempts | No resolution | Mark as `.fixme()` with justification |

### Mandatory Quoth Context Loading

**BEFORE writing ANY test code**, invoke the **triqual-plugin:quoth-context** agent:

> Use triqual-plugin:quoth-context agent in **pre-agent research** mode to load patterns for '{feature}'.

The triqual-plugin:quoth-context agent searches Quoth, reads knowledge.md, and returns structured patterns. This is **ENFORCED** — test writing will be **BLOCKED** until Quoth context is loaded.

If quoth-context is unavailable, fall back to manual search:
```typescript
mcp__quoth__quoth_search_index({
  query: "{feature} playwright patterns"
})
```

**Why:** Quoth contains proven patterns from past successes and failures. The triqual-plugin:quoth-context agent searches comprehensively without consuming main context.

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

## The Six Agents

Five agents run on **Opus 4.5** for maximum intelligence, plus one **Sonnet** agent for fast Quoth interactions:

### 1. TEST-PLANNER

**Role:** Creates the test plan from requirements

- Searches Quoth for existing patterns
- Queries Exolar for similar tests
- Explores app with Playwright MCP
- Fetches Linear ticket details (if provided)
- Creates comprehensive run log with ANALYZE/RESEARCH/PLAN stages

### 2. TEST-GENERATOR

**Role:** Generates test code from the plan

- Reads PLAN stage from run log
- Applies patterns from `knowledge.md`
- Generates tests in `.draft/` folder
- Creates Page Objects if needed
- Documents WRITE stage with hypothesis

### 3. TEST-HEALER (Autonomous Loop)

**Role:** Runs tests and fixes failures autonomously

- Executes up to **25 fix attempts**
- Deep analysis phase at **attempt 12**
- Works on files in `.draft/` folder
- Promotes to `tests/` on SUCCESS
- Documents every RUN and FIX stage

### 4. FAILURE-CLASSIFIER

**Role:** Categorizes failures for appropriate action

- Classifies as: `FLAKE` | `BUG` | `ENV_ISSUE` | `TEST_ISSUE`
- Queries Exolar for historical patterns
- Recommends appropriate next action
- Prevents wasting time on non-test issues

### 5. PATTERN-LEARNER

**Role:** Extracts and persists learnings

- Reviews all run logs for patterns
- Updates `.triqual/knowledge.md`
- Invokes quoth-context in capture mode to propose patterns to Quoth
- Ensures learnings survive sessions

### 6. QUOTH-CONTEXT (Sonnet)

**Role:** Handles all Quoth MCP interactions outside the main context window

- **Session inject:** Loads project patterns at session start (~500 token summary)
- **Pre-agent research:** Searches Quoth for feature-specific patterns before test-planner
- **Capture:** Proposes learned patterns to Quoth after pattern-learner (requires user confirmation)
- Exempt from all Triqual hooks (prevents infinite loops)

## Directory Structure

### Plugin Structure

```
triqual-plugin/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── .mcp.json                  # MCP server definitions
├── skills/                    # Slash commands
│   ├── init/SKILL.md
│   ├── test/SKILL.md
│   ├── check/SKILL.md
│   ├── rules/SKILL.md
│   └── help/SKILL.md
├── hooks/                     # Blocking enforcement
│   ├── hooks.json
│   ├── lib/common.sh          # 800+ lines of helpers
│   ├── session-start.sh
│   ├── pre-spec-write.sh      # BLOCKS without documentation
│   ├── pre-retry-gate.sh      # BLOCKS without research
│   ├── post-test-run.sh
│   ├── subagent-start.sh      # Injects context to agents
│   ├── subagent-stop.sh       # Guides next steps
│   ├── pre-compact.sh
│   └── stop.sh
├── .agents/                   # Opus 4.5 + Sonnet agents
│   ├── test-planner.md
│   ├── test-generator.md
│   ├── test-healer.md
│   ├── failure-classifier.md
│   ├── pattern-learner.md
│   └── quoth-context.md       # Sonnet - Quoth MCP interactions
├── context/                   # Templates
│   ├── run-log.template.md
│   ├── knowledge.template.md
│   └── config.template.ts
└── docs/
    ├── playwright-rules/      # 31 best practice rules
    └── references/
```

### Project Structure (After `/init`)

```
your-project/
├── .triqual/
│   ├── runs/                  # Run logs (one per feature)
│   │   ├── login.md
│   │   ├── checkout.md
│   │   └── dashboard.md
│   └── knowledge.md           # Accumulated patterns
├── .draft/                    # Work in progress
│   ├── tests/
│   │   └── feature.spec.ts    # Until passing
│   └── pages/
│       └── NewPage.ts         # New Page Objects
├── tests/                     # Production tests
│   └── feature.spec.ts        # After promotion
└── triqual.config.ts          # Configuration
```

## Run Log Format

Each feature gets a detailed run log at `.triqual/runs/{feature}.md`:

```markdown
# Test Run Log: login

## Session: 2026-01-27T10:30:00Z

### Stage: ANALYZE
**Feature:** login
**Objective:** Verify user authentication flow

**Acceptance Criteria:**
1. User can log in with email/password
2. Error shown for invalid credentials
3. Redirects to dashboard on success

**User Flows:**
1. Happy path - successful login
2. Error case - invalid password
3. Edge case - empty fields

---

### Stage: RESEARCH

**Quoth Search:** "login playwright patterns"
**Patterns Found:**
- `auth-storagestate`: Save auth state for reuse
- `visibility-filter`: Use :visible for buttons

**Exolar Query:** Similar tests in project
**Found:** 3 auth-related tests, all use storageState

**Available Resources:**
| Resource | Path | Purpose |
|----------|------|---------|
| LoginPage | pages/LoginPage.ts | Login actions |
| testUsers | fixtures/users.ts | Test credentials |

---

### Stage: PLAN
**Test Strategy:** Use storageState, test all 3 flows

| Test Case | Priority | Dependencies |
|-----------|----------|--------------|
| should login with valid credentials | High | LoginPage |
| should show error for invalid password | High | LoginPage |
| should require email field | Medium | LoginPage |

---

### Stage: WRITE
**Hypothesis:** Using LoginPage with storageState for speed.
Testing error states with invalid credentials fixture.

**Files:**
- .draft/tests/login.spec.ts

---

### Stage: RUN (Attempt 1)
**Command:** `npx playwright test .draft/tests/login.spec.ts`
**Result:** FAILED

**Error Type:** LOCATOR
**Error:** locator resolved to 3 elements at line 23
**Analysis:** Multiple submit buttons on page

---

### Stage: FIX (Attempt 1)
**Hypothesis:** Add :visible filter per Quoth pattern
**Pattern:** visibility-filter
**Change:** Line 23: `button` → `button:visible`

---

### Stage: RUN (Attempt 2)
**Result:** PASSED

---

### Stage: SUCCESS
**Attempts Required:** 2
**Files Promoted:**
- .draft/tests/login.spec.ts → tests/login.spec.ts

---

### Stage: LEARN
**Pattern Discovered:** This project has multiple hidden buttons
**Added to knowledge.md:** Yes

## Accumulated Learnings
1. Login page has duplicate hidden buttons - use :visible
2. storageState works well for this auth flow
```

## MCP Servers

### Auto-Installed Servers

| Server | URL | Purpose |
|--------|-----|---------|
| `quoth` | `https://quoth.ai-innovation.site/api/mcp` | Pattern documentation |
| `exolar-qa` | `https://exolar.ai-innovation.site/api/mcp/mcp` | Test analytics |

### Quoth Tools

```typescript
// Search for patterns
quoth_search_index({ query: "login playwright patterns" })

// Read full documentation
quoth_read_doc({ docId: "auth-patterns" })

// Get coding guidelines
quoth_guidelines({ mode: "playwright" })
```

### Exolar Tools

```typescript
// Search existing tests
query_exolar_data({
  dataset: "test_search",
  filters: { search: "login" }
})

// Get failure history
query_exolar_data({
  dataset: "test_history",
  filters: { test_signature: "login" }
})

// Analyze failure patterns
query_exolar_data({
  dataset: "failure_patterns",
  filters: { error_type: "LOCATOR" }
})
```

## Configuration

### triqual.config.ts

```typescript
import { defineConfig } from 'triqual';

export default defineConfig({
  project_id: 'my-project',
  testDir: './tests',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  auth: {
    strategy: 'storageState', // 'uiLogin' | 'setupProject' | 'none'
    storageState: { path: '.auth/user.json' },
  },

  // Optional: Custom test patterns
  patterns: {
    selectors: 'data-testid', // 'role' | 'text' | 'css'
    waitStrategy: 'networkidle', // 'domcontentloaded' | 'load'
  },
});
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Hooks not blocking | Check Claude Code version, restart session |
| MCP auth fails | Visit quoth.ai-innovation.site, complete OAuth |
| Run logs not created | Run `/init` first |
| Tests not promoting | Ensure tests PASS before promotion |
| Action blocked | Read error message, document required stages |
| Session state stale | Delete `~/.cache/triqual/` |

### Debug Mode

Enable verbose logging:

```bash
export TRIQUAL_DEBUG=true
```

## Skills Reference

| Command | Description |
|---------|-------------|
| `/init` | Initialize Triqual for project |
| `/test {feature}` | Full autonomous test generation |
| `/test --explore {feature}` | Interactive browser exploration |
| `/test --ticket ENG-123` | Generate from Linear ticket |
| `/test --describe "..."` | Generate from description |
| `/check` | Lint tests for violations |
| `/rules` | View 31 Playwright best practices |
| `/help` | Get help and troubleshooting |

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **1.0.5** | 2026-01-27 | **Mandatory Quoth pattern search enforcement** |
| **1.0.4** | 2026-01-27 | All agents on Opus 4.5, comprehensive documentation update |
| **1.0.3** | 2026-01-26 | macOS stdin compatibility fix for hooks |
| **1.0.2** | 2026-01-25 | SubagentStart/Stop hooks, 25 attempt limit |
| **1.0.1** | 2026-01-24 | Initial documented learning loop |
| **1.0.0** | 2026-01-23 | Initial release |

## Architecture

For detailed architecture documentation, see the [CLAUDE.md](../CLAUDE.md) file which includes:
- Component interaction diagrams
- Hook communication protocol
- Agent orchestration flow
- API reference
- Configuration schema

## License

MIT
