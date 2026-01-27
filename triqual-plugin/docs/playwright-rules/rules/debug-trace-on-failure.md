# Rule: debug-trace-on-failure

> **Category**: Debugging
> **Severity**: WARNING
> **Auto-fixable**: YES

## Summary

Enable trace recording for failed tests to capture complete execution context including DOM snapshots, console logs, and network activity.

## Rationale

Playwright's trace viewer is the most powerful debugging tool available, especially for CI failures. Traces provide a complete time-travel debugging experience that allows you to replay failed tests step-by-step with full context. This is more comprehensive than screenshots or videos alone, as traces include:

- DOM snapshots at every action
- Console logs and errors
- Network requests and responses
- Test assertions and their outcomes
- Action timings and step-by-step execution

For CI environments, traces are essential because they allow developers to debug failures that only occur in CI without reproducing locally.

## Best Practice

Configure traces to be captured on failure or retry using the `trace` option in `playwright.config.ts`:

```typescript
// Good - captures traces for debugging without impacting performance
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    // Recommended for CI: capture trace on first retry
    trace: 'on-first-retry',

    // Alternative: capture trace for all failures (no retry needed)
    // trace: 'retain-on-failure',
  },

  // Enable retries in CI
  retries: process.env.CI ? 2 : 0,
});
```

For maximum debugging capability, combine with screenshots and videos:

```typescript
// Good - comprehensive debugging setup
export default defineConfig({
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  retries: process.env.CI ? 2 : 0,
});
```

## Anti-Pattern

Leaving traces disabled or always enabled without consideration for performance:

```typescript
// Bad - no traces captured, debugging CI failures is difficult
export default defineConfig({
  use: {
    trace: 'off',
  },
});

// Bad - always recording traces impacts performance significantly
export default defineConfig({
  use: {
    trace: 'on', // Records traces even for passing tests
  },
});
```

Not configuring artifact retention in CI:

```yaml
# Bad - traces not uploaded for failed tests
- name: Run tests
  run: npx playwright test
# Missing: Upload artifacts step
```

## Exceptions

1. **Local development**: You may want to enable traces manually for specific debugging sessions using `--trace on`
2. **Performance testing**: Disable traces when measuring test execution performance
3. **Storage constraints**: If CI storage is limited, consider `on-first-retry` instead of `retain-on-failure` to reduce artifact size

## Auto-fix

The linter can automatically add or fix the trace configuration:

```typescript
// Before - no trace configuration
export default defineConfig({
  use: {
    screenshot: 'only-on-failure',
  },
});

// After (auto-fixed)
export default defineConfig({
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
```

## Related Rules

- [debug-screenshots.md](./debug-screenshots.md)
- [debug-video-recording.md](./debug-video-recording.md)

## References

- [Playwright Docs: Trace Viewer](https://playwright.dev/docs/trace-viewer)
- [Playwright Docs: Tracing API](https://playwright.dev/docs/api/class-tracing)
- [Playwright Docs: Test Configuration](https://playwright.dev/docs/test-configuration)
- [The Ultimate Guide to Playwright Trace Viewer](https://momentic.ai/blog/the-ultimate-guide-to-playwright-trace-viewer-master-time-travel-debugging)
- [Faster Debugging with Playwright Trace Viewer](https://www.alphabin.co/blog/how-to-use-playwright-trace-viewer)
