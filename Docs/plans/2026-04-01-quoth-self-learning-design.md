# Design: Quoth Self-Learning Plugin + Triqual Integration

**Date:** 2026-04-01  
**Status:** Approved  
**Scope:** quoth-plugin (standalone) + Triqual hook extensions

---

## Problem

Triqual already consumes Quoth (patterns) and Exolar (analytics) as read-only MCP sources.  
There is no feedback loop: patterns that succeed or fail are never scored back into Quoth.  
Learning is one-directional and per-session only.

---

## Solution

Build `quoth-plugin` — a standalone Claude Code plugin that:
1. Automatically logs all agent interactions as trajectory JSONL (via hooks)
2. Runs a background daemon that processes trajectories using parallel Haiku subagents
3. Maintains a confidence-scored pattern library (SQLite + JSON files)
4. Injects relevant patterns into every agent's context automatically

Triqual adds 2 non-blocking hook extensions to feed test outcomes back into pattern scores.

---

## Architecture

```
User installs quoth-plugin ONCE — everything else is autonomous.

SESSION OPENS (session-start hook)
  → daemon health check via PID file (~/.quoth/daemon.pid)
  → if dead: spawn daemon as detached nohup process
  → inject top-5 relevant patterns into Claude context

DURING SESSION (all hooks non-blocking, exit 0 always)
  subagent-start: read top-N patterns for task → inject into agent context
  subagent-stop:  append {agent, task, outcome, toolsUsed} to trajectory JSONL
  post-tool-use:  append significant tool outcomes to trajectory JSONL

SESSION CLOSES (stop hook)
  → SIGUSR1 to daemon ("new data available, process now")
  → exits immediately, never waits

DAEMON (always-on background process, survives session close)
  → file watcher on ~/.quoth/trajectories/
  → SIGUSR1: flush queue immediately
  → every 1h: apply confidence decay to all patterns
  → every 24h at 3am: deep consolidation (Sonnet subagent, off-peak)
  → self-heals on crash: catches uncaughtException, restarts after 5s
```

---

## Plugin Structure

```
quoth-plugin/
├── .claude-plugin/
│   └── plugin.json                  # Manifest: name, version, mcp servers
├── .mcp.json                        # Registers: quoth cloud + quoth-learning (local)
├── hooks/
│   ├── hooks.json
│   ├── session-start.sh             # Daemon resurrection + pattern injection
│   ├── subagent-start.sh            # Inject relevant patterns into agent context
│   ├── subagent-stop.sh             # Log agent outcome to trajectory JSONL
│   ├── stop.sh                      # SIGUSR1 daemon + Triqual: seed from Exolar
│   └── lib/common.sh                # Shared: daemon check, trajectory append, DB query
├── daemon/
│   ├── daemon.js                    # Main: file watcher + job queue + scheduler
│   ├── pipeline/
│   │   ├── judge.js                 # Haiku subagent: was this step effective?
│   │   ├── distill.js               # Haiku subagent: extract generalizable pattern
│   │   └── consolidate.js           # Haiku subagent: merge or strengthen in DB
│   └── db.js                        # SQLite wrapper (Quoth memory schema)
├── mcp/
│   └── quoth-learning-server.js     # Local stdio MCP: 5 tools (see below)
├── skills/
│   ├── patterns/SKILL.md            # /patterns — browse confidence-scored library
│   └── learn/SKILL.md               # /learn — force immediate consolidation
└── context/
    └── pattern.template.json        # Schema: id, content, confidence, uses, tags
```

---

## Processing Pipeline

All LLM steps use `claude -p --model claude-haiku-4-5-20251001` subagents.  
Auth is inherited from Claude Code. No API keys. No SDK.

```
New trajectory entries (from JSONL watcher)
        │
        ▼
[JUDGE — Haiku subagent, up to 5 parallel]
  Input:  raw trajectory step JSON
  Prompt: "Was this agent action effective? Respond JSON: {effective, reason, category}"
  Output: { effective: bool, reason: string, category: "selector|wait|auth|data|..." }
        │
        ├─ effective: false → write to anti-patterns table, skip distill
        │
        ▼
[DISTILL — Haiku subagent]
  Input:  successful step + 3 surrounding context entries
  Prompt: "Extract a generalizable reusable pattern. Respond JSON: {pattern, tags, applicability}"
  Output: { pattern: string, tags: string[], applicability: "broad|narrow" }
        │
        ▼
[CONSOLIDATE — Haiku subagent]
  Input:  new pattern + top-3 similar existing patterns (cosine similarity from DB)
  Prompt: "Should I merge, strengthen existing, or create new? Respond JSON: {action, targetId, updated}"
  Output: { action: "merge"|"strengthen"|"new", targetId?: string, updated: PatternRecord }
        │
        ▼
  Write to SQLite + update pattern JSON file
  Apply confidence delta
  Check promotion threshold → queue cloud push if eligible
```

**Deep Consolidation (24h, Sonnet subagent)**
- Find clusters with cosine similarity > 0.85
- Merge duplicates, resolve conflicts
- Promote high-confidence patterns to Quoth cloud via `quoth_propose_update`
- Archive patterns: confidence < 0.1 AND uses > 5
- Write weekly report to `.quoth/reports/YYYY-MM-DD.md`

---

## Confidence Mechanics (RuFlo V3 spec)

