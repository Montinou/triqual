# Rule: debug-slow-mo

> **Category**: Debugging
> **Severity**: ERROR
> **Auto-fixable**: YES

## Summary

Use slowMo option only for local debugging sessions; NEVER enable in CI or production test configurations.

## Rationale

The `slowMo` option slows down Playwright operations by adding artificial delays (in milliseconds) between each action. This is useful for:

- Watching test execution in real-time during local debugging
- Understanding the sequence of actions visually
- Demonstrating test flows to stakeholders
- Debugging timing-sensitive issues by slowing down execution

However, slowMo has critical limitations:

- **Artificially increases test execution time**: Tests take longer to run without providing additional debugging value compared to traces
- **Hides real timing issues**: May mask race conditions or timing bugs that only appear at normal speed
- **Not appropriate for CI**: Wastes CI resources and increases feedback time
- **Impacts performance metrics**: Makes accurate performance measurement impossible

For CI debugging, use trace viewer instead, which provides time-travel debugging without impacting execution time.

## Best Practice

Use slowMo only for local debugging with headless mode disabled:

```typescript
// Good - slowMo only enabled explicitly for local debugging
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  use: {
    // Never set slowMo in config file
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
```

Enable slowMo temporarily via command line or environment variable:

```bash
# Good - temporary local debugging
SLOW_MO=100 npx playwright test --headed

# Or use Playwright's debug mode with built-in slow motion
npx playwright test --debug
```

Conditionally enable for local debugging only:

```typescript
// Good - slowMo only in explicit debug mode
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    ...(process.env.DEBUG_SLOW === 'true' && {
      slowMo: 100,
      headless: false,
    }),
  },
});
```

## Anti-Pattern

Enabling slowMo in configuration files or CI environments:

```typescript
// Bad - slowMo in config slows down all test runs
export default defineConfig({
  use: {
    slowMo: 100, // Affects all test execution
  },
});

// Bad - slowMo enabled in CI
export default defineConfig({
  use: {
    slowMo: process.env.CI ? 50 : 0, // NEVER do this
  },
});
```

Using slowMo as a solution for flaky tests:

```typescript
// Bad - masking timing issues with slowMo
export default defineConfig({
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        slowMo: 200, // Hiding race conditions instead of fixing them
      },
    },
  ],
});
```

Hardcoding slowMo in browser launch:

```typescript
// Bad - slowMo hardcoded in test file
test('login', async () => {
  const browser = await chromium.launch({
    slowMo: 100, // Permanent slowdown
  });
  // ...
});
```

## Exceptions

1. **Test demonstrations**: Temporarily enable slowMo when demonstrating tests to non-technical stakeholders
2. **Screen recording**: Use slowMo when creating tutorial videos or documentation
3. **Visual debugging**: Enable for specific debugging sessions when you need to watch execution
4. **Investigation of timing issues**: Temporarily slow down to understand race conditions (but fix the root cause, don't keep slowMo enabled)

**CRITICAL**: Even in these cases, NEVER commit slowMo configuration to the codebase. Always use environment variables or command-line flags.

## Auto-fix

The linter can automatically remove slowMo from configuration files:

```typescript
// Before - slowMo in config
export default defineConfig({
  use: {
    slowMo: 100,
    trace: 'on-first-retry',
  },
});

// After (auto-fixed)
export default defineConfig({
  use: {
    trace: 'on-first-retry',
  },
});
```

Convert hardcoded slowMo to environment-based:

```typescript
// Before - always enabled
export default defineConfig({
  use: {
    slowMo: 100,
  },
});

// After (auto-fixed)
export default defineConfig({
  use: {
    ...(process.env.DEBUG_SLOW === 'true' && {
      slowMo: Number(process.env.SLOW_MO) || 100,
      headless: false,
    }),
  },
});
```

## Related Rules

- [debug-trace-on-failure.md](./debug-trace-on-failure.md)
- [debug-screenshots.md](./debug-screenshots.md)
- [debug-video-recording.md](./debug-video-recording.md)

## References

- [Playwright Docs: Debugging Tests](https://playwright.dev/docs/debug)
- [Understanding Playwright's test.slow() and slowMo Option](https://medium.com/@semihkasimoglu/understanding-playwrights-test-slow-and-slowmo-option-a-guide-for-efficient-test-management-8caf3a5183ba)
- [Debugging Playwright Tests Like a Pro](https://dev.to/aswani25/debugging-playwright-tests-like-a-pro-5215)
- [How to run your Playwright tests in SlowMo](https://opsmatters.com/videos/how-run-your-playwright-end-end-tests-slomo)
- [Playwright Debug: A Complete Guide](https://autify.com/blog/playwright-debug)
