// Secret redaction for decision-log entries (spec, "Decision log, redaction, written-files index").
//
//   redact(entry) -> a new entry, every string in it redacted; the input is never changed.
//
// Runs before any log write, on every string field including `raw`. What it redacts, with the replacement `[redacted]`:
//   - inline env assignment values: any `NAME=value` word in a string (start of text, after whitespace or a shell
//     operator; not `--flag=value`), quotes and backslash escapes honoured; the values of an `env` object too;
//   - argv values after `-H`/`--header` with Authorization, Cookie or X-Api-Key, after `--token`, `--password`,
//     `--secret`, `--api-key` (separate or `=` form), and `-p<value>` of mysql-style clients;
//   - the password of `user:pass@` in a URL (the rest of the URL stays readable);
//   - inside an object with an `argv`, every argv value redacted above is also scrubbed from the object's other strings
//     (reads, writes, ops, domains, cwd), where the normalizer resolved it as a path;
//   - a PEM block through its END line;
//   - anything matching SECRET_PATTERNS.
// UNKNOWN markers, numbers, booleans and null pass through unchanged. No imports: the log code runs inside the engine.

// A copy of SECRET_PATTERNS from plugins/memory-report/lib/policy.mjs, the source the content gate uses. Fence does not
// import triqual; test/redact-drift.test.mjs fails when the two differ (source and flags).
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_\w{20,}/,
  /xox[abpr]-[\w-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN/,
  /Bearer\s+[A-Za-z0-9._~+/-]{25,}/,
  /:\/\/[^/\s:@]+:[^/\s:@]+@/,
  // The key may be quoted, and `facts` is stored JSON text, so its quotes arrive backslash-escaped: `\"` counts as a quote.
  /(password|passwd|secret|api[_-]?key|token)(?:\\?["'])?\s*(?:=>|[:=])\s*["']?\S{12,}/i,
  /vck_[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  // A bare Stripe-style key (secret, restricted or publishable; live or test), as it appears outside a `key = value` line.
  /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/,
];

export const REDACTED = '[redacted]';
const DEPTH_MARKER = '[redacted-depth]';

// Global copies: replace() needs the flag, the exported patterns stay stateless.
const GLOBAL_PATTERNS = SECRET_PATTERNS.map((p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`));
// A URL password this module already redacted: pattern 9 would otherwise swallow the host's scheme separator and `@`.
const URL_REDACTED_SHAPE = /^:\/\/[^/\s:@]+:\[redacted\]@$/;

// A PEM block through its END line (or the end of the text). Built from pieces: the literal marker is the content gate's
// secret pattern and is allowed in this file only on the SECRET_PATTERNS line.
const PEM_BLOCK = new RegExp('-----' + 'BEGIN[\\s\\S]*?(?:-----END[^-]*-----|$)', 'g');

// One shell word value: backslash escapes, double and single quoted parts (an unterminated quote runs to the end), and plain
// characters up to whitespace or an operator. Every alternative starts with a different character, so matching is linear.
const VALUE = String.raw`(?:\\[\s\S]|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\s;&|<>()` + '`' + String.raw`\\"'])+`;

const HEADER_NAMES = '(?:Authorization|Cookie|X-Api-Key)';
// `-H "Authorization: …"` (quoted: to the closing quote) and `-H Authorization:value` (unquoted: one word). One quantifier per
// character class, so a long run of spaces cannot make it quadratic.
const HEADER_IN_TEXT = new RegExp(
  `(^|\\s)(-H|--header)([=\\s]*)(?:(["'])(${HEADER_NAMES})(\\s*:\\s*)([^"']*)|(${HEADER_NAMES})(\\s*:)(?!\\s*\\[redacted\\])(\\S*))`,
  'gi',
);
// An argv element that is a header value of those names, and an attached `-HName: …` / `--header=Name: …` element.
const HEADER_VALUE = new RegExp(`^\\s*(${HEADER_NAMES})\\s*:`, 'i');
const HEADER_ATTACHED = new RegExp(`^(-H|--header=)\\s*(${HEADER_NAMES})\\s*:`, 'i');

const SECRET_FLAG = /^--(?:token|password|secret|api[-_]key)$/;
const SECRET_FLAG_VALUE = /^(--(?:token|password|secret|api[-_]key)=)([\s\S]*)$/;
const SECRET_FLAG_IN_TEXT = new RegExp(String.raw`(^|\s)(--(?:token|password|secret|api[-_]key))(=|\s+)(${VALUE})`, 'g');

// mysql-style clients: `-p<value>` is a password there and a harmless flag elsewhere (`cp -p`, `find -perm`).
const CLIENT_PROGRAM = /^(?:mysql[\w-]*|mariadb[\w-]*|mycli)$/;
const CLIENT_IN_TEXT = /(^|[\s;&|(/])((?:mysql[\w-]*|mariadb[\w-]*|mycli)\b)([^;&|\n]*)/g;
const CLIENT_P_ARG = new RegExp(String.raw`(^|\s)-p(?!-)(${VALUE})`, 'g');

// `NAME=value` at the start of a word: the start of the text, after whitespace, one of ; & | ( ) { } ! or a backtick. A
// `--flag=value` has a `-` before the name and is not one.
const ASSIGNMENT = new RegExp(String.raw`(^|[\s;&|(){}!` + '`' + String.raw`])([A-Za-z_][A-Za-z0-9_]*\+?=)(${VALUE})`, 'g');

// A URL's credentials (user, then password, then the at sign): the user may be empty and the password may hold ':'.
const URL_CREDENTIAL = /(:\/\/[^/\s:@]*:)([^/\s]+)(@)/g;

// The value as a path component would hold it: with quotes and backslash escapes removed.
const plain = (v) => v.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\\([\s\S])/g, '$1');

// `sink` (a Set or null) collects every secret value replaced, for the path scrub.
function redactString(text, sink = null) {
  const found = (v) => {
    if (sink === null || typeof v !== 'string' || v === '' || v === REDACTED) return;
    sink.add(v);
    sink.add(plain(v));
  };
  let s = text;
  s = s.replace(PEM_BLOCK, (m) => (found(m), REDACTED));
  s = s.replace(HEADER_IN_TEXT, (m, lead, flag, sep, quote, name, colon, quoted, bareName, bareColon, bare) => {
    if (quote === undefined) {
      found(bare);
      return `${lead}${flag}${sep}${bareName}${bareColon}${REDACTED}`;
    }
    found(quoted);
    return `${lead}${flag}${sep}${quote}${name}${colon}${REDACTED}`;
  });
  s = s.replace(SECRET_FLAG_IN_TEXT, (m, lead, flag, sep, value) => (found(value), `${lead}${flag}${sep}${REDACTED}`));
  s = s.replace(CLIENT_IN_TEXT, (m, lead, program, tail) => `${lead}${program}${tail.replace(CLIENT_P_ARG, (mm, pre, value) => (found(value), `${pre}-p${REDACTED}`))}`);
  s = s.replace(URL_CREDENTIAL, (m, head, password, at) => (found(password), `${head}${REDACTED}${at}`));
  s = s.replace(ASSIGNMENT, (m, lead, name, value) => (found(value), `${lead}${name}${REDACTED}`));
  for (const pattern of GLOBAL_PATTERNS) {
    s = s.replace(pattern, (m) => (URL_REDACTED_SHAPE.test(m) ? m : (found(m), REDACTED)));
  }
  return s;
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

// An argv array: flags pair with the element after them, so this works on the elements, then each goes through
// redactString for the patterns that need no context. `sink` collects the redacted values.
function redactArgv(argv, depth, sink) {
  const program = typeof argv[0] === 'string' ? baseName(argv[0]) : '';
  const client = CLIENT_PROGRAM.test(program);
  const found = (v) => {
    if (typeof v === 'string' && v !== '' && v !== REDACTED) {
      sink.add(v);
      sink.add(plain(v));
    }
  };
  // `Name: value` -> `Name: [redacted]`, the value (after the colon, trimmed) is the secret.
  const header = (v, name) => {
    const rest = v.slice(v.indexOf(':') + 1).trim();
    found(rest);
    return `${name}: ${REDACTED}`;
  };
  return argv.map((element, i) => {
    if (typeof element !== 'string') return walk(element, undefined, depth + 1, null);
    const prev = argv[i - 1];
    let v = element;
    let m;
    if (typeof prev === 'string' && (prev === '-H' || prev === '--header') && (m = HEADER_VALUE.exec(v)) !== null) {
      v = header(v, m[1]);
    } else if (typeof prev === 'string' && SECRET_FLAG.test(prev)) {
      found(v);
      v = REDACTED;
    } else if ((m = HEADER_ATTACHED.exec(v)) !== null) {
      v = `${m[1]}${header(v, m[2])}`;
    } else if ((m = SECRET_FLAG_VALUE.exec(v)) !== null) {
      found(m[2]);
      v = `${m[1]}${REDACTED}`;
    } else if (client && v.length > 2 && v.startsWith('-p') && !v.startsWith('--')) {
      found(v.slice(2));
      v = `-p${REDACTED}`;
    }
    return redactString(v, sink);
  });
}

// Replace every secret in `text`, outside the `[redacted]` markers already in it (a short secret must not eat the marker).
function scrub(text, secrets) {
  if (secrets === null || secrets.length === 0) return text;
  const any = new RegExp(secrets.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.split(REDACTED).map((piece) => piece.replace(any, REDACTED)).join(REDACTED);
}

// The fields where the normalizer resolves argv values into paths and hosts: the secret scrub applies there only (a short
// secret would otherwise eat letters of `raw` and `cwd`, which have their own rules).
const PATH_KEYS = new Set(['reads', 'writes', 'ops', 'domains']);
const MAX_DEPTH = 64;
const isPlainObject = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
// UNKNOWN is the normalizer's frozen marker, compared by identity elsewhere: it is returned as it is. Its module is not
// imported (the engine's log code stays dependency-free), so it is recognised by its shape and frozen state.
const isMarker = (v) => Object.isFrozen(v) && Object.keys(v).length === 1 && v.unknown === true;

// `secrets`: the argv secrets of the enclosing command object (or null), scrubbed from every string below it.
// The containers being walked now (the path from the root): meeting one again is a cycle. A depth cap alone would still let
// two cyclic references fan out exponentially.
const active = new Set();

function walk(value, key, depth, secrets) {
  if (typeof value === 'string') return scrub(redactString(value), secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH || active.has(value)) return DEPTH_MARKER;
  active.add(value);
  try {
    return walkContainer(value, key, depth, secrets);
  } finally {
    active.delete(value);
  }
}

function walkContainer(value, key, depth, secrets) {
  if (Array.isArray(value)) {
    if (key === 'argv') return redactArgv(value, depth, new Set());
    return value.map((el) => walk(el, undefined, depth + 1, secrets));
  }
  if (!isPlainObject(value) || isMarker(value)) return value;
  let here = secrets;
  let argvOut = null;
  if (Array.isArray(value.argv)) {
    const sink = new Set();
    argvOut = redactArgv(value.argv, depth, sink);
    const all = new Set([...(secrets ?? []), ...sink]);
    all.delete(REDACTED);
    here = [...all].sort((a, b) => b.length - a.length);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'argv' && argvOut !== null) out[k] = argvOut;
    else if (k === 'env' && isPlainObject(v) && !isMarker(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([name, val]) => [name, typeof val === 'string' ? REDACTED : val]));
    } else {
      out[k] = walk(v, k, depth + 1, PATH_KEYS.has(k) ? here : secrets);
    }
  }
  return out;
}

export function redact(entry) {
  return walk(entry, undefined, 0, null);
}
