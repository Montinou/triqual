# Exolar Integration - CI Analytics Database

This document describes how to integrate with Exolar to **fetch** CI analytics, failure history, and test trends.

## Overview

Exolar is a **CI analytics database** that stores test results from your CI/CD pipeline. The AI uses Exolar to:

1. **Fetch** historical test results and trends
2. **Query** failure patterns and clusters
3. **Analyze** flake rates and test reliability
4. **Compare** current failures against past occurrences

**Important:** Data flows FROM your CI pipeline TO Exolar. The AI READS from Exolar to make informed decisions - it does not report to Exolar.

## MCP Tools

### explore_exolar_index

Discover available data categories and datasets.

**Parameters:**
```typescript
{
  category?: string  // Optional: filter to specific category
}
```

**Usage:**
```
explore_exolar_index({})

// Or with category filter
explore_exolar_index({ category: "executions" })
```

**Returns:**
```typescript
{
  categories: [
    {
      name: "executions",
      description: "Test execution results",
      datasets: ["recent", "by_branch", "by_test", "by_date"]
    },
    {
      name: "failures",
      description: "Failed test analysis",
      datasets: ["clustered", "flaky", "recurring", "new"]
    },
    {
      name: "performance",
      description: "Test timing metrics",
      datasets: ["slow_tests", "timing_trends", "duration_by_file"]
    }
  ]
}
```

### query_exolar_data

Query specific datasets for analytics.

**Parameters:**
```typescript
{
  dataset: string,        // Dataset identifier
  filters?: {             // Optional filters
    branch?: string,
    date_range?: string,
    test_name?: string,
    status?: string
  },
  limit?: number          // Max results (default: 100)
}
```

**Usage Examples:**

```
// Recent executions
query_exolar_data({
  dataset: "executions/recent",
  limit: 20
})

// Failures for specific branch
query_exolar_data({
  dataset: "failures/clustered",
  filters: { branch: "feature/auth-flow" }
})

// Flaky tests
query_exolar_data({
  dataset: "failures/flaky",
  filters: { date_range: "last_7_days" }
})

// Slow tests
query_exolar_data({
  dataset: "performance/slow_tests",
  limit: 10
})
```

**Returns:**
```typescript
{
  dataset: "executions/recent",
  count: 20,
  data: [
    {
      id: "exec-123",
      branch: "main",
      status: "passed",
      tests_run: 45,
      tests_passed: 44,
      tests_failed: 1,
      duration_seconds: 180,
      timestamp: "2025-01-20T10:30:00Z"
    },
    // ...
  ]
}
```

### perform_exolar_action

Perform actions like reporting results or triggering analysis.

**Parameters:**
```typescript
{
  action: string,        // Action type
  payload: object        // Action-specific data
}
```

**Available Actions:**

```typescript
// Report test results
perform_exolar_action({
  action: "report_results",
  payload: {
    branch: "feature/new-feature",
    commit: "abc123",
    results: [
      { test: "login.spec.ts", status: "passed", duration: 5.2 },
      { test: "checkout.spec.ts", status: "failed", error: "Timeout" }
    ]
  }
})

// Trigger failure analysis
perform_exolar_action({
  action: "analyze_failures",
  payload: {
    execution_id: "exec-123"
  }
})

// Mark as known flake
perform_exolar_action({
  action: "mark_flaky",
  payload: {
    test_name: "login.spec.ts",
    reason: "Timing-dependent on network"
  }
})

// Request test healing
perform_exolar_action({
  action: "request_healing",
  payload: {
    test_name: "checkout.spec.ts",
    failure_id: "fail-456"
  }
})
```

---

## Data Categories

### Executions

Test run history and status:

| Dataset | Description | Key Fields |
|---------|-------------|------------|
| recent | Latest executions | branch, status, timestamp |
| by_branch | Grouped by branch | branch, pass_rate, trend |
| by_test | Per-test history | test_name, success_rate |
| by_date | Daily aggregates | date, total, passed, failed |

### Failures

Failure analysis and clustering:

| Dataset | Description | Key Fields |
|---------|-------------|------------|
| clustered | Grouped by error | cluster_id, error_pattern, count |
| flaky | Inconsistent tests | test_name, flake_rate, last_flake |
| recurring | Repeated failures | test_name, failure_count, last_seen |
| new | First-time failures | test_name, first_failure, error |

### Performance

Timing and efficiency metrics:

| Dataset | Description | Key Fields |
|---------|-------------|------------|
| slow_tests | Longest running | test_name, avg_duration, trend |
| timing_trends | Duration over time | date, avg_duration, p95 |
| duration_by_file | File-level timing | file, total_duration, test_count |

---

## Integration Workflows

### Before Running Tests

Check current state:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BEFORE RUNNING TESTS                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Check for known flaky tests                                            │
│      query_exolar_data({                                                    │
│        dataset: "failures/flaky",                                           │
│        limit: 10                                                            │
│      })                                                                     │
│                                                                              │
│   2. Check recent branch status                                             │
│      query_exolar_data({                                                    │
│        dataset: "executions/by_branch",                                     │
│        filters: { branch: "current-branch" }                                │
│      })                                                                     │
│                                                                              │
│   3. Identify potentially problematic tests                                 │
│      query_exolar_data({                                                    │
│        dataset: "failures/recurring"                                        │
│      })                                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### After Test Run

