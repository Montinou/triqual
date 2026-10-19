// Fake engine (test-only): never answers within the watchdog's budget. It sleeps far past any
// deadline (30 s), so the watchdog must kill it and deny (spec, "Watchdog": one deadline, then deny).
// Its pid goes to <state-dir>/fake-sleep.pid (the state directory the watchdog passes as
// `--state-dir`), so a test can check that no engine process outlives the call.
// Installed as versions/<semver>/src/engine.mjs by install-fake.mjs; imports only node: modules.

import fs from 'node:fs';
import path from 'node:path';

const SLEEP_MS = 30_000;
const i = process.argv.indexOf('--state-dir');
const stateDir = i === -1 ? undefined : process.argv[i + 1];
if (typeof stateDir === 'string' && path.isAbsolute(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'fake-sleep.pid'), String(process.pid));
}
setTimeout(() => {}, SLEEP_MS);
