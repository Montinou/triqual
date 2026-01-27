# Rule: debug-video-recording

> **Category**: Debugging
> **Severity**: INFO
> **Auto-fixable**: YES

## Summary

Configure video recording to capture test execution for failed tests while balancing storage and performance costs.

## Rationale

Video recording provides a continuous visual record of test execution, making it easier to understand the sequence of events leading to a failure. Videos are particularly useful for:

- Understanding timing issues and race conditions
- Observing animation and transition behaviors
- Debugging issues that occur between discrete actions
- Sharing failure context with team members who don't have access to trace viewer

However, videos come with trade-offs:
- Higher storage requirements than screenshots
- Performance overhead during recording
- Less detailed than traces (no DOM snapshots, console logs, or network data)

The recommended approach is to use videos as a supplement to traces, not a replacement.

## Best Practice

Configure video recording to balance debugging capability with performance:

```typescript
// Good - captures videos only for failures after retry
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    // Recommended: record video on first retry
    video: 'on-first-retry',

    // Alternative: retain video for all failures
    // video: 'retain-on-failure',

    // Traces provide more detail than videos
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  retries: process.env.CI ? 2 : 0,
});
```

Configure video size to reduce storage requirements:

```typescript
// Good - optimize video size for storage
export default defineConfig({
  use: {
    video: {
      mode: 'retain-on-failure',
      size: { width: 1280, height: 720 }, // 720p is sufficient for debugging
    },
  },
});
```

## Anti-Pattern

Always recording videos or using videos as the primary debugging tool:

```typescript
// Bad - always recording videos impacts performance and storage
export default defineConfig({
  use: {
    video: 'on', // Records for all tests, even passing ones
  },
});

// Bad - videos without traces miss critical debugging context
export default defineConfig({
  use: {
    video: 'retain-on-failure',
    trace: 'off', // Missing trace data
  },
});
```

Recording videos at excessive resolution:

```typescript
// Bad - unnecessarily large video files
export default defineConfig({
  use: {
    video: {
      mode: 'on',
      size: { width: 3840, height: 2160 }, // 4K is excessive for debugging
    },
  },
});
```

## Exceptions

1. **Performance testing**: Disable video recording when measuring test execution speed
2. **Visual demonstration**: Use `video: 'on'` when creating test documentation or demos
3. **Animation debugging**: Videos are essential for debugging timing-sensitive animations
4. **Storage-constrained CI**: Consider disabling videos if storage costs are high and traces provide sufficient context
5. **Local debugging**: You may want to enable videos temporarily using `--video on` for specific debugging sessions

## Auto-fix

The linter can automatically add or optimize video configuration:

```typescript
// Before - no video configuration
export default defineConfig({
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});

// After (auto-fixed)
export default defineConfig({
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
```

Optimize video settings for storage:

```typescript
// Before - always recording at high resolution
export default defineConfig({
  use: {
    video: 'on',
  },
});

// After (auto-fixed)
export default defineConfig({
  use: {
    video: {
      mode: 'retain-on-failure',
      size: { width: 1280, height: 720 },
    },
  },
});
```

## Related Rules

- [debug-trace-on-failure.md](./debug-trace-on-failure.md)
- [debug-screenshots.md](./debug-screenshots.md)

## References

- [Playwright Docs: Videos](https://playwright.dev/docs/videos)
- [Playwright Docs: Test Use Options](https://playwright.dev/docs/test-use-options)
- [How To Capture Screenshots & Videos using Playwright](https://www.browserstack.com/guide/playwright-screenshot)
- [Playwright Reporting: Test Reports, Video Capture, and Trace Viewer](https://medium.com/@testrig/playwright-reporting-test-reports-video-capture-and-trace-viewer-cf343c0a546a)
- [Chapter 15: Playwright Reporting and Test Artifacts](https://testingmint.com/chapter-15-playwright-reporting-and-test-artifacts/)
