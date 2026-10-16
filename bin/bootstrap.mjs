#!/usr/bin/env node
// The clone's entry point to the installer, which ships in the methodology plugin's
// plugins/methodology/setup/bootstrap.mjs: it re-exports that module and runs its main.
// Usage: node bin/bootstrap.mjs [--yes] [--keep-language] [--no-harness]. Exit 1 when any step failed, else 0.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main } from '../plugins/methodology/setup/bootstrap.mjs';

export * from '../plugins/methodology/setup/bootstrap.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
