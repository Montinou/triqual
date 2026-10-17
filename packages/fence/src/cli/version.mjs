// The package version, read from the package's own package.json.

import fs from 'node:fs';

const PACKAGE_JSON = new URL('../../package.json', import.meta.url);

export function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return String(pkg.version);
}
