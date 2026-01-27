---
name: triqual-init
description: Initialize Triqual for this project. Analyzes project structure, detects existing tests, and generates personalized configuration. Run on first use or after major project changes.
argument-hint: [--force]
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Triqual Init - Project Genesis

Configure Triqual for the current project by analyzing its structure and generating personalized configuration files.

## When to Use

- **First time using Triqual** in a project
- **After major project restructuring** (new test directories, different framework setup)
- **When onboarding a new team member** to ensure consistent configuration
- **After updating Triqual plugin** to regenerate configuration with new features

## Quick Start

```bash
/triqual-init                    # Interactive - analyzes and generates config
/triqual-init --force            # Regenerate even if config exists
```

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRIQUAL INIT PROCESS                        │
├─────────────────────────────────────────────────────────────────┤
│  1. CHECK EXISTING CONFIG                                       │
│     └── Skip if triqual.config.json exists (unless --force)     │
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
│  4. GENERATE CONFIGURATION                                      │
│     ├── triqual.config.json (root)                              │
│     └── Docs/context/ (optional detailed config)                │
│         ├── project.json                                        │
│         ├── patterns.json                                       │
│         └── selectors.json                                      │
│                                                                 │
│  5. DISPLAY SUMMARY                                             │
│     └── Show what was detected and generated                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 1: Check Existing Configuration

First, check if Triqual is already configured:

```bash
# Check for existing configuration files
ls triqual.config.json 2>/dev/null || ls triqual.config.ts 2>/dev/null || ls .triqual/config.json 2>/dev/null
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

## Step 4: Generate Configuration

Based on analysis, generate configuration files.

### 4.1 triqual.config.json (Required)

Create at project root:

```json
{
  "project_id": "{project-name-from-package.json}",
  "testDir": "{detected-test-directory}",
  "baseUrl": "{detected-base-url}",
  "playwrightConfig": "{path-to-playwright.config.ts}"
}
```

**Template with detected values:**

```json
{
  "project_id": "my-project",
  "testDir": "./automation/playwright/tests",
  "baseUrl": "http://localhost:3000",
  "playwrightConfig": "./playwright.config.ts",
  "context": {
    "patternsFile": "./Docs/context/patterns.json",
    "selectorsFile": "./Docs/context/selectors.json",
    "projectFile": "./Docs/context/project.json"
  }
}
```

### 4.2 Docs/context/project.json (Recommended)

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

### 4.3 Docs/context/patterns.json (Recommended)

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

### 4.4 Docs/context/selectors.json (If tests exist)

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

## Step 5: Display Summary

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

### Files Generated

| File | Purpose |
|------|---------|
| `triqual.config.json` | Main configuration |
| `Docs/context/project.json` | Project metadata |
| `Docs/context/patterns.json` | Test patterns & conventions |
| `Docs/context/selectors.json` | Locator strategies |

### Detected Patterns

- **Primary Selector Strategy**: {data-testid | role | text}
- **Timeout**: {default}ms (CI: {ci}ms)
- **Auth Setup**: {detected | none}

### Next Steps

1. **Review generated configs** - Adjust values if needed
2. **Run `/quick-test`** - Verify Triqual works with your project
3. **Try `/test-ticket`** - Generate tests from Linear tickets

### MCP Servers

Triqual uses these MCP servers (authenticate when prompted):
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
   Use /generate-test to create your first test.
   ```

---

## Force Regeneration

When `--force` is provided:

1. **Backup existing config:**
   ```bash
   cp triqual.config.json triqual.config.json.backup
   ```

2. **Re-run full analysis**

3. **Show diff of changes:**
   ```markdown
   ### Configuration Changes

   **triqual.config.json**
   - testDir: ./tests → ./automation/playwright/tests
   - baseUrl: (unchanged)
   + New: context.patternsFile
   ```

---

## Configuration Templates

### Minimal Configuration (New Project)

```json
// triqual.config.json
{
  "project_id": "my-new-project",
  "testDir": "./tests",
  "baseUrl": "http://localhost:3000"
}
```

### Full Configuration (Existing Project)

```json
// triqual.config.json
{
  "project_id": "enterprise-app",
  "testDir": "./automation/playwright/tests",
  "baseUrl": "http://localhost:3000",
  "playwrightConfig": "./playwright.config.ts",
  "context": {
    "patternsFile": "./Docs/context/patterns.json",
    "selectorsFile": "./Docs/context/selectors.json",
    "projectFile": "./Docs/context/project.json"
  },
  "mcp": {
    "quoth": true,
    "exolar": true
  }
}
```

---

## What This Skill Does NOT Do

- **Run tests** - Use `/quick-test` or `npx playwright test`
- **Generate test files** - Use `/generate-test`
- **Heal failures** - That's the test-healer agent
- **Fetch tickets** - Use `/test-ticket`

This skill is for **initial setup and configuration only**.

---

## Troubleshooting

### "Permission denied creating Docs/context"

```bash
mkdir -p Docs/context
chmod 755 Docs/context
```

### "playwright.config.ts not found"

Triqual can work without it. Specify paths manually in triqual.config.json.

### "Tests in unexpected location"

Edit `triqual.config.json` and set `testDir` to correct path.

### "Config seems wrong after regeneration"

Restore backup:
```bash
cp triqual.config.json.backup triqual.config.json
```

---

## Integration with Hooks

After init completes, Triqual hooks will:

1. **SessionStart** - Load generated configuration
2. **PreSpecWrite** - Use patterns.json for test generation
3. **PostTestRun** - Reference project.json for reporting
4. **Stop** - Include config in session summary

The configuration you generate here powers all other Triqual features.
