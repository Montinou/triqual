# Exolar Integration

Fetching CI analytics and test history from Exolar for intelligent failure diagnosis.

## Overview

Exolar is a **CI analytics database** that stores test results from your CI/CD pipeline. The AI uses Exolar to:

- **Fetch** historical test results and trends
- **Query** failure patterns and clusters
- **Analyze** flake rates and test reliability
- **Compare** current failures against past occurrences

**Important:** Data flows FROM your CI pipeline TO Exolar. The AI READS from Exolar to make informed decisions - it does not report to Exolar.

## Data Flow

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   CI/CD     │────────▶│   EXOLAR    │◀────────│   Claude    │
│  Pipeline   │  Pushes │  Database   │  Queries│   (AI)      │
│             │  Results│             │  Data   │             │
└─────────────┘         └─────────────┘         └─────────────┘
```

## Authentication

On first use, authenticate at:
```
https://exolar.ai-innovation.site/
```

## Available Tools

### query_exolar_data

Query test data and analytics. This is the primary tool for fetching information.

**Find similar failures:**
```typescript
query_exolar_data({
  dataset: "failures",
  filters: {
    error_pattern: "timeout waiting for selector",
    project: "my-project"
  }
})
```

**Check flake history:**
```typescript
query_exolar_data({
  dataset: "flaky_tests",
  filters: {
    test_file: "login.spec.ts",
    time_range: "30d"
  }
})
```

**Get test trends:**
```typescript
query_exolar_data({
  dataset: "test_results",
  filters: {
    project: "my-project",
    time_range: "7d"
  }
})
```

**Find tests by classification:**
```typescript
query_exolar_data({
  dataset: "classified_failures",
  filters: {
    classification: "FLAKE",
    resolved: false
  }
})
```

### Common Query Patterns

| Use Case | Query |
|----------|-------|
| Similar errors | `{ dataset: "failures", filters: { error_pattern: "..." } }` |
| Flaky tests | `{ dataset: "flaky_tests", filters: { flake_rate: ">0.1" } }` |
| Recent failures | `{ dataset: "failures", filters: { time_range: "24h" } }` |
| Test duration | `{ dataset: "test_metrics", filters: { metric: "duration" } }` |
| Pass rate trends | `{ dataset: "trends", filters: { metric: "pass_rate" } }` |

## Failure Classifications

When analyzing failures, Exolar uses these classifications:

| Type | Description | AI Action |
|------|-------------|-----------|
| `BUG` | Actual application bug | Create ticket, don't modify test |
| `FLAKE` | Intermittent/timing issue | Use test-healer to fix |
| `ENV_ISSUE` | Environment/infrastructure | Check CI config |
| `TEST_BUG` | Issue with test code | Use test-healer to fix |

## Workflow Integration

### When Tests Fail

1. **Fetch similar failures:**
   ```typescript
   query_exolar_data({
     dataset: "failures",
     filters: { error_pattern: "Element not found" }
   })
   ```

2. **Check if known flake:**
   ```typescript
   query_exolar_data({
     dataset: "flaky_tests",
     filters: { test_name: "login should work" }
   })
   ```

3. **Verify with Playwright MCP:**
   - Navigate to the app
   - Inspect actual state
   - Compare expected vs actual

4. **Classify and act:**
   - Use triqual-plugin:failure-classifier agent
   - Apply appropriate fix based on classification

### Learning from History

The triqual-plugin:pattern-learner agent uses Exolar data to:
1. Identify recurring failure patterns
2. Propose documentation updates to Quoth
3. Improve future test generation

## Analytics Dashboard

View your test analytics at:
```
https://exolar.ai-innovation.site/dashboard
```

Features:
- Test pass/fail trends
- Flake rate tracking
- Failure clustering by error type
- Test duration analysis
- Historical comparison

## Best Practices

1. **Always query before diagnosing** - Check if failure is known
2. **Use filters effectively** - Narrow down to relevant data
3. **Combine with Playwright MCP** - Verify app state, don't assume
4. **Trust classifications** - Past classifications inform current analysis
5. **Look for patterns** - Recurring errors suggest systematic issues
