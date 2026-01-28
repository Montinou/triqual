# Quoth Integration (v2.0 - AI Memory)

Bidirectional learning: retrieving AND proposing patterns through the Quoth AI Memory system.

## Overview

Quoth v2 is **AI Memory** - not just documentation, but a bidirectional learning system:

```
RAG (Basic)           → Query → Vectors → Context → LLM
Agentic RAG (v1)      → Query → LLM → Tools → Context → LLM
AI Memory (v2)        → Query → LLM → Memory ⟷ Tools → Context → LLM
                                        ↑___↓
                                    Bidirectional
```

Triqual uses Quoth v2 for:
- **Search** patterns before writing tests (mandatory, enforced by hooks)
- **Propose** new patterns after discovering fixes (via `quoth_propose_update`)
- **Bootstrap** project documentation (via `quoth_genesis`)

**Key concept:** The learning loop is now CLOSED - patterns discovered during test healing are automatically proposed back to Quoth.

## Authentication

On first use, authenticate at:
```
https://quoth.ai-innovation.site/
```

## Available Tools

### quoth_search_index (READ)

Semantic search with Jina embeddings + Cohere reranking:

```typescript
quoth_search_index({ query: "login form patterns" })
```

**Enforced by hooks:** Test writing is BLOCKED until Quoth search is documented in the run log.

### quoth_read_doc (READ)

Read a specific document:

```typescript
quoth_read_doc({ docId: "login-patterns" })
```

### quoth_guidelines (READ)

Get coding guidelines:

```typescript
quoth_guidelines({ mode: "playwright" })
```

### quoth_propose_update (WRITE - NEW in v2)

Submit patterns with evidence - closes the learning loop:

```typescript
quoth_propose_update({
  type: "pattern",                        // or "decision", "error", "knowledge"
  title: "Use :visible for button disambiguation",
  content: `## Problem
Button selector matches multiple elements (hidden duplicates in menus).

## Solution
\`\`\`typescript
await page.locator('button:visible').click();
\`\`\`

## Rationale
Hidden duplicates in dropdown menus cause strict mode violations.`,
  evidence: {
    successCount: 5,                      // Pattern worked 5 times
    sourceFiles: [                        // Evidence from run logs
      ".triqual/runs/login.md",
      ".triqual/runs/checkout.md",
      ".triqual/runs/dashboard.md"
    ],
    description: "Fixed LOCATOR errors in 5 different features across 3 sessions"
  },
  tags: ["playwright", "locator", "best-practice", "visibility"]
})
```

**Used by:** `pattern-learner` agent and `test-healer` agent (for quick pattern promotion)

### quoth_genesis (WRITE - NEW in v2)

Bootstrap project documentation:

```typescript
quoth_genesis({
  depth: "standard"  // "minimal" | "standard" | "comprehensive"
})
```

| Depth | Documents | Time | Use Case |
|-------|-----------|------|----------|
| `minimal` | 3 | ~3 min | Quick overview |
| `standard` | 5 | ~7 min | Team onboarding |
| `comprehensive` | 11 | ~20 min | Enterprise audit |

**Used by:** `/init` skill (optional, user can request it)

## Automatic Integration

### Mandatory Search (Enforced by hooks)

The `pre-spec-write.sh` hook BLOCKS test writing until:

1. Run log exists at `.triqual/runs/{feature}.md`
2. RESEARCH stage contains Quoth search results

Example block message:
```
🚫 BLOCKED: Quoth pattern search not documented

**MANDATORY:** You MUST search Quoth for patterns BEFORE writing test code.

1. Search Quoth:
   mcp__quoth__quoth_search_index({ query: "{feature} playwright patterns" })

2. Document results in run log under RESEARCH stage

3. Retry this write operation
```

### Pattern Proposal (Automatic with evidence)

When `pattern-learner` or `test-healer` discovers a generalizable pattern:

1. **Evidence gathered** from run logs (3+ successful uses)
2. **Pattern formatted** with problem/solution/rationale
3. **Proposed to Quoth** via `quoth_propose_update`
4. **Awaits approval** (if Quoth is configured with approval workflows)

## The Closed Learning Loop

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    QUOTH v2 BIDIRECTIONAL LOOP                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                         QUOTH (AI Memory)                         │   │
│  │                                                                    │   │
│  │   ┌─────────────┐                      ┌─────────────┐           │   │
│  │   │   SEARCH    │                      │   PROPOSE   │           │   │
│  │   │  (before)   │                      │   (after)   │           │   │
│  │   └──────┬──────┘                      └──────▲──────┘           │   │
│  │          │                                    │                   │   │
│  └──────────┼────────────────────────────────────┼───────────────────┘   │
│             │                                    │                       │
│             ▼                                    │                       │
│    ┌─────────────────────────────────────────────┴─────┐                │
│    │                   TRIQUAL AGENTS                   │                │
│    │                                                    │                │
│    │  test-planner → test-generator → test-healer      │                │
│    │                                        │          │                │
│    │                              ┌─────────┴────────┐ │                │
│    │                              │ pattern-learner  │ │                │
│    │                              │ (proposes back)  │ │                │
│    │                              └──────────────────┘ │                │
│    └────────────────────────────────────────────────────┘                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### How Patterns Flow

1. **SEARCH before writing:**
   - test-planner searches Quoth
   - Documents patterns in run log RESEARCH stage
   - Hooks enforce this is done

2. **APPLY during writing:**
   - test-generator applies patterns from Quoth
   - Documents patterns used in WRITE stage

3. **DISCOVER during healing:**
   - test-healer finds fixes that work
   - Documents fixes in FIX stages
   - Tracks success count

4. **PROPOSE after learning:**
   - pattern-learner analyzes run logs
   - Identifies patterns with 3+ successes
   - Proposes to Quoth with evidence
   - Updates local knowledge.md too

## Local vs Remote Storage

| Location | Content | Purpose |
|----------|---------|---------|
| `.triqual/knowledge.md` | Project-specific patterns | Fast local access, survives compaction |
| `.triqual/runs/*.md` | Per-feature run logs | Evidence for pattern proposals |
| **Quoth (remote)** | Generalizable patterns | Shared across projects, teams |

**Note:** Triqual does NOT use Quoth's `.quoth/` folder. If you have both plugins:
- `.triqual/` - Triqual's testing workflow (run logs, knowledge)
- `.quoth/` - Quoth's general AI memory (if Quoth plugin is installed separately)

They serve different purposes and don't conflict.

## Best Practices

### Before Writing Tests
- **Always** search Quoth first (hooks enforce this)
- Document found patterns in run log
- Check if similar tests exist in Exolar

### During Healing
- Track fix patterns in FIX stages
- Note when the same fix works multiple times
- Consider quick promotion for obvious patterns

### After Success
- Let pattern-learner analyze run logs
- Review pattern proposals before accepting
- Update local knowledge.md with project-specific patterns
- Propose generalizable patterns to Quoth

### Pattern Quality
- Include problem/solution/rationale
- Add evidence (success count, source files)
- Use consistent tags for searchability
- Link to specific run logs for context
