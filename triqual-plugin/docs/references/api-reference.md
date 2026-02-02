# API Reference

> **Category:** Reference | **Updated:** 2026-02-02

Complete API reference for Triqual's MCP tools, TypeScript types, and configuration schema.

---

## Overview

Triqual provides:
- **MCP Tools** - External integrations (Quoth, Exolar, Playwright, Triqual Context)
- **TypeScript Types** - Configuration and agent types
- **Configuration Schema** - triqual.config.ts options

---

## MCP Tools

### Quoth Tools (Pattern Documentation)

#### quoth_search_index

Search pattern documentation.

**Signature:**

```typescript
quoth_search_index(params: {
  query: string;
}): Promise<SearchResult[]>
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | Yes | Search query (e.g., "login patterns") |

**Returns:**

```typescript
interface SearchResult {
  docId: string;
  title: string;
  excerpt: string;
  relevance: number;
}
```

**Example:**

```typescript
const results = await quoth_search_index({
  query: "authentication patterns playwright"
});

// Results:
// [
//   {
//     docId: "auth-001",
//     title: "StorageState Auth Pattern",
//     excerpt: "Use storageState for...",
//     relevance: 0.95
//   }
// ]
```

#### quoth_read_doc

Read full document by ID.

**Signature:**

```typescript
quoth_read_doc(params: {
  docId: string;
}): Promise<Document>
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `docId` | `string` | Yes | Document ID from search results |

**Returns:**

```typescript
interface Document {
  docId: string;
  title: string;
  category: string;
  content: string;
  metadata: {
    project?: string;
    tags?: string[];
    created: string;
    updated: string;
  };
}
```

**Example:**

```typescript
const doc = await quoth_read_doc({ docId: "auth-001" });

// Result:
// {
//   docId: "auth-001",
//   title: "StorageState Auth Pattern",
//   category: "authentication",
//   content: "# StorageState Pattern\n\n...",
//   metadata: {
//     tags: ["auth", "playwright"],
//     created: "2026-01-15",
//     updated: "2026-01-20"
//   }
// }
```

#### quoth_guidelines

Get coding guidelines.

**Signature:**

```typescript
quoth_guidelines(params: {
  mode: "concise" | "detailed";
}): Promise<string>
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | `"concise"` \| `"detailed"` | Yes | Guideline detail level |

**Returns:** Markdown string with guidelines

**Example:**

```typescript
const guidelines = await quoth_guidelines({ mode: "concise" });

// Result: (markdown string)
// "# Playwright Best Practices\n\n1. Use data-testid..."
```

---

### Exolar Tools (Test Analytics)

#### query_exolar_data

Query test analytics database.

**Signature:**

```typescript
query_exolar_data(params: {
  dataset: "test_search" | "test_history" | "failure_patterns";
  filters: Record<string, any>;
}): Promise<any[]>
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `dataset` | `"test_search"` \| `"test_history"` \| `"failure_patterns"` | Yes | Dataset to query |
| `filters` | `object` | Yes | Filter criteria |

**Datasets:**

| Dataset | Purpose | Filters |
|---------|---------|---------|
| `test_search` | Find tests by name/signature | `search`, `project` |
| `test_history` | Test execution history | `test_signature`, `days`, `status` |
| `failure_patterns` | Failure clustering | `error_type`, `category`, `days` |

**Example (test_search):**

```typescript
const tests = await query_exolar_data({
  dataset: "test_search",
  filters: {
    search: "login",
    project: "my-app"
  }
});

// Result:
// [
//   {
//     test_signature: "tests/login.spec.ts::login flow",
//     last_run: "2026-01-20",
//     status: "passed",
//     flake_rate: 0.02
//   }
// ]
```

**Example (test_history):**

```typescript
const history = await query_exolar_data({
  dataset: "test_history",
  filters: {
    test_signature: "tests/login.spec.ts::login flow",
    days: 30,
    status: "failed"
  }
});

// Result:
// [
//   {
//     run_id: "run-123",
//     timestamp: "2026-01-15T10:30:00Z",
//     status: "failed",
//     error_message: "Element not found",
//     category: "WAIT"
//   }
// ]
```

