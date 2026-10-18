// Watchdog bundler (spec, "Watchdog" and "Layout"): writes `fence-hook` as one ESM file.
//
//   buildWatchdog({nodePath = process.execPath, deadlineMs?}) -> string
//     deadlineMs (module API only, for tests on loaded machines): the bundle's DEADLINE_MS instead
//     of the watchdog's 3000; omitted, the bundle is byte-for-byte the production one.
//   writeWatchdog(outFile, {nodePath}) -> void          (write-temp-then-rename, mode 0755)
//   node bundle-watchdog.mjs <out-file> [--node <absolute node path>]
//
// Line 1 is `#!<nodePath>`: the Node binary chosen at install, which then spawns the engine with
// process.execPath. src/watchdog.mjs is the entry; every module it imports by a relative path
// (hosts/render.mjs, watchdog/integrity.mjs, watchdog/line.mjs) is inlined as an IIFE returning its
// exports, and every `node:` import is hoisted once as a namespace import. Anything else (a package
// import, a side-effect or dynamic import, `require`, `export default`, `import.meta` in an inlined
// module, a cycle) throws, so the bundle cannot silently import more than node: modules.

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));
export const WATCHDOG_ENTRY = nodePath.join(SRC, 'watchdog.mjs');

const IMPORT_RE = /^import\s+([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+((?:async\s+)?function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
const IDENT = /^[A-Za-z_$][\w$]*$/;

const sanitize = (s) => s.replace(/[^\w$]/g, '_');

// `{ a, b as c }` -> "{ a, b: c }"
function destructure(list) {
  const names = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!m) throw new Error(`bundle-watchdog: cannot read the import binding ${JSON.stringify(item)}`);
      return m[2] ? `${m[1]}: ${m[2]}` : m[1];
    });
  return `{ ${names.join(', ')} }`;
}

// An import clause bound to `source` (a namespace variable) -> const declarations.
function bindClause(clause, source, hasDefault) {
  const out = [];
  let rest = clause.trim();
  const ns = rest.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (ns) return [`const ${ns[1]} = ${source};`];
  const def = rest.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*([\s\S]*))?$/);
  if (def && !rest.startsWith('{')) {
    if (!hasDefault) throw new Error(`bundle-watchdog: an inlined module has no default export (${def[1]})`);
    out.push(`const ${def[1]} = ${source}.default;`);
    rest = (def[2] ?? '').trim();
  }
  if (rest !== '') {
    const named = rest.match(/^\{([\s\S]*)\}$/);
    if (!named) throw new Error(`bundle-watchdog: cannot read the import clause ${JSON.stringify(clause)}`);
    out.push(`const ${destructure(named[1])} = ${source};`);
  }
  return out;
}

// The watchdog's deadline line; a `deadlineMs` given to buildWatchdog replaces its value.
const DEADLINE_LINE_RE = /^export const DEADLINE_MS = 3000;$/m;

