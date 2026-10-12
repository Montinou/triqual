#!/usr/bin/env node
// SessionStart entry point. A thin loader: the real work is in lib/hook.mjs, imported inside one try so that a broken
// install (missing or unparsable module) still exits 0 with no output instead of failing the session start.
try {
  const { sessionStart } = await import('../lib/hook.mjs');
  sessionStart();
} catch (err) {
  try {
    const [{ resolvePaths }, { appendLog }] = await Promise.all([import('../lib/config.mjs'), import('../lib/files.mjs')]);
    appendLog(resolvePaths(), 'hook', `error ${err instanceof Error ? err.message : String(err)}`);
  } catch { /* nothing more can be done */ }
}
process.exitCode = 0;
