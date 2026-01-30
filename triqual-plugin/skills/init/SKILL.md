---
name: init
description: "Initialize Triqual for this project. Analyzes project structure, detects existing tests, generates config. Run on first use or after major changes."
---

# /init - Project Genesis

Configure Triqual for the current project by analyzing its structure and generating personalized configuration files.

## When to Use

- **First time using Triqual** in a project
- **After major project restructuring** (new test directories, different framework setup)
- **When onboarding a new team member** to ensure consistent configuration
- **After updating Triqual plugin** to regenerate configuration with new features

## Quick Start

```bash
/init                    # Interactive - analyzes and generates config
/init --force            # Regenerate even if config exists
```

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRIQUAL INIT PROCESS                        │
├─────────────────────────────────────────────────────────────────┤
│  0. CREATE .TRIQUAL DIRECTORY                                   │
│     ├── mkdir -p .triqual/runs                                  │
│     └── Create knowledge.md from template                       │
│                                                                 │
│  1. CHECK EXISTING CONFIG                                       │
│     └── Skip if triqual.config.ts exists (unless --force)       │
│                                                                 │
│  2. DETECT PROJECT STRUCTURE                                    │
│     ├── Find playwright.config.ts/js                            │
│     ├── Locate test directories                                 │
│     ├── Identify Page Objects                                   │
│     └── Scan package.json for dependencies                      │
│                                                                 │
│  3. ANALYZE EXISTING TESTS                                      │
│     ├── Count .spec.ts / .test.ts files                         │
│     ├── Extract common selectors                                │
│     ├── Detect timeout patterns                                 │
│     └── Identify helper functions                               │
│                                                                 │
│  4. DETECT AUTHENTICATION STRATEGY                              │
│     ├── Check for .auth/ storageState files                     │
│     ├── Find auth.setup.ts / global-setup.ts                    │
│     ├── Locate test credentials (users.ts, .env.test)           │
│     ├── Parse playwright.config for storageState usage          │
│     └── Determine best auth strategy for /test                  │
│                                                                 │
│  5. DETECT MCP CAPABILITIES                                     │
│     ├── Check Playwright MCP availability                       │
│     ├── Verify browser_run_code for storageState                │
│     ├── Check Quoth/Exolar connectivity                         │
│     └── Configure fallback strategies                           │
│                                                                 │
│  6. GENERATE CONFIGURATION                                      │
│     ├── triqual.config.ts (root) - TypeScript with defineConfig │
│     └── Docs/context/ (optional detailed config)                │
│         ├── project.json                                        │
│         ├── patterns.json                                       │
│         └── selectors.json                                      │
│                                                                 │
│  7. DISPLAY SUMMARY                                             │
│     └── Show what was detected and generated                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 0: Create .triqual Directory Structure

Before anything else, ensure the .triqual directory structure exists:

```bash
# Create .triqual directory structure
mkdir -p .triqual/runs

# Check if knowledge.md exists, create from template if not
ls .triqual/knowledge.md 2>/dev/null
```

If `.triqual/knowledge.md` doesn't exist, create it from the template at `${PLUGIN_ROOT}/context/knowledge.template.md`:

```bash
# Get plugin root (where Triqual is installed)
# Copy knowledge template
cp "${PLUGIN_ROOT}/context/knowledge.template.md" .triqual/knowledge.md
```

The `.triqual/` directory structure:
```
.triqual/
├── runs/           # Run logs for each feature (e.g., login.md, dashboard.md)
└── knowledge.md    # Project-specific test knowledge (accumulated learnings)
```

**Important:** Run logs in `.triqual/runs/` are required by hooks before writing test files.

---

## Step 1: Check Existing Configuration

First, check if Triqual is already configured:

```bash
# Check for existing configuration files (prefer .ts)
ls triqual.config.ts 2>/dev/null || ls triqual.config.json 2>/dev/null
```

