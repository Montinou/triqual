import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_CONSTRUCTS, isKnownConstruct } from '../src/norm/constructs.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out.sort();
}

function matches(text, re, group = 1) {
  const names = [];
  for (const m of text.matchAll(re)) for (let g = group; g < m.length; g++) if (m[g] !== undefined) names.push(m[g]);
  return names;
}

// Every construct name written as a string literal in the source, keyed by where it was found.
function scan() {
  const found = new Map();
  const add = (name, file) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(file);
  };
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split(sep).join('/');
    if (file === 'norm/constructs.mjs') continue; // the list itself (its comment shows the call shapes)
    const text = readFileSync(path, 'utf8');
    const names = [
      // new Opaque('<reason>', '<construct>', ...)
      // (the reason may be an expression, as in `new Opaque(op.opaque.reason, 'host-config-var', ...)`)
      ...matches(text, /new Opaque\([^,]+,\s*'([^']+)'/g),
      // a construct chosen by a ternary: new Opaque('unsupported', cond ? '<construct>' : construct, off)
      ...matches(text, /new Opaque\([^,]+,[^?\n]+\?\s*'([^']+)'\s*:\s*construct\b/g),
      // the fallback name of an internal error: construct: (e && e.name) || '<literal>'
      ...matches(text, /\bconstruct:\s*\([^)]*\)\s*\|\|\s*'([^']+)'/g),
      // tokenizer helpers: this.unsupported('<construct>', i), this.unterminated(...)
      ...matches(text, /\.(?:unsupported|unterminated)\(\s*'([^']+)'/g),
      // { reason: '...', construct: '<literal>' }
      ...matches(text, /\bconstruct:\s*'([^']+)'/g),
      // opaque('<reason>', '<construct>') and feedError(...); the policy loader's fail(kind, message) is not a construct
      ...matches(text, /\b(?:opaque|feedError)\(\s*'[^']*'\s*,\s*'([^']+)'/g),
      // scriptOpaque('<construct>', S), assignOpaque('<construct>', name, off)
      ...matches(text, /\b(?:scriptOpaque|assignOpaque)\(\s*'([^']+)'/g),
      // parser nesting: enter('<c>', off), missing(t, '<c>', off), expectWord('<w>', '<c>', off), parseDoBody(open, '<c>')
      ...matches(text, /\.enter\(\s*'([^']+)'/g),
      ...matches(text, /\.missing\(\s*\w+\s*,\s*'([^']+)'/g),
      ...matches(text, /\.expectWord\(\s*'[^']*'\s*,\s*'([^']+)'/g),
      ...matches(text, /\.parseDoBody\(\s*\w+\s*,\s*'([^']+)'/g),
      ...matches(text, /\bconstruct = [^?\n]+\?\s*'([^']+)'\s*:\s*'([^']+)'/g),
      // word tables whose words become the construct
      ...matches(text, /\b(?:UNSUPPORTED_WORDS|ZSH_COMMAND_WORDS) = new Set\(\[(.*?)\]\)/g).flatMap((list) =>
        matches(list, /'([^']+)'/g),
      ),
    ];
    // normalize.mjs has a local fail(reason, construct) for nested scripts
    if (file === 'norm/normalize.mjs') names.push(...matches(text, /\bfail\(\s*'[^']*'\s*,\s*'([^']+)'/g));
    // host adapters: opaque('<reason>') and the tool table's `opaque: '<reason>'`; the reason is the construct
    if (file.startsWith('hosts/')) {
      names.push(...matches(text, /\bopaque\(\s*'([^']+)'\s*[,)]/g));
      names.push(...matches(text, /\bopaque:\s*'([^']+)'/g));
    }
    // the engine's adapter reasons
    if (file === 'engine.mjs') {
      const block = text.slice(text.indexOf('const ADAPTER_OPAQUE'), text.indexOf('});', text.indexOf('const ADAPTER_OPAQUE')));
      names.push(...matches(block, /^\s*'([a-z-]+)':/gm));
      names.push(...matches(text, /: '(unreadable-call)'/g));
    }
    for (const n of names) add(n, file);
  }
  return found;
}

test('the list is sorted, unique, frozen and made of strings', () => {
  assert.ok(Array.isArray(KNOWN_CONSTRUCTS));
  assert.ok(Object.isFrozen(KNOWN_CONSTRUCTS));
  assert.ok(KNOWN_CONSTRUCTS.every((c) => typeof c === 'string' && c !== ''));
  assert.deepEqual([...KNOWN_CONSTRUCTS], [...new Set(KNOWN_CONSTRUCTS)].sort());
});

test('host-config-var, code-loading-var and process-substitution are known', () => {
  for (const name of ['host-config-var', 'code-loading-var', 'process-substitution']) {
    assert.ok(isKnownConstruct(name), name);
    assert.ok(KNOWN_CONSTRUCTS.includes(name), name);
  }
});

test('isKnownConstruct is false for unknown names and for non-strings', () => {
  assert.equal(isKnownConstruct('no-such-construct'), false);
  assert.equal(isKnownConstruct(''), false);
  assert.equal(isKnownConstruct(undefined), false);
  assert.equal(isKnownConstruct(null), false);
  assert.equal(isKnownConstruct(7), false);
  assert.equal(isKnownConstruct('toString'), false);
  assert.equal(isKnownConstruct('__proto__'), false);
});

test('the scan finds a realistic number of construct sites', () => {
  const found = scan();
  assert.ok(found.size >= 60, `only ${found.size} names found; a pattern stopped matching`);
  for (const name of ['process-substitution', 'heredoc', 'zsh-syntax', 'function', 'repeat', 'array-assign', 'stdin-interpreter', 'embedded-code', 'malformed-payload', 'while', 'select', '[[', ']]', 'error', 'host-config-var'])
    assert.ok(found.has(name), `the scan missed ${name}`);
});

test('every literal construct thrown in src is in KNOWN_CONSTRUCTS', () => {
  const missing = [];
  for (const [name, files] of scan()) if (!isKnownConstruct(name)) missing.push(`${name} (${[...files].join(', ')})`);
  assert.deepEqual(missing, []);
});

test('every name in KNOWN_CONSTRUCTS is thrown somewhere in src', () => {
  const found = scan();
  assert.deepEqual(
    KNOWN_CONSTRUCTS.filter((c) => !found.has(c)),
    [],
  );
});