**Example (failure_patterns):**

```typescript
const patterns = await query_exolar_data({
  dataset: "failure_patterns",
  filters: {
    error_type: "Element not found",
    days: 30
  }
});

// Result:
// [
//   {
//     pattern: "Element not found after navigation",
//     occurrences: 12,
//     common_fixes: ["Add waitForLoadState", "Use explicit waits"],
//     category: "WAIT"
//   }
// ]
```

---

### Playwright MCP (Browser Automation)

#### browser_navigate

Navigate to URL.

**Signature:**

```typescript
browser_navigate(params: {
  url: string;
}): Promise<void>
```

#### browser_snapshot

Take screenshot and return visual context.

**Signature:**

```typescript
browser_snapshot(): Promise<{
  screenshot: string; // base64
  dom_summary: string;
}>
```

#### browser_click

Click element.

**Signature:**

```typescript
browser_click(params: {
  element: string;
  ref: string;
}): Promise<void>
```

#### browser_type

Type text into element.

**Signature:**

```typescript
browser_type(params: {
  element: string;
  ref: string;
  text: string;
}): Promise<void>
```

---

### Triqual Context MCP

#### triqual_load_context

Load comprehensive context before test generation.

**Signature:**

```typescript
triqual_load_context(params: {
  feature: string;
  ticket?: string;
  description?: string;
  force?: boolean;
}): Promise<ContextResult>
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `feature` | `string` | Yes | Feature name (e.g., "login") |
| `ticket` | `string` | No | Linear ticket ID (e.g., "ENG-123") |
| `description` | `string` | No | Text description |
| `force` | `boolean` | No | Force reload (default: false) |

**Returns:**

```typescript
interface ContextResult {
  success: boolean;
  context_dir: string;
  files_created: string[];
  quoth_patterns: number;
  exolar_failures: number;
  existing_tests: number;
}
```

**Example:**

```typescript
const result = await triqual_load_context({
  feature: "login",
  ticket: "ENG-123",
  force: false
});

// Result:
// {
//   success: true,
//   context_dir: ".triqual/context/login",
//   files_created: [
//     "patterns.md",
//     "anti-patterns.md",
//     "codebase.md",
//     "existing-tests.md",
//     "failures.md",
//     "requirements.md",
//     "summary.md"
//   ],
//   quoth_patterns: 5,
//   exolar_failures: 3,
//   existing_tests: 2
// }
```

**Context Files Created:**

| File | Content |
|------|---------|
| `patterns.md` | Quoth proven patterns |
| `anti-patterns.md` | Known failures to avoid |
| `codebase.md` | Relevant source files, selectors |
| `existing-tests.md` | Reusable tests and Page Objects |
| `failures.md` | Exolar failure history |
| `requirements.md` | Ticket/description (if provided) |
| `summary.md` | Index of all context |

---

## TypeScript Types

### Configuration Types

```typescript
// Main configuration
interface TriqualConfig {
  project_id: string;
  testDir: string;
  baseUrl: string;
  auth?: AuthConfig;
  patterns?: PatternsConfig;
  mcp?: McpConfig;
}

// Authentication
interface AuthConfig {
  strategy: 'storageState' | 'uiLogin' | 'setupProject' | 'none';
  storageState?: {
    path: string;
  };
  credentials?: {
    username: string;
    password: string;
  };
  loginUrl?: string;
  selectors?: {
    username: string;
    password: string;
    submit: string;
  };
  setupScript?: string;
}

// Test Patterns
interface PatternsConfig {
  selectors?: 'data-testid' | 'role' | 'text' | 'css';
  waitStrategy?: 'networkidle' | 'domcontentloaded' | 'load';
}

// MCP Configuration
interface McpConfig {
  quoth?: {
    enabled: boolean;
  };
  exolar?: {
    enabled: boolean;
    projectId?: string;
  };
}
```

### Agent Types

```typescript
// Agent definition
interface AgentDefinition {
  model: 'opus' | 'sonnet' | 'haiku';
  color: 'purple' | 'green' | 'blue' | 'orange';
  tools: string[];
  description: string;
}