**If configuration exists:**
- Inform user: "Triqual is already configured. Use `/init --force` to regenerate."
- Exit unless `--force` flag is provided

**If no configuration:**
- Proceed with analysis

---

## Step 2: Detect Project Structure

### 2.1 Find Playwright Configuration

```bash
# Look for Playwright config files
ls playwright.config.ts playwright.config.js 2>/dev/null
```

If found, read it to extract:
- `testDir` - Where tests are located
- `baseURL` - Default application URL
- `timeout` - Global timeout settings
- `projects` - Multi-project setup

### 2.2 Analyze package.json

```bash
cat package.json | grep -E '"@playwright|"playwright|"test":'
```

Extract:
- Playwright version
- Test scripts (npm test, npm run test:e2e, etc.)
- Related dependencies (test utilities)

### 2.3 Find Test Directories

Search in common locations:

```bash
# Common test directory patterns
ls -d tests/ test/ e2e/ automation/ playwright/ spec/ __tests__/ 2>/dev/null

# Playwright-specific
ls -d automation/playwright/tests/ e2e/tests/ tests/e2e/ 2>/dev/null
```

### 2.4 Locate Page Objects

```bash
# Find Page Object files
find . -name "*.page.ts" -o -name "*.page.js" -o -name "*Page.ts" -o -name "*Page.js" 2>/dev/null | head -20
```

### 2.5 Find Helpers and Utilities

```bash
# Find helper/utility files
find . -path "*/helpers/*" -name "*.ts" -o -path "*/utils/*" -name "*.ts" 2>/dev/null | head -20
```

---

## Step 3: Analyze Existing Tests

### 3.1 Count Test Files

```bash
# Count .spec.ts and .test.ts files
find . -name "*.spec.ts" -o -name "*.test.ts" 2>/dev/null | wc -l
```

### 3.2 Extract Common Selectors

Read a sample of test files and identify selector patterns:

```bash
# Find most common selector patterns
grep -Erh "locator|getByRole|getByTestId|data-testid" --include="*.spec.ts" . 2>/dev/null | head -50
```

Identify:
- Primary strategy (data-testid, role, text)
- Custom attributes
- Page-specific patterns

### 3.3 Detect Timeout Patterns

```bash
# Check for timeout usage
grep -rh "timeout:" --include="*.spec.ts" . 2>/dev/null | head -20
```

### 3.4 Find Authentication Setup

```bash
# Look for auth setup
ls .auth/ auth.setup.ts global-setup.ts 2>/dev/null
grep -rh "storageState" --include="*.ts" . 2>/dev/null | head -10
```

---

## Step 4: Detect Authentication Strategy

This is critical for `/test` to work with authenticated flows. Detect what auth methods are available and choose the best strategy.

### 4.1 Check for Saved StorageState

```bash
# Check for .auth/ directory with saved state
ls -la .auth/*.json 2>/dev/null

# Common patterns
ls .auth/user.json .auth/admin.json .auth/storageState.json 2>/dev/null
```

**If found:** Can use `storageState` directly via Playwright MCP's `browser_run_code`:

```javascript
browser_run_code({
  code: `async (page) => {
    await page.context().addCookies(require('./.auth/user.json').cookies);
  }`
})
```

### 4.2 Check for Auth Setup Files

```bash
# Playwright auth setup patterns
ls auth.setup.ts tests/auth.setup.ts e2e/auth.setup.ts 2>/dev/null
ls global-setup.ts tests/global-setup.ts 2>/dev/null
```

**If found:** Read the file to understand the auth flow:

```bash
# Extract auth flow details
grep -A 20 "authenticate\|login\|storageState" auth.setup.ts 2>/dev/null
```

### 4.3 Check playwright.config.ts for Auth Projects

```bash
# Look for setup project configuration
grep -A 10 "name.*setup\|dependencies.*setup\|storageState" playwright.config.ts 2>/dev/null
```

**Look for patterns like:**

