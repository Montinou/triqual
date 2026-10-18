#!/usr/bin/env node
const cliUrl = new URL('../src/cli/index.mjs', import.meta.url);

let cli;
try {
  cli = await import(cliUrl.href);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(cliUrl.pathname)) {
    console.error('fence: not yet implemented');
    process.exit(1);
  }
  throw error;
}

process.exitCode = await cli.main(process.argv.slice(2));
