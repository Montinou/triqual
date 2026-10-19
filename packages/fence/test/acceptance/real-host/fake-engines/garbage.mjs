// Fake engine (test-only): exits 0 but prints something that is not a decision. The watchdog accepts
// only exit 0 with one well-formed canonical decision on stdout, so this must be a deny
// (spec, "Watchdog", step 5).
// Installed as versions/<semver>/src/engine.mjs by install-fake.mjs; imports only node: modules.

process.stdout.write('this is not a decision\n');