```typescript
// Project with dependencies
{
  name: 'chromium',
  use: { storageState: '.auth/user.json' },
  dependencies: ['setup'],
}

// Setup project
{
  name: 'setup',
  testMatch: /.*\.setup\.ts/,
}
```

### 4.4 Locate Test Credentials

```bash
# Find credential files
find . -name "users.ts" -path "*test-data*" 2>/dev/null
find . -name "test-users.ts" -o -name "testUsers.ts" 2>/dev/null
find . -name "credentials.ts" -path "*test*" 2>/dev/null

# Check for environment-based credentials
ls .env.test .env.local .env.testing 2>/dev/null
grep -l "TEST_USER\|TEST_PASSWORD\|E2E_" .env* 2>/dev/null
```

**Expected credential file format:**

```typescript
// automation/shared/test-data/users.ts
export const testUsers = {
  standard: {
    email: 'test@example.com',
    password: 'TestPass123!',
    name: 'Test User'
  },
  admin: {
    email: 'admin@example.com',
    password: 'AdminPass123!',
    name: 'Admin User'
  }
};
```

### 4.5 Detect Login Page Selectors

If we need to log in via UI, find the login page selectors:

```bash
# Find login-related test files or page objects
find . -name "*login*" -name "*.ts" 2>/dev/null | head -10
find . -name "*Login*" -name "*.ts" 2>/dev/null | head -10

# Extract login selectors from existing code
grep -rh "email\|password\|login\|submit" --include="*[Ll]ogin*.ts" . 2>/dev/null | head -20
```

### 4.6 Determine Auth Strategy

Based on detection, choose the best strategy for `/test`:

| Priority | Strategy | When to Use | Config Key |
|----------|----------|-------------|------------|
| 1 | `storageState` | `.auth/*.json` exists and is fresh | `auth.strategy: "storageState"` |
| 2 | `setupProject` | `auth.setup.ts` exists with dependencies | `auth.strategy: "setupProject"` |
| 3 | `uiLogin` | Credentials file exists, no saved state | `auth.strategy: "uiLogin"` |
| 4 | `none` | No auth needed or not detected | `auth.strategy: "none"` |

### 4.7 Generate Auth Configuration

Add to `triqual.config.ts`:

```typescript
import { defineConfig } from 'triqual';
import { testUsers } from './automation/shared/test-data/users';

export default defineConfig({
  // ... other config
  auth: {
    strategy: 'storageState', // or 'setupProject' | 'uiLogin' | 'none'

    storageState: {
      path: '.auth/user.json',
    },

    uiLogin: {
      credentials: testUsers.standard,
      loginUrl: '/login',
      selectors: {
        email: '[data-testid="email"]',
        password: '[data-testid="password"]',
        submit: '[type="submit"]',
      },
      successUrl: '/dashboard',
    },

    setupProject: 'setup',

    users: {
      default: 'standard',
      available: testUsers,
    },

    fallbackChain: ['storageState', 'uiLogin', 'none'],
  },
});
```

---

## Step 5: Detect MCP Capabilities

Check what MCP tools are available and configure accordingly.

### 5.1 Check Playwright MCP

The `/test` skill uses Playwright MCP for browser automation. Verify it's available:

```bash
# Check if Playwright MCP is in .mcp.json
cat .mcp.json 2>/dev/null | grep -i playwright
```

**Playwright MCP capabilities for auth:**

| Tool | Auth Use Case |
|------|---------------|
| `browser_navigate` | Go to login page |
| `browser_fill_form` | Fill email/password |
| `browser_click` | Click submit |
| `browser_snapshot` | Verify logged in state |
| `browser_run_code` | Load/save storageState |

### 5.2 Check storageState via browser_run_code

If `.auth/` exists, we can load it:

