# Rule: debug-screenshots

> **Category**: Debugging
> **Severity**: WARNING
> **Auto-fixable**: YES

## Summary

Capture screenshots strategically to provide visual evidence of test failures without impacting test performance.

## Rationale

Screenshots turn invisible failures into clear, actionable evidence by showing exactly what the browser displayed at the moment of failure. They are especially valuable for:

- Visual regression detection
- UI state verification at failure points
- Quick failure triage without viewing full traces
- Debugging layout and rendering issues

Unlike video recording, screenshots have minimal performance overhead and storage requirements, making them ideal for capturing every failure. When combined with traces, screenshots appear as a film strip in the trace viewer for easier debugging.

## Best Practice

Configure screenshots to capture on failure using the `screenshot` option in `playwright.config.ts`:

```typescript
// Good - captures screenshots only when needed
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    // Recommended: capture screenshot on test failure
    screenshot: 'only-on-failure',

    // Screenshots automatically included in traces
    trace: 'on-first-retry',
  },
});
```

For programmatic screenshot capture during debugging:

```typescript
// Good - strategic screenshot for debugging specific state
test('complex workflow', async ({ page }) => {
  await page.goto('https://example.com');
  await page.click('#submit');

  // Capture screenshot at critical checkpoint
  await page.screenshot({
    path: 'debug-after-submit.png',
    fullPage: true
  });

  await expect(page.locator('.result')).toBeVisible();
});
```

## Anti-Pattern

Taking screenshots on every action or leaving screenshots disabled:

```typescript
// Bad - no screenshots captured, visual debugging is difficult
export default defineConfig({
  use: {
    screenshot: 'off',
  },
});

// Bad - excessive screenshots impact performance and storage
export default defineConfig({
  use: {
    screenshot: 'on', // Captures for all tests, even passing ones
  },
});
```

Taking screenshots unnecessarily in test code:

```typescript
// Bad - excessive programmatic screenshots slow down tests
test('login flow', async ({ page }) => {
  await page.screenshot({ path: 'step1.png' });
  await page.goto('https://example.com');
  await page.screenshot({ path: 'step2.png' });
  await page.fill('#username', 'user');
  await page.screenshot({ path: 'step3.png' });
  await page.fill('#password', 'pass');
  await page.screenshot({ path: 'step4.png' });
  // Too many screenshots!
});
```

## Exceptions

1. **Visual regression testing**: Use `screenshot: 'on'` when explicitly testing visual changes
2. **Documentation**: Programmatic screenshots are acceptable for generating test documentation
3. **Specific debugging sessions**: Temporarily enable for all tests when investigating flaky issues
4. **Critical state capture**: Take programmatic screenshots at important checkpoints during complex flows

## Auto-fix

The linter can automatically add or fix the screenshot configuration:

```typescript
// Before - no screenshot configuration
export default defineConfig({
  use: {
    trace: 'on-first-retry',
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

Remove excessive programmatic screenshots:

```typescript
// Before - excessive screenshots in test
test('workflow', async ({ page }) => {
  await page.screenshot({ path: 'step1.png' });
  await page.click('#button');
  await page.screenshot({ path: 'step2.png' });
});

// After (auto-fixed) - rely on automatic failure screenshots
test('workflow', async ({ page }) => {
  await page.click('#button');
  // Automatic screenshot captured on failure
});
```

## Related Rules

- [debug-trace-on-failure.md](./debug-trace-on-failure.md)
- [debug-video-recording.md](./debug-video-recording.md)

## References

- [Playwright Docs: Screenshots](https://playwright.dev/docs/screenshots)
- [Playwright Docs: Test Use Options](https://playwright.dev/docs/test-use-options)
- [How To Capture Screenshots & Videos using Playwright](https://www.browserstack.com/guide/playwright-screenshot)
- [Playwright Reporting: Test Reports, Video Capture, and Trace Viewer](https://medium.com/@testrig/playwright-reporting-test-reports-video-capture-and-trace-viewer-cf343c0a546a)
