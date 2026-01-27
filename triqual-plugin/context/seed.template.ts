/**
 * Seed Spec Template for Auto-Test
 *
 * This template provides auth fixtures for generated tests.
 * Copy to tests/.draft/seed.spec.ts and customize for your project.
 *
 * Usage:
 * 1. Update the import path for testUsers to match your project
 * 2. Update selectors for login form elements
 * 3. Update the post-login URL pattern
 */

import { test as base, Page } from '@playwright/test';

// TODO: Update this import path to match your project's test users location
// Common locations:
// - './fixtures/users' (local fixtures)
// - '../../shared/test-data/users' (shared test data)
// - '../../../automation/shared/test-data/users' (AttorneyShare pattern)
import { testUsers } from '../../shared/test-data/users';

/**
 * Authentication fixture types
 */
type AuthFixtures = {
  /** Page with authenticated session (standard user) */
  authenticatedPage: Page;
  /** Page with admin session */
  adminPage: Page;
};

/**
 * Extended test with authentication fixtures
 *
 * Usage in tests:
 * ```typescript
 * import { test, expect } from './seed.spec';
 *
 * test('should access dashboard', async ({ authenticatedPage }) => {
 *   await authenticatedPage.goto('/dashboard');
 *   await expect(authenticatedPage.locator('h1')).toContainText('Dashboard');
 * });
 * ```
 */
export const test = base.extend<AuthFixtures>({
  /**
   * Standard user authentication fixture
   */
  authenticatedPage: async ({ page }, use) => {
    // Navigate to login page
    // TODO: Update URL if different
    await page.goto('/login');

    // Fill login form
    // TODO: Update selectors to match your login form
    await page.fill('[data-testid="email"]', testUsers.standard.email);
    await page.fill('[data-testid="password"]', testUsers.standard.password);

    // Submit form
    // TODO: Update selector if different
    await page.click('[type="submit"]');

    // Wait for successful login
    // TODO: Update URL pattern to match post-login redirect
    await page.waitForURL('**/dashboard', { timeout: 10000 });

    // Provide the authenticated page to the test
    await use(page);
  },

  /**
   * Admin user authentication fixture
   */
  adminPage: async ({ page }, use) => {
    await page.goto('/login');

    // Use admin credentials
    await page.fill('[data-testid="email"]', testUsers.admin.email);
    await page.fill('[data-testid="password"]', testUsers.admin.password);
    await page.click('[type="submit"]');

    await page.waitForURL('**/dashboard', { timeout: 10000 });
    await use(page);
  },
});

/**
 * Re-export expect for convenience
 */
export { expect } from '@playwright/test';

/**
 * Test Users Type (for reference)
 *
 * Your users.ts should export something like:
 * ```typescript
 * export const testUsers = {
 *   standard: { email: 'test@example.com', password: 'TestPass123!' },
 *   admin: { email: 'admin@example.com', password: 'AdminPass123!' },
 * };
 * ```
 */
export type TestUser = {
  email: string;
  password: string;
};