```javascript
// Load saved auth state
browser_run_code({
  code: `async (page) => {
    const fs = require('fs');
    const state = JSON.parse(fs.readFileSync('.auth/user.json', 'utf8'));
    await page.context().addCookies(state.cookies || []);
    // localStorage needs page navigation first
    await page.goto('/');
    await page.evaluate((storage) => {
      for (const [key, value] of Object.entries(storage)) {
        localStorage.setItem(key, value);
      }
    }, state.origins?.[0]?.localStorage || {});
  }`
})
```

### 5.3 Configure Auth Fallback Chain

Store the fallback chain in config:

```json
{
  "auth": {
    "strategy": "storageState",
    "fallbackChain": [
      {
        "strategy": "storageState",
        "condition": ".auth/user.json exists and < 24h old"
      },
      {
        "strategy": "uiLogin",
        "condition": "storageState missing or expired"
      },
      {
        "strategy": "none",
        "condition": "no credentials available"
      }
    ]
  }
}
```

### 5.4 Check Quoth/Exolar Connectivity

```bash
# These are configured in .mcp.json
cat .mcp.json 2>/dev/null | grep -E "quoth|exolar"
```

Add to config:

```json
{
  "mcp": {
    "playwright": true,
    "quoth": true,
    "exolar": true,
    "linear": false
  }
}
```

---

## Step 6: Generate Configuration

Based on analysis, generate configuration files.

### 6.1 triqual.config.ts (Required)

Create at project root using the template from `${PLUGIN_ROOT}/context/config.template.ts`:

```typescript
import { defineConfig } from 'triqual';
// Uncomment if you have a test users file:
// import { testUsers } from '{credentialsFile}';

export default defineConfig({
  project_id: '{project-name-from-package.json}',
  testDir: '{detected-test-directory}',
  baseUrl: process.env.BASE_URL || '{detected-base-url}',
  playwrightConfig: '{path-to-playwright.config.ts}',

  auth: {
    strategy: '{detected-strategy}', // 'storageState' | 'uiLogin' | 'setupProject' | 'none'
    // ... auth config based on detection
  },

  context: {
    patternsFile: './Docs/context/patterns.json',
    selectorsFile: './Docs/context/selectors.json',
    projectFile: './Docs/context/project.json',
  },
});
```

**Example generated config:**

```typescript
import { defineConfig } from 'triqual';
import { testUsers } from './automation/shared/test-data/users';

export default defineConfig({
  project_id: 'my-project',
  testDir: './automation/playwright/tests',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  playwrightConfig: './playwright.config.ts',

  auth: {
    strategy: 'storageState',
    storageState: {
      path: '.auth/user.json',
    },
    uiLogin: {
      credentials: testUsers.standard,
      loginUrl: '/login',
      selectors: {
        email: '[data-testid="email"]',
        password: '[data-testid="password"]',
        submit: '[type="submit"]',
      },
      successUrl: '/dashboard',
    },
    users: {
      default: 'standard',
      available: testUsers,
    },
    fallbackChain: ['storageState', 'uiLogin', 'none'],
  },

  environments: {
    local: 'http://localhost:3000',
    staging: 'https://staging.example.com',
    production: 'https://app.example.com',
  },

  mcp: {
    playwright: true,
    quoth: true,
    exolar: true,
    linear: false,
  },

  patterns: {
    selectors: {
      prefer: 'data-testid',
      fallback: ['role', 'text'],
      testIdAttribute: 'data-testid',
    },
    timeout: {
      default: 30000,
      ci: 60000,
      local: 15000,
    },
    healing: {
      enabled: true,
      maxAttempts: 5,
    },
  },

  draftDir: './tests/.draft',

  context: {
    patternsFile: './Docs/context/patterns.json',
    selectorsFile: './Docs/context/selectors.json',
    projectFile: './Docs/context/project.json',
  },
});
```

### 6.2 Docs/context/project.json (Recommended)

```bash
mkdir -p Docs/context
```

Generate with detected paths:

