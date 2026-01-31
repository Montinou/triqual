# MCP-Based Context Orchestration Design

> **Date:** 2026-01-31
> **Status:** Draft
> **Replaces:** Hook-based passive enforcement + quoth-context agent

## Problem

Triqual's hooks use exit code 2 messages to tell Claude "invoke quoth-context agent first." Claude treats these as suggestions, not commands. Result: Claude ignores the instruction or enters a block-retry-block loop. The quoth-context agent rarely gets invoked reliably.

**Root cause:** Hooks can block actions and send messages, but cannot dispatch agents. Asking Claude to use the `Task` tool (agent dispatch) via a stderr message is unreliable. Tool calls are far more deterministic.

## Solution

Replace the quoth-context **agent** with an MCP **tool** (`triqual_load_context`) backed by a local stdio server. The server spawns a headless `claude -p` subprocess (Sonnet) that does the actual research and writes structured context files. Main Claude calls a tool (reliable) instead of dispatching an agent (unreliable).

## Architecture

```
Main Claude calls: triqual_load_context({ feature: "login" })
       │
       ▼
┌─────────────────────────────────┐
│  triqual-context MCP server     │
│  (Node.js stdio, local)         │
│                                 │
│  1. Check if context exists     │
│  2. Build prompt from template  │
│  3. Spawn claude -p (Sonnet)    │
│  4. Wait for completion (180s)  │
│  5. Validate output files       │
│  6. Return file paths           │
└────────────┬────────────────────┘
             │ spawns
             ▼
┌─────────────────────────────────┐
│  Headless Claude subprocess     │
│  (Sonnet, --dangerously-skip-   │
│   permissions)                  │
│                                 │
│  - Inherits .mcp.json (Quoth,  │
│    Exolar, Linear)              │
│  - Searches Quoth patterns      │
│  - Queries Exolar failures      │
│  - Scans codebase               │
│  - Reads knowledge.md           │
│  - Fetches Linear ticket (opt)  │
│  - Writes .triqual/context/     │
└─────────────────────────────────┘
```

## Output Structure

```
.triqual/context/{feature}/
├── patterns.md          # Quoth: proven patterns (selectors, waits, flows)
├── anti-patterns.md     # Quoth: known failures and what to avoid
├── codebase.md          # Relevant source files, routes, selectors, components
├── existing-tests.md    # Similar tests in project, reusable page objects
├── failures.md          # Exolar: past failure history for this feature
├── requirements.md      # Linear ticket AC, description (if ticket provided)
└── summary.md           # Index: what's in each file, key decisions
```

### File Format Rules

- No prose paragraphs — structured sections only
- Code snippets over descriptions
- Source references (quoth doc IDs, file paths with line numbers)
- One fact per line
- `##` headers for sections, `-` bullets for items

### Example: patterns.md

```markdown
# Patterns: login

## Auth Flow
- strategy: storageState
- selector: [data-testid="login-submit"]
- wait: networkidle after redirect

## Proven Sequences
```typescript
await page.goto('/login')
await page.getByTestId('email').fill(creds.email)
await page.getByTestId('login-submit').click()
await page.waitForURL('/dashboard', { waitUntil: 'networkidle' })
```

## Source: quoth://doc/abc123
```

## MCP Tool API

### triqual_load_context

```typescript
triqual_load_context({
  feature: string,           // Required: feature name ("login", "dashboard")
  ticket?: string,           // Optional: Linear ticket ID ("ENG-123")
  description?: string,      // Optional: user description of what to test
  force?: boolean            // Optional: regenerate even if context exists (default: false)
})
```

**Returns:**
```json
{
  "status": "ok",
  "path": ".triqual/context/login/",
  "files": ["patterns.md", "anti-patterns.md", "codebase.md", "existing-tests.md", "failures.md", "summary.md"]
}
```

**Or on error:**
```json
{
  "status": "error",
  "message": "Subprocess timed out after 180s"
}
```

### Server Behavior

