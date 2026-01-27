# Playwright Rules Index

This document lists all rule categories and individual rules in the Playwright Rules documentation.

## Categories

### Locators
Rules for finding elements reliably and maintainably.

| Rule | Description | Severity |
|------|-------------|----------|
| [locator-visibility](./locator-visibility.md) | Verify element visibility before interactions | WARNING |
| [locator-first](./locator-first.md) | Use `.first()` explicitly or refine locators | ERROR |
| [selector-testid](./selector-testid.md) | Prefer `getByTestId` over CSS selectors | INFO |
| [selector-no-xpath](./selector-no-xpath.md) | Avoid fragile XPath expressions | ERROR |
| [selector-role-based](./selector-role-based.md) | Prefer role-based locators (`getByRole`) | WARNING |
| [locator-chaining](./locator-chaining.md) | Chain locators to narrow scope | WARNING |

### Waits & Timing
Rules for handling asynchronous operations and timing.

| Rule | Description | Severity |
|------|-------------|----------|
| [wait-no-timeout](./wait-no-timeout.md) | No hardcoded `waitForTimeout` | ERROR |
| [wait-for-state](./wait-for-state.md) | Prefer `waitFor` over `networkidle` | WARNING |
| [wait-auto-waiting](./wait-auto-waiting.md) | Leverage Playwright's auto-waiting | INFO |
| [wait-explicit-conditions](./wait-explicit-conditions.md) | Use explicit wait conditions | WARNING |

### Assertions
Rules for writing reliable test assertions.

| Rule | Description | Severity |
|------|-------------|----------|
| [assert-web-first](./assert-web-first.md) | Use web-first assertions | ERROR |
| [assert-specific](./assert-specific.md) | Use specific assertion methods | WARNING |
| [assert-soft](./assert-soft.md) | Use soft assertions appropriately | INFO |
| [assert-timeout](./assert-timeout.md) | Configure assertion timeouts properly | WARNING |

### Page Objects
Rules for Page Object Model implementation.

| Rule | Description | Severity |
|------|-------------|----------|
| [page-object-locators](./page-object-locators.md) | Move inline locators to Page Objects | INFO |
| [page-object-actions](./page-object-actions.md) | Encapsulate actions in methods | INFO |
| [page-object-composition](./page-object-composition.md) | Compose Page Objects for complex pages | INFO |
| [page-object-no-assertions](./page-object-no-assertions.md) | Keep assertions in tests, not POs | WARNING |

### Test Organization
Rules for structuring and organizing tests.

| Rule | Description | Severity |
|------|-------------|----------|
| [test-isolation](./test-isolation.md) | Tests must be independent | ERROR |
| [test-hooks](./test-hooks.md) | Use beforeEach/afterEach properly | WARNING |
| [test-fixtures](./test-fixtures.md) | Leverage Playwright fixtures | INFO |
| [test-describe-grouping](./test-describe-grouping.md) | Group related tests with describe | INFO |
| [test-naming](./test-naming.md) | Use descriptive test names | INFO |

### Network
Rules for handling network requests in tests.

| Rule | Description | Severity |
|------|-------------|----------|
| [network-mock-api](./network-mock-api.md) | Mock external API calls | INFO |
| [network-route-handlers](./network-route-handlers.md) | Use route handlers effectively | INFO |
| [network-wait-response](./network-wait-response.md) | Wait for specific responses | WARNING |
| [network-abort-unnecessary](./network-abort-unnecessary.md) | Abort unnecessary requests | INFO |

### Debugging
Rules for debugging and troubleshooting tests.

| Rule | Description | Severity |
|------|-------------|----------|
| [debug-trace-on-failure](./debug-trace-on-failure.md) | Enable traces for failed tests | INFO |
| [debug-screenshots](./debug-screenshots.md) | Capture screenshots strategically | INFO |
| [debug-video-recording](./debug-video-recording.md) | Configure video recording | INFO |
| [debug-slow-mo](./debug-slow-mo.md) | Use slowMo for debugging only | WARNING |

### Parallelization
Rules for running tests in parallel safely.

| Rule | Description | Severity |
|------|-------------|----------|
| [parallel-worker-isolation](./parallel-worker-isolation.md) | Ensure worker isolation | ERROR |
| [parallel-shared-state](./parallel-shared-state.md) | Avoid shared mutable state | ERROR |
| [parallel-test-data](./parallel-test-data.md) | Use unique test data per worker | WARNING |
| [parallel-serial-when-needed](./parallel-serial-when-needed.md) | Mark serial tests explicitly | INFO |

## Severity Levels

- **ERROR**: Must be fixed; will cause flaky or broken tests
- **WARNING**: Should be fixed; may cause issues in certain conditions
- **INFO**: Recommended best practice; improves maintainability

## Contributing

See [_contributing.md](./_contributing.md) for guidelines on adding new rules.