```json
{
  "name": "{from-package.json}",
  "description": "{from-package.json-description}",
  "testDir": "{detected}",
  "pagesDir": "{detected-pages-directory}",
  "helpersDir": "{detected-helpers-directory}",
  "baseUrl": "{detected}",
  "environments": {
    "local": "http://localhost:3000",
    "staging": "{if-detected}",
    "production": "{if-detected}"
  },
  "auth": {
    "storageState": "{detected-auth-file}",
    "setupProject": "{detected-setup-project}"
  },
  "scripts": {
    "test": "{from-package.json}",
    "test:headed": "{detected-or-suggested}"
  }
}
```

### 6.3 Docs/context/patterns.json (Recommended)

Generate based on existing test analysis:

```json
{
  "timeout": {
    "default": "{detected-or-30000}",
    "ci": "{detected-or-60000}",
    "local": "{detected-or-15000}"
  },
  "retry": {
    "maxAttempts": "{detected-or-3}",
    "backoffMs": 1000
  },
  "selectors": {
    "preferDataTestId": "{detected-pattern}",
    "fallbackToRole": true,
    "antiPatterns": [
      "nth(0) without :visible",
      "complex XPath",
      "fragile CSS chains"
    ]
  },
  "assertions": {
    "defaultTimeout": "{detected-or-5000}",
    "preferSoftAssertions": false
  },
  "healing": {
    "enabled": true,
    "maxAttempts": 3,
    "strategies": ["visibility", "role-fallback", "text-content"]
  },
  "generation": {
    "includeComments": true,
    "usePageObjects": "{detected-if-exists}",
    "arrangeActAssert": true
  },
  "naming": {
    "testFiles": "{feature}.spec.ts",
    "pageObjects": "{Feature}Page.ts",
    "helpers": "{name}.helper.ts"
  }
}
```

### 6.4 Docs/context/selectors.json (If tests exist)

Only generate if existing tests were found. Extract actual patterns:

```json
{
  "strategy": {
    "priority": ["data-testid", "role", "text", "css"],
    "custom": {
      "testIdAttribute": "{detected-or-data-testid}"
    }
  },
  "components": {
    "button": {
      "primary": "{detected-pattern}",
      "secondary": "{detected-pattern}",
      "submit": "{detected-pattern}"
    },
    "input": {
      "text": "{detected-pattern}",
      "email": "{detected-pattern}",
      "password": "{detected-pattern}"
    },
    "modal": {
      "container": "{detected-pattern}",
      "close": "{detected-pattern}"
    }
  },
  "pages": {
    "{detected-page-1}": {
      "{element}": "{selector}"
    },
    "{detected-page-2}": {
      "{element}": "{selector}"
    }
  },
  "antiPatterns": [
    "{detected-bad-patterns}"
  ]
}
```

---

## Step 5: Initialize Playwright Agents

Playwright 1.56+ includes built-in agents for autonomous test generation. Initialize them for `/test` support.

### 5.1 Check Playwright Version

```bash
# Get Playwright version
npm list playwright @playwright/test 2>/dev/null | grep playwright
```

**Required**: Version 1.56 or higher for Agents support.

### 5.2 Check if Agents Already Initialized

```bash
# Look for agents directory
ls .agents/ 2>/dev/null
```

### 5.3 Initialize Agents (if needed)

```bash
# Initialize Playwright Agents with Claude Code loop
npx playwright init-agents --loop=claude
```

This creates:
- `.agents/` directory with agent definitions
- Customizable planner, generator, and healer agents

### 5.4 Locate Test Credentials

Find test user credentials for autonomous login:

```bash
# Common locations
find . -name "users.ts" -path "*test-data*" 2>/dev/null
find . -name "test-users.ts" 2>/dev/null
```

Store location in config for `/test` to use:

```json
{
  "autoTest": {
    "credentialsFile": "./automation/shared/test-data/users.ts",
    "draftDir": "./tests/.draft"
  }
}
```

---

