// Fake engine (test-only): dies from SIGKILL before it answers, as a crashed or OOM-killed
// engine would. The watchdog must turn the missing answer into a deny (spec, "Watchdog", step 5).
// Installed as versions/<semver>/src/engine.mjs by install-fake.mjs; imports only node: modules.

process.kill(process.pid, 'SIGKILL');
// SIGKILL to self is not catchable; keep the event loop alive until it lands.
setTimeout(() => {}, 60_000);
