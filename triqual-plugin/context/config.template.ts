/**
 * Triqual Configuration Template
 *
 * This template is used by /init to generate triqual.config.ts
 * Replace {placeholder} values with detected or user-provided values.
 */

import { defineConfig } from 'triqual';
// Uncomment if you have a test users file:
// import { testUsers } from '{credentialsFile}';

export default defineConfig({
  project_id: '{project_id}',
  testDir: '{testDir}',
  baseUrl: process.env.BASE_URL || '{baseUrl}',
  playwrightConfig: '{playwrightConfig}',

  auth: {
    strategy: '{auth.strategy}', // 'storageState' | 'uiLogin' | 'setupProject' | 'none'

    // Used when strategy is 'storageState'
    storageState: {
      path: '{auth.storageState.path}',
    },

    // Used when strategy is 'uiLogin'
    uiLogin: {
      // credentials: testUsers.standard, // Uncomment after importing testUsers
      loginUrl: '{auth.uiLogin.loginUrl}',
      selectors: {
        email: '{auth.uiLogin.selectors.email}',
        password: '{auth.uiLogin.selectors.password}',
        submit: '{auth.uiLogin.selectors.submit}',
      },
      successUrl: '{auth.uiLogin.successUrl}',
    },

    // Used when strategy is 'setupProject'
    setupProject: '{auth.setupProject}',

    users: {
      default: 'standard',
      available: {
        standard: {
          email: 'test@example.com',
          password: 'password',
          name: 'Test User',
        },
        // Add more users or import from testUsers
      },
    },

    fallbackChain: ['storageState', 'uiLogin', 'none'],
  },

  environments: {
    local: '{environments.local}',
    staging: '{environments.staging}',
    production: '{environments.production}',
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
