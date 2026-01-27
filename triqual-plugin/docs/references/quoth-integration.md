# Quoth Integration

Integrating with Quoth knowledge base for pattern documentation.

## Overview

Quoth is a knowledge base that stores:
- Test patterns and best practices
- Page Object definitions
- Common selectors and anti-patterns
- Project-specific conventions

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

## Best Practices

- Document successful patterns in Quoth
- Update anti-patterns when you find fragile tests
- Use Quoth search before writing new Page Objects
- Let the `pattern-learner` agent propose updates from repeated failures