Fetch history and investigate:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AFTER TEST RUN                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. If failures exist, fetch similar failures                              │
│      query_exolar_data({                                                    │
│        dataset: "failures/clustered",                                       │
│        filters: { error_pattern: "Timeout" }                                │
│      })                                                                     │
│                                                                              │
│   2. Check if known flake                                                   │
│      query_exolar_data({                                                    │
│        dataset: "failures/flaky",                                           │
│        filters: { test_name: "failing-test.spec.ts" }                       │
│      })                                                                     │
│                                                                              │
│   3. Use Playwright MCP to explore app and verify actual behavior           │
│      browser_navigate({ url: "http://localhost:3000/failing-page" })        │
│      browser_snapshot({})                                                   │
│                                                                              │
│   4. Classify failure based on evidence                                     │
│      - BUG: App behavior differs from spec                                  │
│      - FLAKE: Inconsistent results, timing-related                          │
│      - ENV: Works locally, fails in CI                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Investigating Failures

Deep dive into failures:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    INVESTIGATING FAILURES                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Get failure details                                                    │
│      query_exolar_data({                                                    │
│        dataset: "failures/clustered",                                       │
│        filters: { test_name: "failing-test.spec.ts" }                       │
│      })                                                                     │
│                                                                              │
│   2. Check historical patterns                                              │
│      query_exolar_data({                                                    │
│        dataset: "executions/by_test",                                       │
│        filters: { test_name: "failing-test.spec.ts" }                       │
│      })                                                                     │
│                                                                              │
│   3. Compare with similar tests                                             │
│      query_exolar_data({                                                    │
│        dataset: "failures/clustered",                                       │
│        filters: { cluster_id: "cluster-xyz" }                               │
│      })                                                                     │
│                                                                              │
│   4. Check if timing related                                                │
│      query_exolar_data({                                                    │
│        dataset: "performance/slow_tests",                                   │
│        filters: { test_name: "failing-test.spec.ts" }                       │
│      })                                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Failure Classification

### FLAKE vs BUG vs ENV

Exolar helps classify failures:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FAILURE CLASSIFICATION                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   FLAKE (Flaky Test)                                                        │
│   ──────────────────                                                        │
│   • Passes sometimes, fails sometimes                                       │
│   • Same code, different results                                            │
│   • Often timing-related                                                    │
│   • Action: Fix timing/stability issues                                     │
│                                                                              │
│   Indicators:                                                               │
│   - flake_rate > 10% in Exolar                                              │
│   - Inconsistent pass/fail in same PR                                       │
│   - "Timeout" errors intermittent                                           │
│                                                                              │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                              │
│   BUG (Real Application Bug)                                                │
│   ──────────────────────────                                                │
│   • Consistent failure                                                      │
│   • Application behavior changed                                            │
│   • Test expectations still valid                                           │
│   • Action: File bug, fix application                                       │
│                                                                              │
│   Indicators:                                                               │
│   - First appeared after specific commit                                    │
│   - 100% failure rate after change                                          │
│   - Assertion error on actual vs expected                                   │
│                                                                              │
│   ───────────────────────────────────────────────────────────────────────   │
│                                                                              │
│   ENV (Environment Issue)                                                   │
│   ───────────────────────                                                   │
│   • Fails in one environment, passes in another                             │
│   • Infrastructure-related                                                  │
│   • Not code-related                                                        │
│   • Action: Fix environment, not test                                       │
│                                                                              │
│   Indicators:                                                               │
│   - Fails in CI, passes locally                                             │
│   - Network/connection errors                                               │
│   - "Connection refused" or "ECONNRESET"                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Using Exolar for Classification

```typescript
// 1. Get failure history
const history = await query_exolar_data({
  dataset: "executions/by_test",
  filters: { test_name: "login.spec.ts" },
  limit: 20
});

// 2. Calculate flake rate
const flakeRate = calculateFlakeRate(history.data);

// 3. Classification logic
if (flakeRate > 0.1) {
  // Flaky test - passes sometimes, fails sometimes
  classification = "FLAKE";
} else if (allRecentFailed(history.data)) {
  // Consistent failure - likely real bug
  classification = "BUG";
} else if (failsOnlyInCI(history.data)) {
  // Environment specific
  classification = "ENV";
}
```

---

## Dashboard Queries

### Executive Summary

```typescript
// Overall health
query_exolar_data({
  dataset: "executions/by_date",
  filters: { date_range: "last_7_days" }
})

// Pass rate trend
query_exolar_data({
  dataset: "executions/by_branch",
  filters: { branch: "main" }
})

// Top failures
query_exolar_data({
  dataset: "failures/recurring",
  limit: 5
})
```

### Test Health Report

