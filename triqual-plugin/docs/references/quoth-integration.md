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

Triqual's hooks automatically:

1. **Before writing tests**: Search Quoth for relevant patterns
2. **After failures**: Look up error handling strategies
3. **Pattern learning**: Propose new documentation from repeated patterns

## Manual Usage

Search for patterns before writing tests:

```bash
# Search for existing patterns
/quick-test "search quoth for authentication patterns"
```

## Best Practices

- Document successful patterns in Quoth
- Update anti-patterns when you find fragile tests
- Use Quoth search before writing new Page Objects