1. Receive call with feature + optional inputs
2. Resolve project root (walk up from cwd looking for `triqual.config.ts`)
3. If `.triqual/context/{feature}/` exists with required files AND `force` is false → return immediately (cached)
4. Read `triqual.config.ts` for: testDir, baseUrl, auth strategy
5. Read prompt template from `mcp/prompts/context-builder.md`
6. Interpolate template with: feature, ticket, description, testDir, baseUrl, projectRoot
7. Spawn: `claude -p "{prompt}" --dangerously-skip-permissions -m sonnet`
   - cwd: project root (inherits `.mcp.json` → Quoth, Exolar, Linear access)
   - timeout: 180s
8. Wait for completion
9. Validate: `.triqual/context/{feature}/` has at least `patterns.md` + `codebase.md`
10. Return file list and path

## New Files

| File | Purpose |
|------|---------|
| `triqual-plugin/mcp/triqual-context-server.js` | Local stdio MCP server, single tool |
| `triqual-plugin/mcp/prompts/context-builder.md` | Prompt template for headless subprocess |

### .mcp.json Addition

```json
{
  "mcpServers": {
    "quoth": { "...existing..." },
    "exolar-qa": { "...existing..." },
    "triqual-context": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/triqual-context-server.js"],
      "type": "stdio"
    }
  }
}
```

## Subprocess Prompt Template

The prompt template (`mcp/prompts/context-builder.md`) instructs the headless Claude to:

### 1. Search Quoth
- `quoth_search_index({ query: "{feature} playwright patterns" })`
- `quoth_search_index({ query: "{feature} test anti-patterns failures" })`
- `quoth_search_index({ query: "playwright selectors waits {feature}" })`
- Read top 3-5 results with `quoth_read_doc`

### 2. Query Exolar
- `query_exolar_data({ dataset: "test_search", filters: { search: "{feature}" }})`
- `query_exolar_data({ dataset: "failure_patterns", filters: { search: "{feature}" }})`

### 3. Fetch Linear Ticket (if provided)
- `mcp__linear__get_issue({ id: "{ticket}" })`
- Extract: title, description, acceptance criteria, labels

### 4. Scan Codebase
- Find source files related to {feature} (components, routes, API calls)
- Find existing tests matching {feature}
- Find page objects that could be reused
- Identify selectors (data-testid, roles, text)

### 5. Read Project Knowledge
- Read `.triqual/knowledge.md` if it exists

### 6. Write Output Files
- Write all files to `{projectRoot}/.triqual/context/{feature}/`
- Follow AI-optimized format spec (structured, no prose)
- Write `summary.md` last

### Subprocess Constraints
- Read-only on codebase (only writes to `.triqual/context/`)
- No test execution
- No interactive prompts (`--dangerously-skip-permissions`)
- Max runtime 180s (enforced by parent)

## Hook Migration

### Removed

| Component | Location | Reason |
|-----------|----------|--------|
| `quoth_context_invoked()` | `lib/common.sh` | Replaced by `context_files_exist()` |
| `mark_quoth_context_invoked()` | `lib/common.sh` | No session flag needed |
| `quoth_search_documented()` | `lib/common.sh` | Replaced by file existence check |
| quoth-context case | `subagent-stop.sh` | No agent to complete |
| quoth-context case | `subagent-start.sh` | No agent to inject into |
| `quoth_context` session JSON field | `session-start.sh` | No session state for this |
| `pre-task-gate.sh` quoth session check | `pre-task-gate.sh` | Replaced by file check |

### Added

| Component | Location | Purpose |
|-----------|----------|---------|
| `context_files_exist()` | `lib/common.sh` | Check `.triqual/context/{feature}/` has required files |
| `extract_feature_from_prompt()` | `lib/common.sh` | Extract feature name from a Task tool prompt/description |

### Modified

#### `lib/common.sh`