## Step 7: Display Summary

After generating configuration, display a comprehensive summary:

```markdown
## Triqual Initialized Successfully

### Project Analysis

| Aspect | Detected |
|--------|----------|
| Project Name | {name} |
| Test Framework | Playwright {version} |
| Test Directory | {testDir} |
| Test Files Found | {count} |
| Page Objects | {count} |
| Base URL | {baseUrl} |

### Authentication Detection

| Aspect | Status |
|--------|--------|
| Strategy | {storageState / setupProject / uiLogin / none} |
| StorageState (.auth/) | {found: .auth/user.json / not found} |
| Auth Setup File | {auth.setup.ts / global-setup.ts / not found} |
| Credentials File | {path / not found} |
| Login Selectors | {detected / not detected} |

**Auth Strategy Explanation:**

- **storageState**: Found `.auth/user.json` - will load saved cookies/localStorage via Playwright MCP
- **setupProject**: Found `auth.setup.ts` - will run setup project before tests
- **uiLogin**: Found credentials but no saved state - will log in via UI using Playwright MCP
- **none**: No auth required or not detected

### Files Generated

| File | Purpose |
|------|---------|
| `triqual.config.ts` | Main configuration with TypeScript types |
| `Docs/context/project.json` | Project metadata |
| `Docs/context/patterns.json` | Test patterns & conventions |
| `Docs/context/selectors.json` | Locator strategies |

### Detected Patterns

- **Primary Selector Strategy**: {data-testid | role | text}
- **Timeout**: {default}ms (CI: {ci}ms)
- **Auth Method**: {strategy with details}

### MCP Capabilities

| MCP Server | Status | Used For |
|------------|--------|----------|
| Playwright MCP | {available} | Browser automation, auth loading |
| Quoth | {available / authenticate} | Pattern documentation |
| Exolar | {available / authenticate} | Test analytics |

### How /test Will Handle Authentication

Based on detection, `/test` will:

1. **If storageState available:**
   ```
   → Load .auth/user.json via browser_run_code
   → Skip login flow
   → Proceed directly to feature testing
   ```

2. **If uiLogin configured:**
   ```
   → Navigate to {loginUrl}
   → Fill credentials from {credentialsFile}
   → Click submit and wait for {successUrl}
   → Optionally save state for future runs
   ```

3. **If no auth:**
   ```
   → Proceed directly to feature testing
   ```

### Documented Learning Loop

Triqual enforces a documented learning loop for all test development:

```
ANALYZE → RESEARCH → PLAN → WRITE → RUN → LEARN
```

Each stage must be documented in run logs at `.triqual/runs/{feature}.md` before proceeding.

**Hooks enforce this by blocking actions until documentation is complete:**
- Cannot write test code without ANALYZE, RESEARCH, PLAN stages
- Cannot retry tests without documenting results
- Cannot exceed 2 same-category failures without external research (Quoth/Exolar)
- Cannot exceed 3 attempts without .fixme() or justification

### Directory Structure Created

```
.triqual/
├── runs/           # Run logs for each feature
│   └── {feature}.md  # Documents: analyze, research, plan, write, run, learn
└── knowledge.md    # Accumulated project-specific patterns
```

### Next Steps

1. **Review generated configs** - Adjust auth settings if needed
2. **Create your first run log** - Required before writing any test
3. **Verify auth works**: `/test --explore login` - Test the login flow
4. **Generate tests**: `/test dashboard` - Full autonomous test generation
5. **From tickets**: `/test --ticket ENG-123` - Generate from Linear

### MCP Servers

Triqual uses these MCP servers (authenticate when prompted):
- **Playwright MCP** - Browser automation (auto-installed)
- **Quoth** - Pattern documentation
- **Exolar** - Test analytics
```

---

## Interactive Mode (No Arguments)

When run without arguments, guide the user through any missing information:

