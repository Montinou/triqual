# Exolar Integration

Integrating with Exolar for test analytics and failure tracking.

## Overview

Exolar provides:
- Test result analytics
- Failure clustering and classification
- Flake detection
- Historical trend analysis

## Authentication

On first use, authenticate at:
```
https://exolar.ai-innovation.site/
```

## Available Tools

### query_exolar_data

Query test data and analytics:

```typescript
query_exolar_data({
  dataset: "test_results",
  filters: { project: "my-project" }
})
```

### perform_exolar_action

Report or classify failures:

```typescript
perform_exolar_action({
  action: "classify_failure",
  params: {
    testId: "test-123",
    classification: "FLAKE"
  }
})
```

## Failure Classifications

| Type | Description |
|------|-------------|
| `BUG` | Actual application bug |
| `FLAKE` | Intermittent/timing issue |
| `ENV_ISSUE` | Environment/infrastructure problem |
| `TEST_BUG` | Issue with the test itself |

## Automatic Integration

After running tests, Triqual's post-test hook provides recommendations:

```
[Triqual] Test execution completed with failures.

Recommended next steps:
1. Classify the failure: Use failure-classifier agent
2. For FLAKE or TEST_ISSUE: Consider using test-healer agent
3. For BUG: Create a Linear ticket
```

### Available Agents

| Agent | Purpose |
|-------|---------|
| `failure-classifier` | Classify failures as BUG/FLAKE/ENV/TEST_ISSUE |
| `test-healer` | Auto-heal flaky or broken tests |
| `pattern-learner` | Propose Quoth documentation updates |

The hooks recommend but don't mandate - you control when to use agents.

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