```
On successful use:  confidence += 0.03  (cap 1.0)
Per hour idle:      confidence -= 0.005 (floor 0.0)
Promotion:          confidence > 0.8 AND uses > 10 → propose to Quoth cloud
Pruning:            confidence < 0.1 AND uses > 5  → archive (never delete)
```

---

## Data Formats

**Trajectory entry (append-only JSONL at ~/.quoth/trajectories/{session}.jsonl):**
```json
{
  "ts": "2026-04-01T10:32:00Z",
  "session": "abc123",
  "project": "attorney-share",
  "event": "agent_stop",
  "agent": "test-healer",
  "task": "fix login selector",
  "outcome": "success",
  "attempts": 2,
  "pattern_used": "visibility-filter",
  "tool_calls": 14
}
```

**Pattern record (SQLite + .quoth/patterns/{id}.json):**
```json
{
  "id": "visibility-filter",
  "content": "Use :visible when multiple matching elements exist on page",
  "confidence": 0.84,
  "uses": 47,
  "successes": 40,
  "failures": 7,
  "decayRate": 0.005,
  "lastUsed": "2026-04-01T10:32:00Z",
  "tags": ["selector", "playwright", "locator"],
  "applicability": "broad",
  "source": "distilled"
}
```

---

## MCP Tools (quoth-learning-server.js — local stdio)

| Tool | Called By | Purpose |
|------|-----------|---------|
| `quoth_log_outcome` | Triqual post-test-run hook | Record pattern result → feeds confidence |
| `quoth_score_pattern` | pattern-learner agent | Manual confidence adjustment |
| `quoth_seed_from_exolar` | Triqual stop hook | Import Exolar clustered_failures as pattern candidates |
| `quoth_top_patterns` | subagent-start hook | Get top-N relevant patterns for current task |
| `quoth_daemon_status` | session-start hook | Check daemon health, last-run timestamp |

All tools: local stdio, no network, instant response.

---

## Triqual Hook Extensions (2 additions only)

```bash
# post-test-run.sh — after playwright test result known
if [ "$TEST_RESULT" = "passed" ] && [ -n "$PATTERN_USED" ]; then
  claude mcp call quoth-learning quoth_log_outcome \
    '{"patternId":"'"$PATTERN_USED"'","result":"success"}' &
fi

# stop.sh — end of Triqual session
claude mcp call quoth-learning quoth_seed_from_exolar \
  '{"dataset":"clustered_failures","projectId":"'"$PROJECT_ID"'"}' &
```

Both calls are fire-and-forget background (`&`). Never block session close.

---

## Daemon Self-Management

```javascript
// Daemon handles its own lifecycle
process.on('SIGUSR1', () => flushQueue())       // triggered by stop hook
process.on('SIGTERM', () => gracefulShutdown()) // OS cleanup
process.on('uncaughtException', (e) => {
  appendLog(e)
  setTimeout(() => restartDaemon(), 5000)       // self-heals
})

// Files:
// ~/.quoth/daemon.pid   — PID for health check
// ~/.quoth/daemon.log   — rotating log (7 days)
// ~/.quoth/processing.lock — prevents double-processing
```

---

## Error Handling

| Failure | Impact | Recovery |
|---------|--------|----------|
| Daemon crash | No learning until next session open | session-start hook resurrects |
| Haiku subagent fails | That pipeline step skipped | Retry 3x, then log to `.quoth/errors/`, continue |
| SQLite locked | Write skipped | Retry 3x with 100ms jitter; JSONL is source of truth |
| Corrupt JSONL entry | That entry skipped | JUDGE validates JSON, logs corrupt lines, continues |
| Exolar unreachable | No seeding | Triqual stop hook catches silently, exits 0 |
| **All hooks** | Any failure | **Always exit 0 — never block Claude** |

---

## Standalone Mode

Without Triqual installed, quoth-plugin still provides full value:
- Logs all agent interactions autonomously (any project, any domain)
- Learns general coding patterns, not just test patterns
- Injects relevant patterns into every agent's context automatically
- `quoth_log_outcome` and `quoth_seed_from_exolar` simply never get called

---

## Testing Strategy

**Unit tests (Vitest):**
- `judge.test.ts` — mock `claude -p` subprocess, verify scoring logic
- `consolidate.test.ts` — merge vs strengthen vs new decision
- `confidence.test.ts` — decay math over time
- `db.test.ts` — SQLite CRUD with test fixtures

**Integration tests (Vitest):**
- Full pipeline: write JSONL → daemon processes → pattern in DB
- Daemon resurrection: kill PID → session-start hook → daemon alive
- Standalone mode: quoth-plugin without Triqual

**Hook tests (bash):**
- Each hook with `QUOTH_DEBUG=true` and mock stdin
- Verify exit 0 on all error paths

---

## What Does NOT Change

- Quoth cloud MCP tools (`quoth_search_index`, `quoth_read_doc`, `quoth_guidelines`) — unchanged
- Triqual's existing hooks — only extended, never modified
- Exolar — read-only source, never written to
- Existing `.triqual/` structure — unchanged

---

## Deliverables

1. `Triqual/triqual-plugin/` — extended with 2 hook additions
2. `Quoth/quoth-plugin/` — new standalone Claude Code plugin
3. `Quoth/quoth-plugin/daemon/` — autonomous background processor
4. `Quoth/quoth-plugin/mcp/quoth-learning-server.js` — local MCP tools
5. `Quoth/.mcp.json` — updated to include `quoth-learning` local server
