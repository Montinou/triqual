// The construct names fence puts in an opaque result: the `construct` of {opaque: {reason, construct}}.
// `fence check` uses this list to warn about a name in a policy that fence never reports (a likely typo);
// a name here that fence stopped reporting costs a missed warning, a name missing costs a spurious one.
//
// Only literal names are listed. These are written as string literals at the sites that throw them
// (`new Opaque(reason, 'name', ...)`, the tokenizer's `unsupported('name')` / `unterminated('name')`,
// `{ reason, construct: 'name' }`, `opaque(reason, 'name')`, the parser's nesting names, the words in
// UNSUPPORTED_WORDS and ZSH_COMMAND_WORDS, and the host adapters' opaque reasons). Names built at run
// time are not literal and are not here: the text of the syntax token in a `syntax` error (`describe(t)`),
// the node type of an `internal` walk failure (`String(node.type)`), and an internal error's class name
// (`e.name`; its literal fallback `'error'` is listed). test/constructs.test.mjs scans src/ and keeps this list equal to the literals found there.

/** @type {readonly string[]} sorted, unique */
export const KNOWN_CONSTRUCTS = Object.freeze([
  '-',
  '[[',
  ']]',
  'agent-written-script',
  'alias',
  'ansi-c-quote',
  'append-assign',
  'arithmetic',
  'arithmetic-command',
  'arithmetic-for',
  'array-assign',
  'backtick',
  'brace-expansion',
  'case',
  'code-loading-var',
  'command',
  'command-substitution',
  'command-word',
  'coproc',
  'decode',
  'double-quote',
  'embedded-code',
  'error',
  'escape',
  'eval-dynamic',
  'for',
  'foreach',
  'foreign-shell',
  'function',
  'git-alias',
  'git-config-written',
  'git-hooks',
  'git-tree-update',
  'glob-command',
  'group',
  'heredoc',
  'heredoc-dynamic',
  'host-config-var',
  'if',
  'index-write',
  'input',
  'interp-code',
  'interp-flag',
  'keyword-assign',
  'locale-string',
  'makefile-inline',
  'malformed-command',
  'malformed-input',
  'malformed-patch',
  'malformed-payload',
  'malformed-workdir',
  'missing-command',
  'missing-cwd',
  'named-fd',
  'nested-script',
  'nested-shell',
  'node-flag',
  'nul',
  'package-option',
  'parameter',
  'parameter-expansion',
  'parse',
  'patch-unreadable',
  'process-substitution',
  'region-count',
  'reparse',
  'repeat',
  'script-path',
  'select',
  'shell-option',
  'single-quote',
  'stdin-interpreter',
  'subshell',
  'unknown-tool-input',
  'unparsed-apply-patch',
  'unreadable-call',
  'until',
  'unwrap',
  'walk',
  'while',
  'wrapper-flag',
  'write-stdin',
  'write-then-run',
  'zsh-syntax',
]);

const KNOWN = new Set(KNOWN_CONSTRUCTS);

/**
 * Whether fence reports `name` as a construct of an opaque result.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isKnownConstruct(name) {
  return typeof name === 'string' && KNOWN.has(name);
}
