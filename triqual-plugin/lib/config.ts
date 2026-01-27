/**
 * Triqual Configuration Types
 *
 * Usage:
 * ```typescript
 * import { defineConfig } from 'triqual';
 * export default defineConfig({ ... });
 * ```
 */

export interface TriqualCredentials {
  email: string;
  password: string;
  name?: string;
}

export interface TriqualUsers {
  [key: string]: TriqualCredentials;
}

export interface StorageStateConfig {
  /** Path to storageState JSON file */
  path: string;
}

export interface UILoginConfig {
  /** Credentials to use for login (can import from users.ts) */
  credentials?: TriqualCredentials;
  /** Login page URL path */
  loginUrl: string;
  /** Selectors for login form elements */
  selectors: {
    email: string;
    password: string;
    submit: string;
  };
  /** URL to expect after successful login */
  successUrl: string;
}

export interface AuthConfig {
  /**
   * Authentication strategy:
   * - 'storageState': Load saved cookies/localStorage from .auth/
   * - 'uiLogin': Log in via UI using Playwright MCP
   * - 'setupProject': Run Playwright setup project first
   * - 'none': No authentication needed
   */
  strategy: 'storageState' | 'uiLogin' | 'setupProject' | 'none';

  /** StorageState configuration (when strategy is 'storageState') */
  storageState?: StorageStateConfig;

  /** UI login configuration (when strategy is 'uiLogin') */
  uiLogin?: UILoginConfig;

  /** Setup project name (when strategy is 'setupProject') */
  setupProject?: string;

  /** Available test users */
  users?: {
    /** Default user key to use */
    default: string;
    /** All available users (can import from users.ts) */
    available: TriqualUsers;
  };

  /** Fallback chain if primary strategy fails */
  fallbackChain?: Array<'storageState' | 'uiLogin' | 'none'>;
}

export interface EnvironmentsConfig {
  local?: string;
  staging?: string;
  production?: string;
  [key: string]: string | undefined;
}

export interface MCPConfig {
  /** Playwright MCP for browser automation */
  playwright?: boolean;
  /** Quoth MCP for pattern documentation */
  quoth?: boolean;
  /** Exolar MCP for test analytics */
  exolar?: boolean;
  /** Linear MCP for ticket integration */
  linear?: boolean;
}

export interface PatternsConfig {
  selectors?: {
    /** Preferred selector strategy */
    prefer: 'data-testid' | 'role' | 'text' | 'css';
    /** Fallback strategies in order */
    fallback?: Array<'data-testid' | 'role' | 'text' | 'css'>;
    /** Custom test ID attribute (default: 'data-testid') */
    testIdAttribute?: string;
  };
  timeout?: {
    /** Default timeout in ms */
    default: number;
    /** CI timeout in ms (usually higher) */
    ci?: number;
    /** Local timeout in ms (usually lower) */
    local?: number;
  };
  healing?: {
    /** Enable auto-healing in /test */
    enabled: boolean;
    /** Max heal attempts before giving up */
    maxAttempts: number;
  };
}

export interface TriqualConfig {
  /** Unique project identifier */
  project_id: string;

  /** Test directory path */
  testDir: string;

  /** Base URL for the application */
  baseUrl: string;

  /** Path to playwright.config.ts (optional) */
  playwrightConfig?: string;

  /** Authentication configuration */
  auth?: AuthConfig;

  /** Environment URLs */
  environments?: EnvironmentsConfig;

  /** MCP server configuration */
  mcp?: MCPConfig;

  /** Test patterns and conventions */
  patterns?: PatternsConfig;

  /** Draft directory for generated tests */
  draftDir?: string;

  /** Context file paths */
  context?: {
    patternsFile?: string;
    selectorsFile?: string;
    projectFile?: string;
  };
}

/**
 * Define Triqual configuration with type safety
 *
 * @example
 * ```typescript
 * import { defineConfig } from 'triqual';
 * import { testUsers } from './test-data/users';
 *
 * export default defineConfig({
 *   project_id: 'my-app',
 *   testDir: './tests',
 *   baseUrl: process.env.BASE_URL || 'http://localhost:3000',
 *   auth: {
 *     strategy: 'uiLogin',
 *     uiLogin: {
 *       credentials: testUsers.standard,
 *       loginUrl: '/login',
 *       selectors: {
 *         email: '[data-testid="email"]',
 *         password: '[data-testid="password"]',
 *         submit: '[type="submit"]',
 *       },
 *       successUrl: '/dashboard',
 *     },
 *   },
 * });
 * ```
 */
export function defineConfig(config: TriqualConfig): TriqualConfig {
  return config;
}

export default defineConfig;