1. **If no playwright.config found:**
   ```
   No Playwright config detected. Please specify:
   - Test directory path: [./tests]
   - Base URL: [http://localhost:3000]
   ```

2. **If multiple test directories found:**
   ```
   Multiple test directories detected:
   1. ./tests
   2. ./e2e
   3. ./automation/playwright/tests

   Which should Triqual use? [3]
   ```

3. **If no tests exist yet:**
   ```
   No existing tests found. Generating starter configuration.
   Use /test to create your first test.
   ```

---

## Force Regeneration

When `--force` is provided:

1. **Backup existing config:**
   ```bash
   cp triqual.config.ts triqual.config.ts.backup
   ```

2. **Re-run full analysis**

3. **Show diff of changes:**
   ```markdown
   ### Configuration Changes

   **triqual.config.ts**
   - testDir: './tests' → './automation/playwright/tests'
   - baseUrl: (unchanged)
   + New: context.patternsFile
   ```

---

## Configuration Templates

### Minimal Configuration (New Project)

```typescript
// triqual.config.ts
import { defineConfig } from 'triqual';

export default defineConfig({
  project_id: 'my-new-project',
  testDir: './tests',
  baseUrl: 'http://localhost:3000',
});
```

### Full Configuration (Existing Project)

```typescript
// triqual.config.ts
import { defineConfig } from 'triqual';
import { testUsers } from './automation/shared/test-data/users';

export default defineConfig({
  project_id: 'enterprise-app',
  testDir: './automation/playwright/tests',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  playwrightConfig: './playwright.config.ts',

  auth: {
    strategy: 'storageState',
    storageState: {
      path: '.auth/user.json',
    },
    uiLogin: {
      credentials: testUsers.standard,
      loginUrl: '/login',
      selectors: {
        email: '[data-testid="email"]',
        password: '[data-testid="password"]',
        submit: '[type="submit"]',
      },
      successUrl: '/dashboard',
    },
    users: {
      default: 'standard',
      available: testUsers,
    },
    fallbackChain: ['storageState', 'uiLogin', 'none'],
  },

  environments: {
    local: 'http://localhost:3000',
    staging: 'https://staging.example.com',
    production: 'https://app.example.com',
  },

  mcp: {
    playwright: true,
    quoth: true,
    exolar: true,
    linear: false,
  },

  patterns: {
    selectors: {
      prefer: 'data-testid',
      fallback: ['role', 'text'],
    },
    timeout: {
      default: 30000,
      ci: 60000,
      local: 15000,
    },
    healing: {
      enabled: true,
      maxAttempts: 5,
    },
  },

  draftDir: './tests/.draft',

  context: {
    patternsFile: './Docs/context/patterns.json',
    selectorsFile: './Docs/context/selectors.json',
    projectFile: './Docs/context/project.json',
  },
});
```

---

## What This Skill Does NOT Do

- **Run tests** - Use `/test` or `npx playwright test`
- **Generate test files** - Use `/test` or `/test --describe`
- **Heal failures** - That's the triqual-plugin:test-healer agent
- **Fetch tickets** - Use `/test --ticket ENG-123`

This skill is for **initial setup and configuration only**.

---

## Troubleshooting

### "Permission denied creating Docs/context"

```bash
mkdir -p Docs/context
chmod 755 Docs/context
```

### "playwright.config.ts not found"

Triqual can work without it. Specify paths manually in triqual.config.ts.

### "Tests in unexpected location"

Edit `triqual.config.ts` and set `testDir` to correct path.

### "Config seems wrong after regeneration"

Restore backup:
```bash
cp triqual.config.ts.backup triqual.config.ts
```

---

## Integration with Hooks

After init completes, Triqual hooks will:

1. **SessionStart** - Load generated configuration
2. **PreSpecWrite** - Use patterns.json for test generation
3. **PostTestRun** - Reference project.json for reporting
4. **Stop** - Include config in session summary

The configuration you generate here powers all other Triqual features.
