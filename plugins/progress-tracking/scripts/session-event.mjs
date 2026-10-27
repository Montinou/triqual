// Optional telemetry must never block or fail the agent that emitted the hook.
try {
  if (process.env.TRIQUAL_SESSIONS !== '0') {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const payload = JSON.parse(input);
    const [{ realpathSync }, { sep }, { homedir }, { readRegistry }, { storePaths }] = await Promise.all([
      import('node:fs'), import('node:path'), import('node:os'),
      import('../lib/registry.mjs'), import('../lib/store.mjs'),
    ]);
    const home = process.env.HOME || homedir();
    let cwd = payload.cwd;
    try { cwd = realpathSync(cwd); } catch { /* A vanished cwd still matches its registered ancestor. */ }
    if (typeof cwd === 'string') {
      const repo = readRegistry(home)
        .filter(({ root }) => cwd === root || cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
        .sort((a, b) => b.root.length - a.root.length)[0];
      const paths = repo && storePaths({ home, env: process.env });
      if (paths) {
        const { openSessions, record } = await import('../lib/sessions.mjs');
        const db = openSessions(paths.dataDir);
        try { record(db, payload, Date.now(), repo.root); } finally { db.close(); }
      }
    }
  }
} catch {
  // Recording is best effort, including malformed payloads and inaccessible stores.
}
