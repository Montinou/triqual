// Ledger files on disk: `<plansDir>/<plan name>.tasks.json`. Shared by `triqual tasks` and the hooks.
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { LedgerError, renderSection } from './ledger.mjs';

export const LEDGER_EXT = '.tasks.json';

export const entry = (path, ledger) => ({ path, name: basename(path, LEDGER_EXT), ledger });
// A LedgerError naming the ledger file; `reason` is the same text without the path (for warnings).
const unusable = (path, reason, message = `${path} ${reason}`) => Object.assign(new LedgerError(message), { reason });

// The ledger entry for a file's text; throws an `unusable` LedgerError when it is not JSON, not an object, or too
// malformed to render.
export function readEntry(path, text) {
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch {
    throw unusable(path, 'not valid JSON', `${path} is not valid JSON`);
  }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw unusable(path, 'not a ledger', `${path} is not a ledger`);
  }
  const l = entry(path, ledger);
  try {
    renderSection([l]);
  } catch (err) {
    throw unusable(path, `cannot be rendered: ${err.message}`);
  }
  return l;
}

// Every `*.tasks.json` path directly in plansDir, sorted; [] when the directory does not exist.
export function ledgerPaths(t) {
  if (!existsSync(t.plansDir)) return [];
  return readdirSync(t.plansDir).filter((f) => f.endsWith(LEDGER_EXT)).sort().map((f) => join(t.plansDir, f));
}
