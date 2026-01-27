# Rule: Compose Page Objects for Complex Pages

> **Category**: Page Objects
> **Severity**: INFO
> **Auto-fixable**: NO

## Summary

Break down complex pages into composable Page Objects representing distinct components or sections, rather than creating monolithic page classes.

## Rationale

Modern web applications have complex UIs with reusable components like headers, sidebars, modals, and data tables that appear across multiple pages. Creating a single massive Page Object for an entire page leads to:

- **Duplication**: The same header locators repeated in every page class
- **Maintenance burden**: Changing a shared component requires updating every page class
- **Poor reusability**: Cannot share component logic between pages
- **Cognitive overload**: 500-line Page Objects are hard to navigate

Composition solves this by treating Page Objects like building blocks. A `DashboardPage` might compose `HeaderComponent`, `SidebarComponent`, and `DataTableComponent`. When the header changes, you update one class, and all pages automatically inherit the fix.

This mirrors the component architecture of modern frontend frameworks (React, Vue, Angular) and makes tests more maintainable and scalable.

## Best Practice

Create focused component Page Objects and compose them into page-level classes:

```typescript
import { expect, type Locator, type Page } from '@playwright/test';

// Reusable component: appears on many pages
export class HeaderComponent {
  readonly page: Page;
  readonly logo: Locator;
  readonly userMenu: Locator;
  readonly searchInput: Locator;
  readonly notificationsBell: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.getByRole('img', { name: 'Company Logo' });
    this.userMenu = page.getByRole('button', { name: 'User Menu' });
    this.searchInput = page.getByPlaceholder('Search...');
    this.notificationsBell = page.getByRole('button', { name: 'Notifications' });
  }

  async search(query: string) {
    await this.searchInput.fill(query);
    await this.searchInput.press('Enter');
  }

  async openUserMenu() {
    await this.userMenu.click();
  }

  async logout() {
    await this.openUserMenu();
    await this.page.getByRole('menuitem', { name: 'Logout' }).click();
  }
}

// Reusable component: modal dialog
export class ModalComponent {
  readonly page: Page;
  readonly dialog: Locator;
  readonly title: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.getByRole('dialog');
    this.title = this.dialog.getByRole('heading');
    this.closeButton = this.dialog.getByRole('button', { name: 'Close' });
  }

  async close() {
    await this.closeButton.click();
    await expect(this.dialog).not.toBeVisible();
  }

  async waitForOpen() {
    await expect(this.dialog).toBeVisible();
  }
}

// Reusable component: data table with pagination
export class DataTableComponent {
  readonly page: Page;
  readonly container: Locator;
  readonly rows: Locator;
  readonly nextButton: Locator;
  readonly prevButton: Locator;

  constructor(page: Page, containerSelector?: string) {
    this.page = page;
    this.container = containerSelector
      ? page.locator(containerSelector)
      : page.getByRole('table');
    this.rows = this.container.getByRole('row');
    this.nextButton = page.getByRole('button', { name: 'Next' });
    this.prevButton = page.getByRole('button', { name: 'Previous' });
  }

  async getRowCount(): Promise<number> {
    return await this.rows.count();
  }

  async clickRow(index: number) {
    await this.rows.nth(index).click();
  }

  async goToNextPage() {
    await this.nextButton.click();
  }
}

// Page-level class: composes components
export class DashboardPage {
  readonly page: Page;
  readonly header: HeaderComponent;
  readonly modal: ModalComponent;
  readonly dataTable: DataTableComponent;

  // Page-specific elements
  readonly addButton: Locator;
  readonly welcomeMessage: Locator;

  constructor(page: Page) {
    this.page = page;

    // Compose shared components
    this.header = new HeaderComponent(page);
    this.modal = new ModalComponent(page);
    this.dataTable = new DataTableComponent(page, '#dashboard-table');

    // Page-specific locators
    this.addButton = page.getByRole('button', { name: 'Add New' });
    this.welcomeMessage = page.getByRole('heading', { name: /welcome/i });
  }

  async goto() {
    await this.page.goto('/dashboard');
    await expect(this.welcomeMessage).toBeVisible();
  }

  async addNewItem() {
    await this.addButton.click();
    await this.modal.waitForOpen();
  }
}

// Another page reusing the same components
export class ReportsPage {
  readonly page: Page;
  readonly header: HeaderComponent;
  readonly dataTable: DataTableComponent;

  readonly exportButton: Locator;
  readonly dateRangePicker: Locator;

  constructor(page: Page) {
    this.page = page;

    // Reuse the same components
    this.header = new HeaderComponent(page);
    this.dataTable = new DataTableComponent(page, '#reports-table');

    this.exportButton = page.getByRole('button', { name: 'Export' });
    this.dateRangePicker = page.getByLabel('Date Range');
  }

  async goto() {
    await this.page.goto('/reports');
  }

  async selectDateRange(start: string, end: string) {
    await this.dateRangePicker.fill(`${start} - ${end}`);
  }
}
```

