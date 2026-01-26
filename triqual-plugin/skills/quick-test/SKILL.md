---
name: quick-test
description: |
  Quick ad-hoc browser testing with Playwright. Use when user says "test this page",
  "check if X works", "take a screenshot", "test the login", or any quick browser
  automation task. Executes custom Playwright code on-the-fly with visible browser.
user-invocable: true
allowed-tools: Read, Write, Bash, Glob, Grep
---

# Quick Test - Ad-Hoc Browser Automation

Fast, visible browser testing for exploration and debugging. Write custom Playwright code, execute immediately, see results in real-time.

## When to Use

- "Test if the homepage loads"
- "Check if the login works"
- "Take screenshots of the dashboard"
- "Fill out this form and submit"
- "Test responsive design"

## Workflow

### Step 1: Detect Target URL

For localhost testing, detect running dev servers:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/lib && node -e "require('./helpers').detectDevServers().then(s => console.log(JSON.stringify(s, null, 2)))"
```

- **1 server found**: Use it automatically
- **Multiple servers**: Ask user which one
- **No servers**: Ask for URL or check if testing external site

### Step 2: Write Script to /tmp

Always write test scripts to `/tmp/playwright-quick-*.js` (auto-cleaned by OS).

**Basic template:**

```javascript
// /tmp/playwright-quick-test.js
const { chromium } = require('playwright');

const TARGET_URL = 'http://localhost:3000'; // From detection or user

(async () => {
  const browser = await chromium.launch({
    headless: false,  // ALWAYS visible unless user requests headless
    slowMo: 100       // Visible actions
  });

  const page = await browser.newPage();

  try {
    await page.goto(TARGET_URL);
    console.log('Page title:', await page.title());

    // Your automation here

    await page.screenshot({ path: '/tmp/screenshot.png', fullPage: true });
    console.log('Screenshot saved to /tmp/screenshot.png');

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: '/tmp/error-screenshot.png' });
  } finally {
    await browser.close();
  }
})();
```

### Step 3: Execute

```bash
cd ${CLAUDE_PLUGIN_ROOT}/lib && node run.js /tmp/playwright-quick-test.js
```

## Common Patterns

### Test Page Load + Screenshot

```javascript
await page.goto(TARGET_URL);
await page.waitForLoadState('domcontentloaded');
console.log('Title:', await page.title());
await page.screenshot({ path: '/tmp/page.png', fullPage: true });
```

### Test Login Flow

```javascript
await page.goto(`${TARGET_URL}/login`);
await page.fill('input[name="email"]', 'test@example.com');
await page.fill('input[name="password"]', 'password123');
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard');
console.log('Login successful!');
```

### Test Form Submission

```javascript
await page.goto(`${TARGET_URL}/contact`);
await page.fill('input[name="name"]', 'Test User');
await page.fill('input[name="email"]', 'test@example.com');
await page.fill('textarea[name="message"]', 'Test message');
await page.click('button[type="submit"]');
await page.waitForSelector('.success-message');
console.log('Form submitted!');
```

### Test Responsive Design

```javascript
const viewports = [
  { name: 'Desktop', width: 1920, height: 1080 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Mobile', width: 375, height: 667 },
];

for (const vp of viewports) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(TARGET_URL);
  await page.screenshot({ path: `/tmp/${vp.name.toLowerCase()}.png`, fullPage: true });
  console.log(`${vp.name} screenshot saved`);
}
```

### Check for Broken Links

```javascript
await page.goto(TARGET_URL);
const links = await page.locator('a[href^="http"]').all();

for (const link of links) {
  const href = await link.getAttribute('href');
  try {
    const response = await page.request.head(href);
    console.log(`${response.ok() ? '✅' : '❌'} ${href}`);
  } catch (e) {
    console.log(`❌ ${href} - ${e.message}`);
  }
}
```

## Important Rules

1. **ALWAYS `headless: false`** unless user explicitly requests headless
2. **ALWAYS write to `/tmp/`** - never clutter the project
3. **ALWAYS use try/catch** - capture errors gracefully
4. **ALWAYS close browser** in finally block
5. **Use `slowMo: 100`** for visibility during debugging

## Helpers Available

```javascript
const helpers = require('./helpers');

// Detect dev servers
const servers = await helpers.detectDevServers();

// Safe click with retry
await helpers.safeClick(page, 'button.submit', { retries: 3 });

// Safe type with clear
await helpers.safeType(page, '#username', 'testuser');

// Take timestamped screenshot
await helpers.takeScreenshot(page, 'result');

// Handle cookie banners
await helpers.handleCookieBanner(page);

// Extract table data
const data = await helpers.extractTableData(page, 'table.results');
```

## Troubleshooting

**Playwright not installed:**
```bash
cd ${CLAUDE_PLUGIN_ROOT}/lib && npm install playwright && npx playwright install chromium
```

**Browser doesn't open:**
Check `headless: false` is set

**Element not found:**
Add wait: `await page.waitForSelector('.element', { timeout: 10000 })`

## What This Skill Does NOT Do

- Generate production test files (use `/generate-test` for that)
- Create Page Objects (use `/test-ticket` workflow)
- Report to Exolar (that's automatic via hooks)
- Search Quoth patterns (that's automatic via hooks)

This skill is for **quick exploration and debugging** only.
