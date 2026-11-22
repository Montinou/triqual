// Objective grader for a replay run: checks that the model changed something outside setup, hidden tests and support
// files, restores the original hidden tests and support files, and runs the test command. node: built-ins only.
import { spawnSync } from 'node:child_process';
import { restoreFiles } from './eval-replay-git.mjs';
import { runShell } from './eval-replay-repos.mjs';

const GIT_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_SECONDS = 600;

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
}

// Grades a replay clone against its case. Returns { outcome: 'pass' | 'tests-failed' | 'no-change' | 'timeout' | 'setup-failed' }.
export function gradeRun({ repo, clone, kase, env, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }) {
  const hiddenTests = kase.hiddenTests ?? [];
  const supportFiles = kase.supportFiles ?? [];
  const setupPaths = (kase.setupPaths ?? []).map((p) => p.replace(/\/+$/, '')).filter(Boolean);
  const add = git(clone, ['add', '-A']);
  if (add.error || add.status !== 0) return { outcome: 'setup-failed' };
  const diff = git(clone, ['diff', '--cached', '--name-only', kase.base]);
  if (diff.error || diff.status !== 0) return { outcome: 'setup-failed' };
  const ignored = new Set([...setupPaths, ...hiddenTests, ...supportFiles]);
  const changed = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((path) => !ignored.has(path) && !setupPaths.some((p) => path.startsWith(`${p}/`)));
  if (changed.length === 0) return { outcome: 'no-change' };
  if (!restoreFiles(repo, kase.original, [...hiddenTests, ...supportFiles], clone)) {
    return { outcome: 'setup-failed' };
  }
  const command = kase.testCommand.replaceAll('{{WORK}}', clone);
  // A nested `node --test` under NODE_TEST_CONTEXT skips its test files and exits 0.
  const { NODE_TEST_CONTEXT: _, ...runEnv } = env ?? {};
  const r = runShell(clone, command, { timeoutSeconds, env: runEnv });
  if (r.timedOut) return { outcome: 'timeout' };
  return { outcome: r.ok ? 'pass' : 'tests-failed' };
}
