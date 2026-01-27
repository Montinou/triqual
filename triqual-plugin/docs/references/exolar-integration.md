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

Triqual's post-test hook:

1. **Reports results** to Exolar automatically
2. **Offers classification** for failures
3. **Triggers healing** when patterns are detected

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