```bash
# NEW: Replace quoth_context_invoked + quoth_search_documented
context_files_exist() {
  local feature="$1"
  local context_dir="${PROJECT_ROOT}/.triqual/context/${feature}"

  [[ -f "${context_dir}/patterns.md" ]] && [[ -f "${context_dir}/codebase.md" ]]
}
```

#### `pre-spec-write.sh` — Gate 4.5

**Before:**
```bash
if ! quoth_context_invoked && ! quoth_search_documented "$feature"; then
  echo "BLOCKED: Invoke quoth-context agent..." >&2
  exit 2
fi
```

**After:**
```bash
if ! context_files_exist "$feature"; then
  cat >&2 <<EOF
BLOCKED: No context files for "${feature}".

Call the triqual_load_context tool:
  triqual_load_context({ feature: "${feature}" })

This generates .triqual/context/${feature}/ with patterns, anti-patterns,
codebase analysis, and failure history. Then retry this write.
EOF
  exit 2
fi
```

#### `pre-task-gate.sh` — test-planner dispatch gate

**Before:**
```bash
if [[ "$agent_type" == *"test-planner"* ]]; then
  if ! quoth_context_invoked; then
    echo "BLOCKED: Invoke quoth-context agent first" >&2
    exit 2
  fi
fi
```

**After:**
```bash
if [[ "$agent_type" == *"test-planner"* ]]; then
  feature=$(extract_feature_from_prompt "$prompt")
  if ! context_files_exist "$feature"; then
    cat >&2 <<EOF
BLOCKED: Cannot dispatch test-planner without context files.

Call triqual_load_context({ feature: "${feature}" }) first.
This builds .triqual/context/${feature}/ with Quoth patterns,
Exolar failures, and codebase analysis.
EOF
    exit 2
  fi
fi
```

#### `subagent-start.sh` — test-planner context injection

**Before:** Checks quoth-context flag, provides fallback if not invoked.

**After:** Always injects context file paths:
```text
Read these context files before planning:
- .triqual/context/{feature}/patterns.md
- .triqual/context/{feature}/anti-patterns.md
- .triqual/context/{feature}/codebase.md
- .triqual/context/{feature}/existing-tests.md
- .triqual/context/{feature}/failures.md
- .triqual/context/{feature}/requirements.md (if exists)
- .triqual/context/{feature}/summary.md
- .triqual/knowledge.md
```

#### `subagent-stop.sh`

Remove the entire quoth-context case block. All other agent cases remain unchanged.

#### `session-start.sh`

Remove `quoth_context` initialization from session JSON. Add detection of existing context directories:
```bash
# Detect existing context for active features
if [[ -d ".triqual/context/" ]]; then
  echo "Existing context found for: $(ls .triqual/context/)"
fi
```

#### `skills/test/SKILL.md`

Phase 0.6 changes from:
```
Invoke triqual-plugin:quoth-context agent NOW
```
To:
```
Call triqual_load_context({ feature: "{feature}" }) tool.
Wait for completion. Context files will be at .triqual/context/{feature}/.
```

#### `skills/init/SKILL.md`

Add `.triqual/context/` to directory creation alongside `runs/`.

## quoth-context Agent Mode Migration

| Mode | Current Home | New Home |
|------|-------------|----------|
| **Session inject** | quoth-context agent, "session inject" mode | `triqual_load_context({ feature: "_project" })` at session start |
| **Pre-agent research** | quoth-context agent, "pre-agent research" mode | `triqual_load_context({ feature: "login" })` — primary use case |
| **Capture** | quoth-context agent, "capture" mode | pattern-learner agent or new `/capture` skill — requires user confirmation for Quoth write-back |

## Updated Agent Loop

