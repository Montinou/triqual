# Context Configuration

Project-specific configuration overrides for Quolar Unified.

## Overview

The `context/` directory contains project-specific settings that customize how Quolar generates and heals tests. These files are optional - Quolar works with sensible defaults.

## Configuration Files

| File | Purpose |
|------|---------|
| `patterns.json` | Override standard test patterns |
| `selectors.json` | Project-specific locator preferences |
| `project.json` | Project metadata and paths |

## patterns.json

Override or extend standard Playwright patterns.

```json
{
  "timeout": {
    "default": 30000,
    "ci": 60000,
    "local": 15000
  },
  "retry": {
    "maxAttempts": 3,
    "backoffMs": 1000
  },
  "selectors": {
    "preferDataTestId": true,
    "fallbackToRole": true
  }
}
```

### Usage

Patterns from this file are applied when:
- `pre-spec-write` hook runs
- `test-healer` agent applies fixes
- `generate-test` skill creates tests

## selectors.json

Define project-specific locator strategies.

```json
{
  "components": {
    "button": {
      "primary": "[data-testid='primary-btn']",
      "secondary": "button.btn-secondary:visible"
    },
    "input": {
      "text": "input[type='text']:visible",
      "email": "[data-testid='email-input']"
    },
    "modal": {
      "container": "[role='dialog']",
      "close": "[data-testid='modal-close']"
    }
  },
  "pages": {
    "login": {
      "emailInput": "#email",
      "passwordInput": "#password",
      "submitButton": "[data-testid='login-submit']"
    },
    "dashboard": {
      "welcomeMessage": ".welcome-header",
      "navMenu": "[data-testid='nav-menu']"
    }
  }
}
```

### Usage

When generating tests or healing failures, Quolar checks this file for:
- Preferred selectors for common components
- Page-specific locators
- Fallback strategies

## project.json

Project metadata used by Quolar.

```json
{
  "name": "my-project",
  "testDir": "./automation/playwright/tests",
  "pagesDir": "./automation/playwright/tests/pages",
  "helpersDir": "./automation/playwright/tests/helpers",
  "baseUrl": "http://localhost:3000",
  "environments": {
    "local": "http://localhost:3000",
    "staging": "https://staging.example.com",
    "production": "https://example.com"
  },
  "auth": {
    "storageState": ".auth/user.json",
    "setupProject": "setup"
  }
}
```

## How Quolar Uses Context

### 1. Pre-Spec Write Hook

Before writing `.spec.ts` files:
1. Loads `patterns.json` for timeout and retry settings
2. Loads `selectors.json` for component locators
3. Applies project conventions to generated code

### 2. Test Healer Agent

When healing failures:
1. Checks `selectors.json` for better locator alternatives
2. Uses `patterns.json` for timeout adjustments
3. References `project.json` for file paths

### 3. Generate Test Skill

When creating new tests:
1. Uses `project.json` for output paths
2. Applies `patterns.json` conventions
3. Uses `selectors.json` for locator generation

## Creating Your Configuration

### Minimal Setup

Create just `project.json`:

```json
{
  "testDir": "./tests",
  "baseUrl": "http://localhost:3000"
}
```

### Full Setup

Copy all three template files and customize for your project.

## Precedence

Configuration is applied in this order (later overrides earlier):

1. **Defaults** - Built-in Quolar defaults
2. **Quoth Patterns** - Documented patterns from Quoth
3. **Context Files** - This directory's configuration

## Tips

- Keep `selectors.json` updated as UI changes
- Use `patterns.json` to standardize timeouts across team
- Set `project.json` paths to match your folder structure
