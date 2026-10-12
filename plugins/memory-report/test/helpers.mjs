// Test helpers: every memory-report test runs against a temp HOME, never the real claude-mem or state directories.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from '../lib/config.mjs';

// Runs fn({ home, env, paths }) with HOME and the four MEMORY_REPORT_* variables pointing under a fresh temp dir,
// then removes it. `env` is a plain object for resolvePaths and for the CLI's `main`; nothing touches process.env.
export async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'memory-report-'));
  const env = {
    HOME: home,
    MEMORY_REPORT_CONFIG: join(home, 'cfg', 'memory-report.json'),
    MEMORY_REPORT_STATE_DIR: join(home, 'state'),
    MEMORY_REPORT_CLAUDE_MEM_DIR: join(home, 'claude-mem'),
    MEMORY_REPORT_CRASH_DIR: join(home, 'crash'),
  };
  try {
    return await fn({ home, env, paths: resolvePaths(env, home) });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// True when node:sqlite can be imported on this Node (22.16+ here); tests that need it skip themselves otherwise.
export async function canImportSqlite() {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

// A config whose insights gate is open: set up, the given allowlist and one client term. `over` replaces any key.
export const openConfig = (allowlist, over = {}) => ({ allowlist, clientTerms: ['acme'], setupAt: '2026-10-01T00:00:00.000Z', ...over });