// Agent trigger
interface AgentTrigger {
  condition: string;
  priority: number;
}
```

### Run Log Types

```typescript
// Run log structure
interface RunLog {
  feature: string;
  sessions: Session[];
  accumulated_learnings: string[];
}

interface Session {
  session_id: string;
  started_at: string;
  stages: Stage[];
}

interface Stage {
  name: 'ANALYZE' | 'RESEARCH' | 'PLAN' | 'WRITE' | 'RUN' | 'FIX' | 'LEARN';
  content: string;
  timestamp: string;
  attempt?: number;
}
```

---

## Configuration Schema

### defineConfig Function

```typescript
import { defineConfig } from 'triqual';

export default defineConfig({
  // Configuration object
});
```

**Returns:** Validated `TriqualConfig`

**Validation:**
- Required fields checked
- Types validated
- Defaults applied

**Example:**

```typescript
import { defineConfig } from 'triqual';

export default defineConfig({
  project_id: 'my-app',
  testDir: './tests',
  baseUrl: 'http://localhost:3000',

  auth: {
    strategy: 'storageState',
    storageState: { path: '.auth/user.json' },
  },

  patterns: {
    selectors: 'data-testid',
    waitStrategy: 'networkidle',
  },

  mcp: {
    quoth: { enabled: true },
    exolar: { enabled: true, projectId: 'my-app-exolar' },
  },
});
```

---

## Skill Invocation

### /init

```typescript
// No parameters
/init
```

### /test

```typescript
// Feature name
/test {feature}

// With flags
/test --explore {feature}
/test --ticket {ticket_id}
/test --describe "{description}"
```

### /check

```typescript
// No parameters
/check

// With severity
/check --severity {level}
```

### /rules

```typescript
// All rules
/rules

// Specific category
/rules {category}
```

### /help

```typescript
// General help
/help

// Topic-specific
/help {topic}
```

---

## Hook Event Types

```typescript
// Hook events
type HookEvent =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'Stop';

// Hook input
interface HookInput {
  event: HookEvent;
  tool?: string;
  parameters?: Record<string, any>;
  agent?: string;
}

// Hook output
interface HookOutput {
  exit_code: 0 | 1 | 2;
  stderr?: string;
}
```

---

## Error Types

```typescript
// MCP errors
class McpConnectionError extends Error {
  server: string;
  url: string;
}

class McpAuthError extends Error {
  server: string;
  message: string;
}

// Configuration errors
class ConfigValidationError extends Error {
  field: string;
  expected: string;
  received: string;
}

// Hook errors
class HookBlockedError extends Error {
  hook: string;
  reason: string;
  action_required: string;
}
```

---

## Constants

```typescript
// File paths
export const PATHS = {
  TRIQUAL_DIR: '.triqual',
  RUNS_DIR: '.triqual/runs',
  CONTEXT_DIR: '.triqual/context',
  KNOWLEDGE_FILE: '.triqual/knowledge.md',
  CONFIG_FILE: 'triqual.config.ts',
  DRAFT_DIR: '.draft',
  CACHE_DIR: '~/.cache/triqual',
} as const;

// Hook exit codes
export const EXIT_CODES = {
  ALLOW: 0,
  BLOCK_SILENT: 1,
  BLOCK_MESSAGE: 2,
} as const;

// Failure categories
export const FAILURE_CATEGORIES = {
  FLAKE: 'FLAKE',
  BUG: 'BUG',
  ENV: 'ENV',
  WAIT: 'WAIT',
  TEST_ISSUE: 'TEST_ISSUE',
} as const;

// Agent models
export const AGENT_MODELS = {
  OPUS: 'opus',
  SONNET: 'sonnet',
  HAIKU: 'haiku',
} as const;
```

---

## Related Documentation

- [Configuration](/docs/configuration) - Configuration guide
- [Skills Reference](/docs/skills-reference) - Skill usage
- [Agents Guide](/docs/agents-guide) - Agent details
- [Hooks System](/docs/hooks-system) - Hook architecture

---

**Next Steps:** Use this reference when integrating Triqual into your project. Check [Configuration](/docs/configuration) for setup details.