```typescript
// Flaky tests needing attention
query_exolar_data({
  dataset: "failures/flaky",
  filters: { flake_rate_min: 0.1 }
})

// Slow tests
query_exolar_data({
  dataset: "performance/slow_tests",
  filters: { avg_duration_min: 30 }
})

// New failures (last 24h)
query_exolar_data({
  dataset: "failures/new",
  filters: { date_range: "last_24_hours" }
})
```

### PR Analysis

```typescript
// Branch-specific results
query_exolar_data({
  dataset: "executions/by_branch",
  filters: { branch: "feature/my-feature" }
})

// Failures introduced by PR
query_exolar_data({
  dataset: "failures/new",
  filters: { branch: "feature/my-feature" }
})

// Comparison with main
query_exolar_data({
  dataset: "executions/by_branch",
  filters: { branch: "main" }
})
```

---

## Reporting Results

### Automatic Reporting

Configure test runner to report:

```typescript
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['html'],
    ['./exolar-reporter.ts']  // Custom Exolar reporter
  ]
});
```

### Manual Reporting

After ad-hoc test runs:

```typescript
perform_exolar_action({
  action: "report_results",
  payload: {
    branch: process.env.BRANCH || "local",
    commit: process.env.COMMIT || "unknown",
    environment: "local",
    results: [
      {
        test: "login.spec.ts",
        file: "tests/auth/login.spec.ts",
        status: "passed",
        duration: 5.234,
        retries: 0
      },
      {
        test: "checkout.spec.ts",
        file: "tests/commerce/checkout.spec.ts",
        status: "failed",
        duration: 30.001,
        error: "Timeout waiting for selector",
        screenshot: "screenshots/checkout-failure.png"
      }
    ]
  }
})
```

### Result Schema

```typescript
interface TestResult {
  test: string;           // Test name
  file: string;           // File path
  status: 'passed' | 'failed' | 'skipped';
  duration: number;       // Seconds
  retries?: number;       // Retry count
  error?: string;         // Error message (if failed)
  screenshot?: string;    // Path to screenshot (if failed)
  trace?: string;         // Path to trace (if available)
}

interface ExecutionReport {
  branch: string;
  commit: string;
  environment: string;    // 'local' | 'ci' | 'staging'
  timestamp?: string;     // ISO date
  results: TestResult[];
}
```

---

## Integration with Test Healing

### Requesting Healing

When a failure is identified:

```typescript
// 1. Get failure details
const failure = await query_exolar_data({
  dataset: "failures/clustered",
  filters: { test_name: "checkout.spec.ts" }
});

// 2. Check if healable
const isHealable = failure.data[0].error_type === 'locator_failure';

// 3. Request healing
if (isHealable) {
  await perform_exolar_action({
    action: "request_healing",
    payload: {
      test_name: "checkout.spec.ts",
      failure_id: failure.data[0].id,
      error_pattern: failure.data[0].error_pattern
    }
  });
}
```

### Healing Feedback Loop

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    HEALING FEEDBACK LOOP                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Test fails, AI fetches history from Exolar                             │
│      ↓                                                                      │
│   2. AI uses Playwright MCP to verify actual behavior                       │
│      ↓                                                                      │
│   3. AI classifies: FLAKE, BUG, ENV, or TEST_ISSUE                          │
│      ↓                                                                      │
│   4. If FLAKE/TEST_ISSUE: test-healer agent attempts fix                    │
│      ↓                                                                      │
│   5. Run fixed test                                                         │
│      ↓                                                                      │
│   6. CI pipeline sends new results to Exolar                                │
│      ↓                                                                      │
│   7. If successful: pattern-learner proposes Quoth update                   │
│      If failed: escalate for manual review                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Metrics and Alerts

### Key Metrics

| Metric | Formula | Alert Threshold |
|--------|---------|-----------------|
| Pass Rate | passed / total | < 95% |
| Flake Rate | flaky_runs / total_runs | > 5% |
| Avg Duration | sum(duration) / count | > 10 min |
| New Failures | count(first_failure = today) | > 3 |

### Query for Alerts

```typescript
// Check pass rate
const recent = await query_exolar_data({
  dataset: "executions/by_date",
  filters: { date_range: "last_24_hours" }
});

const passRate = recent.data[0].passed / recent.data[0].total;
if (passRate < 0.95) {
  alert("Pass rate below 95%");
}

// Check flake rate
const flaky = await query_exolar_data({
  dataset: "failures/flaky",
  filters: { flake_rate_min: 0.1 }
});

if (flaky.count > 5) {
  alert("Multiple highly flaky tests detected");
}
```

---

## Best Practices

### Regular Maintenance

```
□ Review flaky tests weekly
□ Address recurring failures promptly
□ Monitor timing trends
□ Clean up obsolete data
□ Update flaky markers when fixed
```

### Using Analytics Effectively

```
□ Check Exolar before debugging failures
□ Use historical data to identify patterns
□ Report all test runs (local and CI)
□ Classify failures accurately
□ Track healing success rate
```

### Integration Checklist

```
□ Exolar MCP server connected
□ Test query_exolar_data with sample
□ Configure automatic reporting
□ Set up failure classification
□ Enable healing workflow
□ Configure alert thresholds
```