export function buildWatchdog({ nodePath: node = process.execPath, deadlineMs } = {}) {
  if (typeof node !== 'string' || !node.startsWith('/') || /[\s\0]/.test(node)) {
    throw new Error('bundle-watchdog: the Node path must be absolute with no whitespace (it becomes the #! line)');
  }
  if (deadlineMs !== undefined && !(Number.isSafeInteger(deadlineMs) && deadlineMs > 0)) {
    throw new Error(`bundle-watchdog: the deadline must be a positive whole number of milliseconds, got ${String(deadlineMs)}`);
  }
  const builtins = new Map(); // "node:fs" -> namespace variable
  const modules = new Map(); // absolute file -> variable
  const visiting = new Set();
  const chunks = [];
  const taken = new Set();

  const builtinVar = (spec) => {
    if (!builtins.has(spec)) builtins.set(spec, `__fence_${sanitize(spec)}`);
    return builtins.get(spec);
  };

  // Rewrite a module's imports into const bindings; local modules are loaded (inlined) first.
  const rewriteImports = (file, source) => {
    const rewritten = source.replace(IMPORT_RE, (_all, clause, _q, spec) => {
      if (spec.startsWith('node:')) return bindClause(clause, builtinVar(spec), true).join('\n');
      if (spec.startsWith('./') || spec.startsWith('../')) return bindClause(clause, load(nodePath.resolve(nodePath.dirname(file), spec)), false).join('\n');
      throw new Error(`bundle-watchdog: ${nodePath.relative(SRC, file)} imports ${spec}, which is neither node: nor a local module`);
    });
    if (/^\s*import\b(?!\.meta|\s*\()/m.test(rewritten) || /\bimport\s*\(|\brequire\s*\(/.test(rewritten)) {
      throw new Error(`bundle-watchdog: ${nodePath.relative(SRC, file)} has an import the bundler cannot inline`);
    }
    return rewritten;
  };

  function load(file) {
    if (modules.has(file)) return modules.get(file);
    if (visiting.has(file)) throw new Error(`bundle-watchdog: import cycle through ${nodePath.relative(SRC, file)}`);
    visiting.add(file);
    let body = rewriteImports(file, nodeFs.readFileSync(file, 'utf8'));
    if (/^export\s+default\b/m.test(body)) throw new Error(`bundle-watchdog: ${nodePath.relative(SRC, file)} has a default export`);
    if (/\bimport\.meta\b/.test(body)) throw new Error(`bundle-watchdog: ${nodePath.relative(SRC, file)} uses import.meta and cannot be inlined`);
    const names = [];
    body = body.replace(EXPORT_DECL_RE, (_all, kind, name) => {
      names.push(name);
      return `${kind} ${name}`;
    });
    body = body.replace(EXPORT_LIST_RE, (_all, list) => {
      for (const item of list.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!m) throw new Error(`bundle-watchdog: cannot read the export ${JSON.stringify(item)}`);
        names.push(m[2] ? `${m[2]}: ${m[1]}` : m[1]);
      }
      return '';
    });
    if (/^export\b/m.test(body)) throw new Error(`bundle-watchdog: ${nodePath.relative(SRC, file)} has an export the bundler cannot read`);
    let name = `__fence_mod_${sanitize(nodePath.basename(file, '.mjs'))}`;
    while (taken.has(name)) name += '_';
    taken.add(name);
    const rel = nodePath.relative(SRC, file).split(nodePath.sep).join('/');
    chunks.push(`// ---- inlined: src/${rel}\nconst ${name} = (() => {\n${body.trimEnd()}\nreturn Object.freeze({ ${names.join(', ')} });\n})();\n`);
    visiting.delete(file);
    modules.set(file, name);
    return name;
  }

  let entry = rewriteImports(WATCHDOG_ENTRY, nodeFs.readFileSync(WATCHDOG_ENTRY, 'utf8'));
  if (deadlineMs !== undefined) {
    if (!DEADLINE_LINE_RE.test(entry)) throw new Error('bundle-watchdog: the watchdog has no DEADLINE_MS line to set the deadline on');
    entry = entry.replace(DEADLINE_LINE_RE, `export const DEADLINE_MS = ${deadlineMs};`);
  }
  for (const v of builtins.values()) if (!IDENT.test(v)) throw new Error(`bundle-watchdog: bad identifier ${v}`);
  const hoisted = [...builtins].map(([spec, v]) => `import * as ${v} from '${spec}';`).join('\n');
  return [
    `#!${node}`,
    '// fence-hook: generated at install by packages/fence/src/build/bundle-watchdog.mjs from the fence sources. Do not edit.',
    hoisted,
    '',
    ...chunks,
    '// ---- entry: src/watchdog.mjs',
    entry,
  ].join('\n');
}

export function writeWatchdog(outFile, { nodePath: node = process.execPath } = {}) {
  const text = buildWatchdog({ nodePath: node });
  const target = nodePath.resolve(outFile);
  nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  nodeFs.writeFileSync(tmp, text, { mode: 0o755 });
  nodeFs.chmodSync(tmp, 0o755);
  nodeFs.renameSync(tmp, target);
}

function isMain() {
  try {
    return process.argv[1] !== undefined && nodeFs.realpathSync(process.argv[1]) === nodeFs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [out, flag, value] = process.argv.slice(2);
  if (!out || (flag !== undefined && (flag !== '--node' || !value))) {
    process.stderr.write('usage: node bundle-watchdog.mjs <out-file> [--node <absolute node path>]\n');
    process.exit(2);
  }
  writeWatchdog(out, { nodePath: value ?? process.execPath });
}