Usage in tests leverages composition:

```typescript
import { test, expect } from '@playwright/test';
import { DashboardPage } from './pages/dashboard-page';
import { ReportsPage } from './pages/reports-page';

test('user can logout from dashboard', async ({ page }) => {
  const dashboard = new DashboardPage(page);
  await dashboard.goto();

  // Use composed header component
  await dashboard.header.logout();

  await expect(page).toHaveURL(/\/login/);
});

test('user can search from any page', async ({ page }) => {
  const dashboard = new DashboardPage(page);
  await dashboard.goto();

  // Same header component, same behavior
  await dashboard.header.search('test query');

  await expect(page).toHaveURL(/\/search/);
});

test('data table pagination works across pages', async ({ page }) => {
  const reportsPage = new ReportsPage(page);
  await reportsPage.goto();

  // Same data table component, reused
  const initialCount = await reportsPage.dataTable.getRowCount();
  await reportsPage.dataTable.goToNextPage();
  const nextPageCount = await reportsPage.dataTable.getRowCount();

  expect(nextPageCount).toBeGreaterThan(0);
});
```

## Anti-Pattern

Creating monolithic Page Objects that duplicate shared component logic:

```typescript
import { type Locator, type Page } from '@playwright/test';

// Monolithic page class with all elements
export class DashboardPage {
  readonly page: Page;

  // Header elements duplicated in every page class
  readonly logo: Locator;
  readonly userMenu: Locator;
  readonly searchInput: Locator;
  readonly notificationsBell: Locator;

  // Modal elements duplicated
  readonly modalDialog: Locator;
  readonly modalCloseButton: Locator;

  // Table elements duplicated
  readonly tableRows: Locator;
  readonly tableNextButton: Locator;

  // Dashboard-specific elements buried among shared ones
  readonly addButton: Locator;
  readonly welcomeMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.getByRole('img', { name: 'Logo' });
    this.userMenu = page.getByRole('button', { name: 'User Menu' });
    this.searchInput = page.getByPlaceholder('Search...');
    // ... 50 more locators ...
  }

  // Header methods duplicated in every page class
  async search(query: string) {
    await this.searchInput.fill(query);
    await this.searchInput.press('Enter');
  }

  async logout() {
    await this.userMenu.click();
    await this.page.getByRole('menuitem', { name: 'Logout' }).click();
  }

  // Modal methods duplicated
  async closeModal() {
    await this.modalCloseButton.click();
  }

  // Table methods duplicated
  async goToNextPage() {
    await this.tableNextButton.click();
  }

  // Dashboard-specific methods lost in the noise
  async addNewItem() {
    await this.addButton.click();
  }
}

// ReportsPage duplicates ALL the same header/modal/table code
export class ReportsPage {
  readonly page: Page;
  readonly logo: Locator;
  readonly userMenu: Locator;
  readonly searchInput: Locator;
  // ... exact same duplicated code ...

  async search(query: string) {
    // Exact same implementation copied
  }

  async logout() {
    // Exact same implementation copied
  }
  // ... hundreds of lines of duplication ...
}
```

**Problems with this approach:**
- Header component updated? Must change 20+ page classes
- Cannot test components in isolation
- Page classes grow to 500+ lines
- Shared logic scattered across every page class
- New team members struggle to find relevant code
- Violates DRY (Don't Repeat Yourself) principle

## Exceptions

**Simple pages with no shared components:**

```typescript
export class PrivacyPolicyPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly contentSection: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Privacy Policy' });
    this.contentSection = page.locator('.policy-content');
  }

  async goto() {
    await this.page.goto('/privacy');
  }
}
```

If the page is truly standalone with unique elements, composition adds no value.

**Component appears on only one page:**

Don't prematurely extract components. Wait until you need them in 2-3 places before creating a shared component class.

## Auto-fix

Not auto-fixable due to requiring design decisions about component boundaries. Manual refactoring required.

**Refactoring strategy:**

1. Identify duplicated locators/methods across page classes
2. Extract to component classes (e.g., `HeaderComponent`)
3. Replace duplicated code with component composition
4. Update tests to use `page.header.method()` instead of `page.method()`

## Related Rules

- [page-object-locators](./page-object-locators.md) - Store locators in composed components
- [page-object-actions](./page-object-actions.md) - Encapsulate actions in component methods
- [test-fixtures](./test-fixtures.md) - Use fixtures to provide composed Page Objects

## References

- [Playwright Docs: Page Object Models](https://playwright.dev/docs/pom)
- [Martin Fowler: Page Object](https://martinfowler.com/bliki/PageObject.html)
- [TestMu: Playwright Page Object Model Guide](https://www.testmu.ai/learning-hub/playwright-page-object-model/)
- [CodeLime: Page Object Model with Playwright and TypeScript](https://codilime.com/blog/page-object-model-with-playwright-and-typescript/)
