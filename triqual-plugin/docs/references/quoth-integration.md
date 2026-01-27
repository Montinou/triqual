# Quoth Integration

Persisting and retrieving learned patterns through the Quoth knowledge base.

## Overview

Quoth is **live documentation** that the AI reads from AND writes to. Unlike static docs, Quoth evolves as the AI learns from failures and discoveries:

- Test patterns and best practices (retrieved before writing tests)
- Page Object definitions (reused across tests)
- Common selectors and anti-patterns (learned from failures)
- Project-specific conventions (accumulated knowledge)

**Key concept:** Patterns persist across sessions. What the AI learns today helps it write better tests tomorrow.

## Authentication

On first use, authenticate at:
```
https://quoth.ai-innovation.site/
```

## Available Tools

### quoth_search_index

Search for patterns and documentation:

```typescript
quoth_search_index({ query: "login form patterns" })
```

### quoth_read_doc

Read a specific document:

```typescript
quoth_read_doc({ docId: "login-patterns" })
```

### quoth_guidelines

Get coding guidelines:

```typescript
quoth_guidelines({ mode: "playwright" })
```

## Automatic Integration

Triqual's hooks provide recommendations (not mandates):

1. **Before writing tests**: Recommends searching Quoth for relevant patterns
2. **After failures**: Suggests looking up error handling strategies
3. **Pattern learning**: The `pattern-learner` agent proposes documentation updates

### Hook Behavior

When you write a `.spec.ts` file, you'll see:

```
[Triqual] Writing test file detected.

Recommended steps before proceeding:
1. Search for existing patterns
2. Check for similar tests
3. Review results and reuse existing Page Objects
```

These are suggestions - you decide whether to follow them.

## Manual Usage

Search for patterns anytime:

```typescript
// In your workflow
quoth_search_index({ query: "login form validation" })
```

## The Learning Loop

Quoth is the **memory** of the autonomous learning loop:

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

### How Patterns Accumulate

1. **Test fails** → AI investigates with Playwright MCP
2. **Root cause found** → AI checks Exolar for similar issues
3. **Pattern identified** → pattern-learner proposes Quoth update
4. **Pattern stored** → Future tests benefit from learned knowledge

### Pattern Persistence

Unlike ephemeral session context, Quoth patterns:
- **Persist across sessions** - Knowledge isn't lost
- **Improve over time** - Each failure teaches something
- **Share across team** - Everyone benefits from discoveries
- **Version controlled** - Changes are trackable

## Best Practices

- Search Quoth before writing any new test code
- Document successful patterns immediately
- Update anti-patterns when you find fragile tests
- Let the `pattern-learner` agent propose updates from repeated failures
- Review pattern-learner proposals before accepting