```
User: /test login
       │
       ▼
[/test skill]
  Step 1: Call triqual_load_context({ feature: "login" })
       │
       ▼
[MCP Server → Subprocess]
  Searches Quoth, Exolar, codebase, Linear
  Writes .triqual/context/login/*
  Returns: { status: "ok", files: [...] }
       │
       ▼
  Step 2: Dispatch test-planner
       │
       ▼
[pre-task-gate.sh]
  context_files_exist("login") → TRUE ✅
       │
       ▼
[test-planner]
  Reads .triqual/context/login/* (all files)
  Creates .triqual/runs/login.md (ANALYZE/RESEARCH/PLAN)
       │
       ▼
  Step 3: Dispatch test-generator
       │
       ▼
[test-generator]
  Reads run log PLAN stage + context files
  Writes .draft/tests/login.spec.ts
       │
       ▼
  Step 4: Dispatch test-healer (autonomous loop)
       │
       ▼
[test-healer]
  Run → Fix → Run (up to 25 attempts)
  Promotes to tests/ on PASS
       │
       ▼
  Step 5: pattern-learner
  Extracts learnings → knowledge.md
  Optionally pushes to Quoth (capture mode, user confirmation)
```

## File Tree Changes

```
triqual-plugin/
├── .mcp.json                        # MODIFIED: add triqual-context server
├── mcp/                             # NEW: directory
│   ├── triqual-context-server.js    # NEW: local stdio MCP server
│   └── prompts/
│       └── context-builder.md       # NEW: subprocess prompt template
├── agents/
│   ├── test-planner.md              # MODIFIED: reference context files instead of Quoth
│   ├── test-generator.md            # UNCHANGED
│   ├── test-healer.md               # UNCHANGED
│   ├── failure-classifier.md        # UNCHANGED
│   ├── pattern-learner.md           # MODIFIED: absorb capture mode
│   └── quoth-context.md             # DELETED
├── hooks/
│   ├── lib/common.sh               # MODIFIED: replace quoth functions with context_files_exist
│   ├── session-start.sh            # MODIFIED: remove quoth session flag init
│   ├── pre-spec-write.sh           # MODIFIED: gate 4.5 uses file check
│   ├── pre-task-gate.sh            # MODIFIED: uses file check
│   ├── pre-retry-gate.sh           # MODIFIED: updated agent name references
│   ├── post-test-run.sh            # UNCHANGED
│   ├── subagent-start.sh           # MODIFIED: remove quoth-context case, update test-planner injection
│   ├── subagent-stop.sh            # MODIFIED: remove quoth-context case
│   ├── pre-compact.sh              # UNCHANGED
│   └── stop.sh                     # MODIFIED: updated agent name references
├── skills/
│   ├── init/SKILL.md               # MODIFIED: create .triqual/context/ dir
│   ├── test/SKILL.md               # MODIFIED: phase 0.6 calls tool
│   ├── check/SKILL.md              # UNCHANGED
│   ├── rules/SKILL.md              # UNCHANGED
│   └── help/SKILL.md               # MODIFIED: document new tool
└── CLAUDE.md                        # MODIFIED: update architecture docs
```

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Subprocess fails (Quoth auth expired) | MCP tool returns error with actionable message; hook still blocks but with clear "run triqual_load_context" instruction |
| Subprocess times out (180s) | Parent process kills subprocess, returns timeout error; context files may be partial — validation catches this |
| Stale context files (feature changed) | `force: true` parameter regenerates; could add timestamp check in hook |
| Subprocess token cost | Sonnet model keeps cost low; caching (skip if exists) prevents repeated runs |
| Large codebase slows subprocess | Prompt template limits scope to feature-relevant files; subprocess has 180s cap |
| OAuth tokens not cached | First-run requires main session to authenticate Quoth/Exolar; subprocess inherits cached tokens |

## Success Criteria

1. `triqual_load_context` tool appears in Claude's tool list after plugin load
2. Calling the tool produces `.triqual/context/{feature}/` with valid files
3. Hooks block test writes when context files missing, with clear tool-call instruction
4. Hooks pass when context files exist
5. Claude calls the tool reliably when instructed by hooks (tool call > agent dispatch)
6. Full `/test` flow completes without manual quoth-context intervention
7. No references to quoth-context agent remain in hooks, skills, or CLAUDE.md
