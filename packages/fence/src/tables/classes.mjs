// Command class tables and the file and network effects of a command line (spec, "Normalizer":
// Command classes, Domains for network-fetch, and the "Unmodeled program" bullet of built-in
// self-protection).
//
//   classesOf(argv)         class names (policy/classes.mjs order) the command carries
//   fileEffects(argv, ctx)  {reads, writes}: resolved absolute paths, or UNKNOWN
//   domainsOf(argv)         network hosts the command talks to: lower case, port and userinfo
//                           removed; UNKNOWN for anything that cannot be named with certainty
//   hostToDomain(host)      the host parse itself (the normalizer also uses it for /dev/tcp)
//   extraOps(argv)          {path, op}[] ancestor operations beyond ops.mjs's rm/mv/chmod/ln
//   writesNothing(argv)     true when the invocation cannot write, delete, overwrite or change
//                           permissions (a cd after it stays certain)
//   READ_ONLY_PROGRAMS      programs whose operands are read and never written (names)
//
// argv is the command AFTER wrapper unwrapping (T15 strips sudo, env, timeout, xargs, ...); each
// element is a string or UNKNOWN. A wrapper still named in argv carries only its own class
// (sudo -> privilege). Two exceptions, because the answer is cheap and a miss is a bypass: `env`
// and `find -exec/-ok` also report the classes of the command they run.
//
// The design is data plus small predicates. Each program is a def() row: its option grammar
// (`short` letters and `long` names that take a value), `classes(p, call)`, `domains(p, out,
// call)`, `fx(p, io, call)` and `ops(call, p)`. A program with no `fx` is "unmodeled" for file
// effects unless it is listed in NO_FILE_PROGRAMS. The bias everywhere is toward MORE classes and
// MORE paths: a missing class or path is a bypass, an extra one is a question for the policy.
//
// - The program name matches by basename (`/bin/rm` is `rm`), exactly first and then in lower
//   case (a case-insensitive volume runs `RM` as `rm`); flags are case-sensitive. GNU-prefixed
//   coreutils (`grm`) and busybox/toybox applets are the program they name.
// - Flags may be clustered (`-rf`), carry an attached value (`-oFILE`), or be long options with
//   `=` or a separate value; an unambiguous long-option prefix counts (`--del`). For the tools
//   that write, a dash word after an operand is also an operand (BSD stops option parsing there).
// - A standalone UNKNOWN word may be a flag: the command gets every class its flags could give
//   it. An UNKNOWN program name is opaque upstream; defensively it carries every class.

import { UNKNOWN } from '../norm/unknown.mjs';
import { CLASS_NAMES } from '../policy/classes.mjs';
import { valueFlags } from './wrappers.mjs';

const isStr = (w) => typeof w === 'string';
const words = (s) => s.split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------------------------
// Data

const GNU_COREUTILS = new Set(
  words(
    'rm rmdir unlink shred mv cp ln chmod chown chgrp truncate dd tee install ls cat head tail wc sort uniq cut tr base64 touch mkdir mkfifo mknod mktemp env printenv stat du df nl tac od paste join comm fold fmt expand unexpand md5sum sha1sum sha256sum sha512sum cksum sum readlink realpath date sleep echo printf find xargs sed tar grep egrep fgrep',
  ),
);

const DELETERS = 'rm rmdir unlink srm trash trash-put rip';
const PRIVILEGE = 'sudo sudoedit doas su pkexec run0 gosu su-exec runuser';
const ZERO_SOURCES = /^\/dev\/(?:null|zero|full|u?random)$/;
const OVERWRITERS = 'wipefs blkdiscard mkswap fdisk sfdisk sgdisk parted';

// Network programs and how their host is found: 'first' = the first operand, 'all' = every
// operand, 'urls' = every operand is a URL, 'none' = not knowable (UNKNOWN).
const NETWORK_HOSTS = {
  first: 'ftp tftp lftp mosh rlogin rsh nmap ssh-copy-id',
  all: 'ping ping6 dig nslookup host drill whois traceroute traceroute6 tracepath mtr ssh-keyscan hping3 nping masscan',
  urls: 'aria2c aria2 axel http https xh xhs curlie lynx links w3m elinks fetch lwp-request GET POST HEAD yt-dlp youtube-dl gdown',
  none: 'rclone s3cmd aws gsutil gcloud az mail mailx sendmail msmtp mutt swaks autossh ngrok cloudflared tailscale',
};
const BROWSER_OPENERS = 'open xdg-open gnome-open sensible-browser x-www-browser www-browser';
const RR_TYPES = new Set(words('a aaaa mx txt ns soa any cname ptr srv caa ds dnskey axfr ixfr'));

// Package managers. `subs` install; they are looked for in the first two operands (an option may
// take a separate value: `npm --prefix dir install`) unless the first operand cannot be a global
// option value. `code` = lifecycle scripts run (spec: npm, yarn, pnpm install are also
// runs-repo-code). `pairs` are two-word sub-commands.
const NPM_INSTALL =
  'i in ins inst insta instal install isnt isnta isntal isntall add ci clean-install ic install-clean cit install-ci-test it install-test update up upgrade udpate link ln exec create rebuild rb dedupe ddp';
const PACKAGE_MANAGERS = {
  npm: { subs: NPM_INSTALL, code: true },
  yarn: { subs: 'add install upgrade up upgrade-interactive import dlx create global set link', code: true, bare: true },
  pnpm: { subs: 'add install i update up upgrade dlx create exec fetch import link rebuild dedupe', code: true },
  bun: { subs: 'install i add a update upgrade x create link', code: true },
  pip: { subs: 'install download wheel' },
  pipx: { subs: 'install inject upgrade upgrade-all run reinstall reinstall-all' },
  uv: { subs: 'add sync install', pairs: ['pip install', 'pip sync', 'tool install', 'tool run'] },
  poetry: { subs: 'add install update' },
  pipenv: { subs: 'install update sync' },
  conda: { subs: 'install create update' },
  mamba: { subs: 'install create update' },
  micromamba: { subs: 'install create update' },
  gem: { subs: 'install update' },
  bundle: { subs: 'install add update' },
  bundler: { subs: 'install add update' },
  cargo: { subs: 'install add fetch update' },
  go: { subs: 'install get', pairs: ['mod download'] },
  brew: { subs: 'install reinstall upgrade tap bundle' },
  apt: { subs: 'install reinstall upgrade dist-upgrade full-upgrade build-dep' },
  'apt-get': { subs: 'install reinstall upgrade dist-upgrade build-dep' },
  aptitude: { subs: 'install reinstall upgrade safe-upgrade full-upgrade' },
  dnf: { subs: 'install reinstall upgrade update localinstall groupinstall' },
  yum: { subs: 'install reinstall upgrade update localinstall groupinstall' },
  zypper: { subs: 'install in update up dist-upgrade' },
  apk: { subs: 'add upgrade' },
  snap: { subs: 'install refresh' },
  flatpak: { subs: 'install update' },
  composer: { subs: 'install require update' },
  dotnet: { subs: 'restore', pairs: ['add package'] },
  deno: { subs: 'install add' },
  pod: { subs: 'install update' },
  mix: { subs: 'deps.get' },
  nix: { subs: '', pairs: ['profile install', 'shell', 'run'] },
  'nix-env': { shortFlags: ['i'], longFlags: ['--install'] },
  npx: { always: true, code: true },
  pnpx: { always: true, code: true },
  bunx: { always: true, code: true },
  pacman: { shortFlags: ['S', 'U'] },
  dpkg: { shortFlags: ['i'], longFlags: ['--install'] },
  easy_install: { always: true },
};
// A first operand that is a sub-command with no install in it: the second operand is a script or
// a package name, not another sub-command (`npm run update`).
const NOT_INSTALL_FIRST = new Set(
  words('run run-script rum urn test t tst start stop restart view v info show ls list ll la outdated pack publish config c cache help version whoami login logout search docs bugs root prefix bin fund explain why doctor ping uninstall remove rm un unlink build check clippy fmt doc bench clean lint'),
);

// Words that are builtin or trivial and name no file.
const NO_FILE_PROGRAMS = new Set(
  words(
    'echo printf true false : pwd sleep uname whoami id hostname arch which type whereis basename dirname expr seq yes nproc groups tty uptime cal test [ [[ ] cd pushd popd eval source . alias unalias unset shift return exit break continue wait jobs fg bg kill trap ulimit umask hash getopts let local read printenv set export declare typeset readonly ps',
  ),
);

// ---------------------------------------------------------------------------------------------
// Program names

/** The program a word names: its basename, or null when the word is not a string. */
export function programOf(word) {
  if (!isStr(word)) return null;
  return word.slice(word.lastIndexOf('/') + 1);
}

const D = new Map();
function def(names, d) {
  for (const n of words(names)) D.set(n, d);
}

function canonName(name) {
  if (D.has(name)) return name;
  const lower = name.toLowerCase();
  if (D.has(lower)) return lower;
  if (lower.length > 1 && lower[0] === 'g' && GNU_COREUTILS.has(lower.slice(1)) && D.has(lower.slice(1))) return lower.slice(1);
  if (/^pythonw?[0-9.]*$/.test(lower)) return 'python';
  if (/^pip[0-9.]*$/.test(lower)) return 'pip';
  if (/^(?:mkfs|mke2fs|newfs)(?:\.[a-z0-9]+)?$/.test(lower)) return 'mkfs';
  if (/^nc\.(?:openbsd|traditional)$/.test(lower)) return 'nc';
  return lower;
}

// {name, argv} with busybox/toybox applets resolved, or null for an UNKNOWN program name.
function callOf(argv) {
  let a = argv;
  for (let depth = 0; depth < 3; depth++) {
    if (!isStr(a[0])) return null;
    const name = canonName(programOf(a[0]));
    if ((name === 'busybox' || name === 'toybox') && a.length > 1) {
      a = a.slice(1);
      continue;
    }
    return { name, argv: a };
  }
  return { name: 'busybox', argv: a };
}

// ---------------------------------------------------------------------------------------------
// Option parsing

const L = (names) => words(names).map((n) => `--${n}`);

// The value-taking options a long option word can be: itself when it is exact, otherwise every
// option it is a prefix of (GNU parsers accept any unambiguous prefix; an ambiguous one is read as
// all of them, so the effects are the union). The word itself when it matches none.
function longMatches(raw, longV, boolV) {
  if (longV.includes(raw)) return [raw];
  if (boolV && boolV.includes(raw)) return [raw]; // a known flag typed in full is that flag
  const all = longV.filter((l) => l.startsWith(raw));
  return all.length > 0 ? all : [raw];
}

class Parsed {
  constructor() {
    this.operands = [];
    this.flags = new Set();
    this.values = [];
    this.hasUnknown = false; // a standalone UNKNOWN word: a flag, a value or an operand
    this.unknownValue = false; // an UNKNOWN taken as the value of a known option
    this.endOpts = false;
    this.dashAt = -1; // index in operands of the first word after `--`
    this.ambiguous = false; // a long-option prefix that matched more than one value-taking option
    this.opArgv = []; // argv index of each operand
    this.afterOpt = new Set(); // operand indexes that directly follow an option that may take them as its value
  }

  has(...names) {
    return names.some((n) => this.flags.has(n));
  }

  /** A long option or any prefix of it (at least `min` letters): `--d` and `--del` for `--delete`. */
  longLike(name, min = 1) {
    for (const f of this.flags) {
      if (!f.startsWith('--')) continue;
      const b = f.slice(2);
      if (b === name || (b.length >= min && name.startsWith(b))) return true;
    }
    return false;
  }

  /** Any long option that starts with `prefix` (`--delete-after`). */
  longStarts(prefix) {
    for (const f of this.flags) if (f.startsWith(`--${prefix}`)) return true;
    return false;
  }

  vals(...names) {
    return this.values.filter((v) => names.includes(v.flag)).map((v) => v.value);
  }

  hasVal(...names) {
    return this.values.some((v) => names.includes(v.flag));
  }
}

/**
 * Parse argv[1..]. spec = {short, long, dual, operandDash}: `short` letters and `long` names take
 * a value; `dual` makes a dash word after an operand an operand too; `operandDash(word)` makes a
 * dash word an operand only (chmod modes).
 */
function parseArgs(argv, spec = {}) {
  const shortV = spec.short || '';
  const longV = spec.long || [];
  const boolS = spec.boolShort || '';
  const p = new Parsed();
  // An option that takes no value from the table but is not known to be a flag: the next word may
  // be its value. `pending` marks that the previous word was such an option.
  let pending = false;
  const operand = (w, i) => {
    if (pending) p.afterOpt.add(p.operands.length);
    p.opArgv.push(i);
    p.operands.push(w);
  };
  for (let i = 1; i < argv.length; i++) {
    let a = argv[i];
    // go and terraform spell every option with one dash (`-coverprofile=f`, `-out=f`): read as long
    if (spec.singleDash && isStr(a) && !p.endOpts && a.length >= 2 && a[0] === '-' && a[1] !== '-') a = `-${a}`;
    const wasPending = pending;
    pending = false;
    if (!isStr(a)) {
      p.hasUnknown = true;
      pending = wasPending;
      operand(UNKNOWN, i);
      pending = false;
      continue;
    }
    if (p.endOpts || a.length < 2 || a[0] !== '-') {
      pending = wasPending;
      operand(a, i);
      pending = false;
      continue;
    }
    if (a === '--') {
      p.endOpts = true;
      p.dashAt = p.operands.length;
      continue;
    }
    if (spec.operandDash && spec.operandDash(a)) {
      operand(a, i);
      if (a.includes('R') && !a.startsWith('--')) p.flags.add('R');
      continue;
    }
    if (spec.dual && p.operands.length > 0) operand(a, i);
    const takeValue = (flag) => {
      const v = argv[++i];
      if (v === undefined) return;
      if (!isStr(v)) {
        p.unknownValue = true;
        p.values.push({ flag, value: UNKNOWN });
      } else p.values.push({ flag, value: v });
    };
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const raw = eq < 0 ? a : a.slice(0, eq);
      const names = longMatches(raw, longV, spec.bool);
      for (const n of names) p.flags.add(n);
      p.flags.add(raw);
      if (names.length > 1) p.ambiguous = true;
      if (eq >= 0) for (const n of names) p.values.push({ flag: n, value: a.slice(eq + 1) });
      else {
        const takers = names.filter((n) => longV.includes(n));
        if (takers.length > 0) {
          const v = argv[++i];
          if (v !== undefined) {
            for (const n of takers) {
              if (isStr(v)) p.values.push({ flag: n, value: v });
              else {
                p.unknownValue = true;
                p.values.push({ flag: n, value: UNKNOWN });
              }
            }
            // an ambiguous abbreviation may also be a flag without a value: the word is then an operand
            if (names.length > 1) {
              pending = true;
              operand(isStr(v) ? v : UNKNOWN, i);
              pending = false;
            }
          }
        } else if (!(spec.bool && spec.bool.includes(raw))) pending = true;
      }
      continue;
    }
    // a short cluster: the first letter that is not a known flag takes the rest as its value, or the
    // next word when it is the last letter
    for (let k = 1; k < a.length; k++) {
      if (boolS.includes(a[k])) continue;
      // a non-letter (`-j4`) is an attached value, not an option letter
      if (/[A-Za-z]/.test(a[k]) && !shortV.includes(a[k]) && k === a.length - 1) pending = true;
      break;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      // `-o/tmp/out`, `-o=f`, `-o~/f`, `-o./f`: from a character that starts a path or an `=value`
      // on, the rest is an attached value, not letters. Other punctuation (`-#`, `-@`) is a flag letter.
      if (k > 1 && '/.=~'.includes(c)) break;
      p.flags.add(c);
      if (shortV.includes(c)) {
        const rest = a.slice(k + 1);
        if (rest !== '') p.values.push({ flag: c, value: rest });
        else takeValue(c);
        break;
      }
    }
  }
  return p;
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paths

// Segments of a word with `.` and empty segments dropped and `..` stepping back.
function lexicalSegments(word) {
  const out = [];
  for (const seg of word.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out;
}

const isZeroSource = (w) => isStr(w) && ZERO_SOURCES.test(`/${lexicalSegments(w).join('/')}`);

// Does a glob segment (`*`, `?`, `[..]`) match `text`? Iterative, O(pattern x text): a hostile
// word cannot make it backtrack.
function segmentMatches(seg, text) {
  if (!/[*?[]/.test(seg)) return seg === text;
  const toks = [];
  for (let i = 0; i < seg.length && toks.length < 512; i++) {
    const c = seg[i];
    if (c === '*') {
      if (toks.length === 0 || toks[toks.length - 1].t !== '*') toks.push({ t: '*' });
    } else if (c === '?') toks.push({ t: '?' });
    else if (c === '[') {
      const close = seg.indexOf(']', i + 2);
      if (close < 0) toks.push({ t: 'c', c });
      else {
        let set = seg.slice(i + 1, close);
        const neg = set[0] === '!' || set[0] === '^';
        if (neg) set = set.slice(1);
        toks.push({ t: '[', set, neg });
        i = close;
      }
    } else toks.push({ t: 'c', c });
  }
  const inClass = (set, ch) => {
    for (let i = 0; i < set.length; i++) {
      if (set[i + 1] === '-' && i + 2 < set.length) {
        if (ch >= set[i] && ch <= set[i + 2]) return true;
        i += 2;
      } else if (set[i] === ch) return true;
    }
    return false;
  };
  const one = (tok, ch) => (tok.t === '?' ? true : tok.t === 'c' ? tok.c === ch : inClass(tok.set, ch) !== tok.neg);
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (ti < text.length) {
    if (pi < toks.length && toks[pi].t === '*') {
      star = pi++;
      mark = ti;
    } else if (pi < toks.length && one(toks[pi], text[ti])) {
      pi++;
      ti++;
    } else if (star >= 0) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (pi < toks.length && toks[pi].t === '*') pi++;
  return pi === toks.length;
}

/** Does the path (a word or a resolved path) name /proc/<pid>/environ, however it is spelled? */
export function isEnvironPath(word) {
  if (!isStr(word) || !word.includes('/')) return false;
  const segs = lexicalSegments(word);
  if (segs.length < 2 || !segmentMatches(segs[segs.length - 1], 'environ')) return false;
  const i = segs.indexOf('proc');
  return i >= 0 && i < segs.length - 1;
}

// A word, or its attached value (`--file=…`, `-f…`), that names /proc/*/environ.
function wordHasEnviron(w) {
  if (isEnvironPath(w)) return true;
  const eq = w.indexOf('=');
  if (eq > 0 && isEnvironPath(w.slice(eq + 1))) return true;
  return w.length > 2 && w[0] === '-' && w[1] !== '-' && isEnvironPath(w.slice(2));
}

const NO_FILE = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const isNoFile = (p) => NO_FILE.has(p) || /^\/dev\/fd\/[0-9]+$/.test(p);

/**
 * Records the reads and writes of a command. io.read/write/rw take a word and record its
 * resolved path (UNKNOWN stays UNKNOWN; `-`, the empty word and the null devices name no file).
 * io.under(base) records relative to another base directory (`git -C dir`, `--output-dir`).
 */
function makeIo(ctx, reads, writes) {
  const resolveWord = (w, base) => {
    if (w === UNKNOWN || !isStr(w)) return UNKNOWN;
    if (w === '' || w === '-') return null;
    let word = w;
    if (base !== undefined && !w.startsWith('/')) {
      if (base === UNKNOWN || !isStr(base)) return UNKNOWN;
      word = `${base}/${w}`;
    }
    const p = ctx.resolve(word);
    if (isStr(p) && isNoFile(p)) return null;
    return p;
  };
  const make = (base) => {
    const add = (list, w) => {
      const p = resolveWord(w, base);
      if (p !== null) list.push(p);
    };
    return {
      read: (w) => add(reads, w),
      write: (w) => add(writes, w),
      rw: (w) => {
        add(reads, w);
        add(writes, w);
      },
      under: (b) => make(b),
      resolve: (w) => resolveWord(w, base),
      ctx,
      reads,
      writes,
    };
  };
  return make(undefined);
}

// ---------------------------------------------------------------------------------------------
// Host parse

/**
 * A host as a domain: lower case, one trailing dot removed. Anything that is not an ordinary DNS
 * name or a canonical dotted-decimal IPv4 address is UNKNOWN: IPv6 literals, numeric-only last
 * labels (`2130706433`, `127.1`), hex (`0x7f000001`), octal (`0177.0.0.1`), percent escapes,
 * non-ASCII, wildcards and empty labels.
 */
export function hostToDomain(host) {
  if (!isStr(host) || host === '') return UNKNOWN;
  if (/[^\x21-\x7e]/.test(host)) return UNKNOWN;
  let h = host.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === '' || h.length > 253 || !/^[a-z0-9._-]+$/.test(h)) return UNKNOWN;
  const labels = h.split('.');
  if (labels.some((l) => l === '' || l.length > 63)) return UNKNOWN;
  const last = labels[labels.length - 1];
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) {
    const canonical = labels.length === 4 && labels.every((l) => /^(?:0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255);
    return canonical ? h : UNKNOWN;
  }
  return h;
}

// `userinfo@host:port` (no path) to a domain.
function authorityDomain(auth) {
  if (auth.includes('\\')) return UNKNOWN;
  const at = auth.lastIndexOf('@');
  const hp = at >= 0 ? auth.slice(at + 1) : auth;
  if (hp.startsWith('[')) return UNKNOWN;
  let host = hp;
  const colon = hp.lastIndexOf(':');
  if (colon >= 0) {
    if (!/^[0-9]{0,5}$/.test(hp.slice(colon + 1))) return UNKNOWN;
    host = hp.slice(0, colon);
  }
  if (host.includes(':')) return UNKNOWN;
  return hostToDomain(host);
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

// {scheme, auth, path} of a URL-ish word; a word without a scheme is all authority (curl and
// wget accept `host/path`).
function splitUrl(word) {
  const m = SCHEME.exec(word);
  const scheme = m ? m[1].toLowerCase() : null;
  const rest = m ? word.slice(m[0].length) : word;
  const end = rest.search(/[/?#]/);
  return { scheme, auth: end < 0 ? rest : rest.slice(0, end), path: end < 0 ? '' : rest.slice(end) };
}

/** The domain of a URL operand: a string, UNKNOWN, or null for a URL with no network host (file:). */
export function urlDomainOf(word) {
  return urlDomain(word);
}

function urlDomain(word) {
  if (!isStr(word)) return UNKNOWN;
  const u = splitUrl(word);
  if (u.scheme === 'file') return null;
  return authorityDomain(u.auth);
}

// A scp-like `[user@]host:path` or `host::module`: the host part, or null when the word is a path.
function scpHost(word) {
  const colon = word.indexOf(':');
  if (colon < 0) return null;
  const slash = word.indexOf('/');
  if (slash >= 0 && slash < colon) return null;
  return word.slice(0, colon);
}

// The domain of a remote operand of ssh/scp/rsync/git: string, UNKNOWN, or null when local.
function remoteDomain(word) {
  if (!isStr(word)) return UNKNOWN;
  if (SCHEME.test(word)) return urlDomain(word);
  const h = scpHost(word);
  if (h === null) return null;
  if (h === '' || h.includes('[')) return UNKNOWN;
  return authorityDomain(h);
}

const isLocalPathWord = (w) => w === '.' || w === '..' || w.startsWith('/') || w.startsWith('./') || w.startsWith('../') || w.startsWith('~');

// A host operand of ssh, sftp, nc, telnet: `[user@]host[:port]` or a URL.
const hostOperand = (w) => (w === undefined || w === UNKNOWN ? UNKNOWN : (SCHEME.test(w) ? urlDomain(w) : authorityDomain(w)) ?? UNKNOWN);

// ---------------------------------------------------------------------------------------------
// Rows: delete

def(DELETERS, { dual: true, classes: () => ['delete'], fx: (p, io) => p.operands.forEach(io.write) });
def('shred', {
  short: 'ns',
  long: L('iterations size random-source'),
  dual: true,
  classes: () => ['delete', 'overwrite'],
  fx: (p, io) => {
    p.operands.forEach(io.write);
    p.vals('--random-source').forEach(io.read);
  },
});
// mv has no class of its own; its ancestor op lives in ops.mjs.
def('mv', {
  short: 'tS',
  long: L('target-directory suffix'),
  dual: true,
  classes: () => [],
  fx: (p, io) => {
    p.operands.forEach(io.rw);
    const dirs = p.vals('t', '--target-directory');
    dirs.forEach((d) => writeInto(io, d, p.operands));
    if (dirs.length === 0 && p.operands.length >= 2) writeInto(io, p.operands[p.operands.length - 1], p.operands.slice(0, -1));
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: overwrite

// A destination may be a directory: the copy lands in dest/<source name> as well as in dest.
const baseName = (w) => {
  if (!isStr(w)) return UNKNOWN;
  const b = w.replace(/\/+$/, '').slice(w.replace(/\/+$/, '').lastIndexOf('/') + 1);
  return b === '' || b === '.' || b === '..' || b === '-' ? null : b;
};
function writeInto(io, dir, sources) {
  io.write(dir);
  if (!isStr(dir) || io.resolve(dir) === null) return; // /dev/null and friends hold no files
  for (const src of sources) {
    const b = baseName(src);
    if (b === UNKNOWN) io.write(UNKNOWN);
    else if (b !== null) io.write(`${dir.replace(/\/+$/, '')}/${b}`);
  }
}

const copyClasses = (p) => (p.operands.some((o) => o === UNKNOWN || isZeroSource(o)) ? ['overwrite'] : []);
const copyFx = (p, io) => {
  const dirs = p.vals('t', '--target-directory');
  if (dirs.length > 0) {
    p.operands.forEach(io.read);
    dirs.forEach((d) => writeInto(io, d, p.operands));
  } else if (p.operands.length >= 2) {
    p.operands.slice(0, -1).forEach(io.read);
    writeInto(io, p.operands[p.operands.length - 1], p.operands.slice(0, -1));
  } else p.operands.forEach(io.rw);
};
def('cp', { short: 'tS', long: L('target-directory suffix reference'), dual: true, classes: copyClasses, fx: copyFx });
def('install', {
  short: 'gmotSB',
  long: L('group mode owner target-directory suffix'),
  dual: true,
  classes: copyClasses,
  fx: (p, io) => (p.has('d', '--directory') ? p.operands.forEach(io.write) : copyFx(p, io)),
});
def('ln', {
  short: 'tS',
  long: L('target-directory suffix'),
  dual: true,
  classes: (p) => (p.has('f') || p.longLike('force') || copyClasses(p).length > 0 ? ['overwrite'] : []),
  fx: (p, io) => {
    p.operands.forEach(io.rw);
    p.vals('t', '--target-directory').forEach(io.write);
  },
});
def('dd', {
  classes: (p) => (p.operands.some((o) => o === UNKNOWN || o.startsWith('of=')) ? ['overwrite'] : []),
  fx: (p, io) => {
    for (const o of p.operands) {
      if (o === UNKNOWN) io.rw(UNKNOWN);
      else if (o.startsWith('if=')) io.read(o.slice(3));
      else if (o.startsWith('of=')) io.write(o.slice(3));
    }
  },
});
def('tee', { classes: (p) => (p.operands.length > 0 ? ['overwrite'] : []), fx: (p, io) => p.operands.forEach(io.write) });
def('truncate', {
  short: 'rs',
  long: L('reference size'),
  classes: () => ['overwrite'],
  fx: (p, io) => {
    p.operands.forEach(io.write);
    p.vals('r', '--reference').forEach(io.read);
  },
});
def(`mkfs ${OVERWRITERS}`, { classes: () => ['overwrite'] });
def('diskutil', {
  classes: (p) => (p.operands.some((o) => o === UNKNOWN || /^(?:erase|zero|secure|partition|reformat|apfs(?:delete|erase)?)/i.test(o)) ? ['overwrite', 'delete'] : []),
});

// Other creators: operands are written.
def('touch', {
  short: 'rdtA',
  long: L('reference date'),
  classes: () => [],
  fx: (p, io) => {
    p.operands.forEach(io.write);
    p.vals('r', '--reference').forEach(io.read);
  },
});
def('mkdir mkfifo', { short: 'mZ', long: L('mode context'), classes: () => [], fx: (p, io) => p.operands.forEach(io.write) });
def('mknod', { short: 'mZ', long: L('mode context'), classes: () => [], fx: (p, io) => io.write(p.operands[0] ?? '') });
def('mktemp', {
  short: 'p',
  long: L('tmpdir suffix'),
  classes: () => [],
  fx: (p, io) => {
    p.operands.forEach(io.write);
    p.vals('p', '--tmpdir').forEach(io.write);
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: permissions and privilege

const PERM_LETTERS = new Set(['R', 'c', 'f', 'v', 'H', 'L', 'P', 'h']);
def('chmod chown chgrp', {
  long: L('reference from'),
  // a dash word that is not an option cluster is a mode (`-x`, `-rwx`)
  operandDash: (a) => !a.startsWith('--') && [...a.slice(1)].some((c) => !PERM_LETTERS.has(c)),
  classes: () => ['perm-change'],
  fx: (p, io) => {
    const refs = p.vals('--reference');
    refs.forEach(io.read);
    (refs.length > 0 ? p.operands : p.operands.slice(1)).forEach(io.write);
  },
});
def('setfacl chattr chflags setcap chcon', { classes: () => ['perm-change'] });
def(PRIVILEGE, { classes: () => ['privilege'] });
def('osascript', { classes: (p) => (p.operands.some((o) => isStr(o) && /administrator privileges/i.test(o)) || p.vals('e').some((v) => isStr(v) && /administrator privileges/i.test(v)) ? ['privilege'] : []) });

// Archivers and file managers that remove what they archive or list.
def('tar', { classes: (p) => (p.longLike('remove-files') ? ['delete'] : []) });
def('zip', { classes: (p) => (p.has('m', 'd', '--move', '--delete') || p.longLike('move') || p.longLike('delete') ? ['delete'] : []) });
def('gio', { classes: (p) => (p.operands[0] === UNKNOWN || ['remove', 'trash'].includes(p.operands[0]) ? ['delete'] : []) });

// ---------------------------------------------------------------------------------------------
// Rows: find

const FIND_ARG1 = new Set(
  words('-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname -type -xtype -user -group -uid -gid -perm -size -mtime -atime -ctime -mmin -amin -cmin -links -inum -fstype -context -printf -maxdepth -mindepth -regextype -used -newer -anewer -cnewer -samefile -fprint -fprint0 -fls -files0-from'),
);
const FIND_READ1 = new Set(['-newer', '-anewer', '-cnewer', '-samefile', '-files0-from']);
const FIND_WRITE1 = new Set(['-fprint', '-fprint0', '-fls']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function findParse(argv) {
  const r = { starts: [], reads: [], writes: [], del: false, execs: [], unknownPrimary: false };
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) break;
    if (/^-[HLPEXdsx]+$/.test(a) || /^-O[0-9]?$/.test(a)) continue;
    if (a === '-D') {
      i++;
      continue;
    }
    if (a === '-f') {
      if (i + 1 < argv.length) r.starts.push(argv[++i]);
      continue;
    }
    break;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (isStr(a) && ((a.startsWith('-') && a.length > 1) || a === '(' || a === ')' || a === '!' || a === ',')) break;
    if (!isStr(a)) r.unknownPrimary = true; // a start path, or `-delete`: unknowable
    r.starts.push(a);
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      r.unknownPrimary = true;
      continue;
    }
    if (a === '-delete') r.del = true;
    else if (FIND_EXEC.has(a)) {
      const inner = [];
      let j = i + 1;
      while (j < argv.length) {
        const w = argv[j];
        if (w === ';' || w === '\\;' || (w === '+' && inner[inner.length - 1] === '{}')) break;
        inner.push(w);
        j++;
      }
      r.execs.push(inner);
      i = j;
    } else if (FIND_WRITE1.has(a)) {
      if (i + 1 < argv.length) r.writes.push(argv[++i]);
    } else if (a === '-fprintf') {
      if (i + 1 < argv.length) r.writes.push(argv[i + 1]);
      i += 2;
    } else if (FIND_READ1.has(a)) {
      if (i + 1 < argv.length) r.reads.push(argv[++i]);
    } else if (/^-newer[acBmt][acBmt]$/.test(a)) {
      if (!a.endsWith('t') && i + 1 < argv.length) r.reads.push(argv[i + 1]);
      i++;
    } else if (FIND_ARG1.has(a)) i++;
  }
  return r;
}

// Commands nested inside commands (`find -exec find -exec …`) are classified recursively; past this
// depth the inner command is every class (and not read-only), so hostile input cannot recurse
// without bound.
const MAX_NEST = 8;
let nest = 0;
function nested(fallback, fn) {
  if (nest >= MAX_NEST) return fallback;
  nest++;
  try {
    return fn();
  } finally {
    nest--;
  }
}
const execClasses = (inner) =>
  inner.length === 0 ? [] : isStr(inner[0]) ? nested([...CLASS_NAMES], () => classesOf(inner)) : [...CLASS_NAMES];
const readOnlyInner = (inner) => {
  const c = isStr(inner[0]) ? callOf(inner) : null;
  return c !== null && (READ_ONLY.has(c.name) || NO_FILE_PROGRAMS.has(c.name)) && nested(false, () => writesNothing(inner));
};
const findStarts = (f) => (f.starts.length > 0 ? f.starts : ['.']);

def('find', {
  classes: (p, call) => {
    const f = findParse(call.argv);
    const out = ['search'];
    if (f.del) out.push('delete');
    if (f.writes.length > 0) out.push('overwrite');
    if (f.unknownPrimary) out.push('delete', 'overwrite');
    for (const inner of f.execs) out.push(...execClasses(inner));
    return out;
  },
  fx: (p, io, call) => {
    const f = findParse(call.argv);
    const starts = findStarts(f);
    starts.forEach(io.read);
    f.reads.forEach(io.read);
    f.writes.forEach(io.write);
    if (f.del || f.unknownPrimary || f.execs.some((inner) => !readOnlyInner(inner))) starts.forEach(io.write);
  },
  ops: (call) => {
    const f = findParse(call.argv);
    const deletes = f.del || f.execs.some((inner) => execClasses(inner).includes('delete'));
    return deletes ? findStarts(f).map((path) => ({ path, op: 'delete' })) : [];
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: rsync

// Flags that are a prefix of a value option (--partial / --partial-dir): typed in full they are the flag.
const RSYNC_BOOL = L('partial backup compress checksum archive verbose quiet recursive update inplace append links copy-links perms times owner group devices specials progress stats human-readable one-file-system whole-file relative numeric-ids size-only existing ignore-existing prune-empty-dirs list-only itemize-changes fuzzy hard-links sparse xattrs acls dry-run force');
const RSYNC_LONG = L(
  'rsh rsync-path block-size max-delete max-size min-size partial-dir temp-dir compare-dest copy-dest link-dest backup-dir suffix exclude include exclude-from include-from filter files-from address port sockopts log-file log-file-format out-format bwlimit timeout contimeout modify-window chmod chown usermap groupmap read-batch write-batch only-write-batch protocol iconv checksum-seed checksum-choice compress-choice compress-level skip-compress outbuf stop-after stop-at early-input password-file info debug',
);
const rsyncDeletes = (p) => p.longLike('delete') || p.longStarts('delete');
// --remove-source-files, --remove-sent-files, and any prefix of them
const rsyncRemoves = (p) => p.longLike('remove-source-files') || p.longLike('remove-sent-files') || p.longStarts('remove-s');
const isRemote = (o) => isStr(o) && remoteDomain(o) !== null;
def('rsync', {
  short: 'eBMTf@',
  long: RSYNC_LONG,
  bool: RSYNC_BOOL,
  classes: (p) => {
    const out = [];
    if (rsyncDeletes(p) || rsyncRemoves(p)) out.push('delete');
    if (p.operands.some(isRemote) || p.has('--daemon')) out.push('network-fetch');
    if (p.hasUnknown) out.push('network-fetch', 'delete');
    return out;
  },
  domains: (p, out) => {
    for (const o of p.operands) {
      if (o === UNKNOWN) out.push(UNKNOWN);
      else {
        const d = remoteDomain(o);
        if (d !== null) out.push(d);
      }
    }
    if (p.has('--daemon')) out.push(UNKNOWN);
  },
  fx: (p, io) => {
    const ops = p.operands;
    if (ops.length >= 2) {
      for (const o of ops.slice(0, -1)) {
        if (isRemote(o)) continue;
        io.read(o);
        if (rsyncRemoves(p)) io.write(o);
      }
      if (!isRemote(ops[ops.length - 1])) writeInto(io, ops[ops.length - 1], ops.slice(0, -1).filter((o) => !isRemote(o)));
    } else ops.filter((o) => !isRemote(o)).forEach(io.rw);
    for (const f of p.vals('--files-from', '--exclude-from', '--include-from', '--read-batch', '--password-file', '--compare-dest', '--copy-dest', '--link-dest')) io.read(f);
    for (const f of p.vals('--log-file', '--write-batch', '--only-write-batch', '--backup-dir', '--partial-dir', '--temp-dir')) io.write(f);
  },
  ops: (call, p) => {
    const ops = p.operands;
    const out = [];
    if (rsyncRemoves(p)) for (const o of ops.slice(0, -1)) out.push({ path: o, op: 'delete' });
    if (rsyncDeletes(p) && ops.length >= 1) out.push({ path: ops[ops.length - 1], op: 'delete' });
    return out;
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: environment dumps

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// env's value-taking options come from the wrapper table, so the two parsers cannot disagree
const { short: ENV_SHORT, long: ENV_LONG } = valueFlags('env');

// {inner, own}: the command `env` runs (argv from its first non-option, non-assignment word, or
// null) and env's own words before it. env's options are read from `own` only, so the inner
// command's flags are never taken for env's (`env rsync -S --delete a/ b/` is rsync with delete).
function envSplit(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) return { inner: argv.slice(i), own: argv.slice(0, i) };
    if (a === '--') return { inner: argv[i + 1] === undefined ? null : argv.slice(i + 1), own: argv.slice(0, i) };
    if (a.startsWith('--')) {
      if (!a.includes('=') && longMatches(a, ENV_LONG).some((n) => ENV_LONG.includes(n))) i++;
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        if (ENV_SHORT.includes(a[k])) {
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    if (ASSIGNMENT.test(a)) continue;
    return { inner: argv.slice(i), own: argv.slice(0, i) };
  }
  return { inner: null, own: argv };
}
const envInner = (argv) => envSplit(argv).inner;
const envOwn = (argv) => parseArgs(envSplit(argv).own, { short: ENV_SHORT, long: ENV_LONG });

def('env', {
  short: ENV_SHORT,
  long: ENV_LONG,
  classes: (p0, call) => {
    const p = envOwn(call.argv);
    if (p.has('S', '--split-string')) return [];
    const inner = envInner(call.argv);
    if (inner === null) return ['env-dump'];
    return execClasses(inner);
  },
  fx: (p0, io, call) => {
    // `env cmd args`: the command has its own table; `env` alone names no file
    const p = envOwn(call.argv);
    const inner = envInner(call.argv);
    if (p.has('S', '--split-string')) {
      unmodeled(inner === null ? call.argv : inner, io);
      return 'mutates';
    }
    if (inner === null) return undefined;
    // env -C DIR runs the command somewhere else: every path it names is unknown
    if (p.has('C', '--chdir')) {
      io.rw(UNKNOWN);
      return undefined;
    }
    const r = nested({ reads: [UNKNOWN], writes: [UNKNOWN] }, () => fileEffects(inner, io.ctx));
    io.reads.push(...r.reads);
    io.writes.push(...r.writes);
    return undefined;
  },
});
def('printenv', { classes: () => ['env-dump'] });
def('set', {
  classes: (p) => (!p.endOpts && p.flags.size === 0 && p.operands.every((o) => o === UNKNOWN) ? ['env-dump'] : []),
});
def('export', { classes: (p) => (p.operands.length === 0 || p.has('p') || p.hasUnknown ? ['env-dump'] : []) });
def('declare typeset readonly', {
  classes: (p, call) => {
    if (p.has('p') || p.hasUnknown) return ['env-dump'];
    if (p.operands.length === 0) {
      // `declare -f` / `-F` list functions; anything else lists variables
      return p.flags.size > 0 && [...p.flags].every((f) => f === 'f' || f === 'F') ? [] : ['env-dump'];
    }
    if (call.name !== 'readonly' && p.has('x')) return p.operands.every((o) => ASSIGNMENT.test(o)) ? [] : ['env-dump'];
    return [];
  },
});
def('ps', {
  short: 'pUutgGoOsCNMn',
  classes: (p) => {
    if (p.hasUnknown || p.has('E', '--environment')) return ['env-dump'];
    // BSD style: a bare cluster of letters containing `e` (`ps eww`, `ps auxe`)
    return p.operands.some((o) => /^[A-Za-z]+$/.test(o) && o.includes('e')) ? ['env-dump'] : [];
  },
});
def('launchctl', { classes: (p) => (p.operands.some((o) => o === UNKNOWN || o === 'getenv' || o === 'export' || o === 'print') ? ['env-dump'] : []) });
def('tmux', { classes: (p) => (p.operands.some((o) => o === 'show-environment' || o === 'showenv') ? ['env-dump'] : []) });
def('systemctl loginctl', { classes: (p) => (p.operands.includes('show-environment') ? ['env-dump'] : []) });

// ---------------------------------------------------------------------------------------------
// Rows: read-only programs. Their operands are read and never written, except where an option or
// a position says otherwise (sort -o, uniq's second operand, xxd's, base64 -o, tree -o).

const READ_ONLY = new Set();
const readAll = (p, io) => p.operands.forEach(io.read);
// Programs that print the content of their operands: an UNKNOWN operand may be /proc/*/environ.
const contentClasses = (p) => (p.hasUnknown ? ['env-dump'] : []);
const noClasses = () => [];
function reader(names, spec = {}, fx = readAll, classes = contentClasses) {
  def(names, { ...spec, readOnly: true, classes, fx });
  for (const n of words(names)) READ_ONLY.add(n);
}
reader('cat tac rev');
reader('nl', { short: 'bfhilnsvw' });
reader('head', { short: 'nc', long: L('lines bytes') });
reader('tail', { short: 'ncs', long: L('lines bytes pid sleep-interval max-unchanged-stats') });
reader('wc', { long: L('files0-from') }, (p, io) => {
  readAll(p, io);
  p.vals('--files0-from').forEach(io.read);
}, noClasses);
reader('cut', { short: 'bcdf', long: L('bytes characters delimiter fields output-delimiter') });
reader(
  'sort',
  { short: 'koSTt', long: L('key output buffer-size temporary-directory field-separator parallel batch-size files0-from random-source compress-program sort') },
  (p, io) => {
    readAll(p, io);
    p.vals('o', '--output', 'T', '--temporary-directory').forEach(io.write);
    p.vals('--files0-from', '--random-source').forEach(io.read);
  },
);
reader('uniq', { short: 'fsw', long: L('skip-fields skip-chars check-chars group') }, (p, io) => {
  p.operands.slice(0, 1).forEach(io.read);
  p.operands.slice(1).forEach(io.write);
});
reader('tr', {}, () => {}, noClasses);
reader(
  'diff',
  { short: 'xXILUCDFSWB', long: L('label ignore-matching-lines exclude exclude-from from-file to-file unified context width starting-file') },
  (p, io) => {
    readAll(p, io);
    p.vals('X', '--exclude-from', '--from-file', '--to-file').forEach(io.read);
  },
);
reader('cmp', { short: 'nilb', long: L('bytes ignore-initial print-bytes') }, readAll, noClasses);

const RECURSIVE_DEFAULT = new Set(['rg', 'ag', 'ack', 'ugrep', 'ug', 'pt']);
const searchClasses = (p) => ['search', ...contentClasses(p)];
const GREP_LONG = L('regexp file max-count after-context before-context context directories devices include exclude exclude-from exclude-dir label binary-files group-separator color colour');
// grep: the first operand is the pattern unless -e or -f names it
reader(
  'grep egrep fgrep zgrep zegrep zfgrep bzgrep xzgrep',
  { short: 'efmABCdD', long: GREP_LONG },
  (p, io) => {
    const files = p.hasVal('e', 'f', '--regexp', '--file') || p.hasUnknown ? p.operands : p.operands.slice(1);
    files.forEach(io.read);
    p.vals('f', '--file', '--exclude-from').forEach(io.read);
    if (files.length === 0 && p.has('r', 'R', '--recursive', '--dereference-recursive')) io.read('.');
  },
  searchClasses,
);
reader(
  'rg ag ack ugrep ug pt',
  {
    short: 'efgmABCjtTMdrE',
    long: L('regexp file glob iglob max-count replace threads sort sortr max-columns max-depth path-separator encoding context after-context before-context colors dfa-size-limit engine hostname-bin hyperlink-format ignore-file type type-not type-add type-clear pre pre-glob field-context-separator field-match-separator'),
  },
  (p, io) => {
    const noPattern = p.has('--files', '--type-list') || p.hasVal('e', 'f', '--regexp', '--file') || p.hasUnknown;
    const files = noPattern ? p.operands : p.operands.slice(1);
    files.forEach(io.read);
    p.vals('f', '--file', '--ignore-file', '--pre-glob').forEach(io.read);
    if (files.length === 0) io.read('.');
  },
  searchClasses,
);
reader(
  'fd fdfind',
  { short: 'tedEScjxXDoOC', long: L('type extension max-depth exclude size color threads exec exec-batch changed-within changed-before owner base-directory search-path') },
  (p, io) => {
    const rest = p.operands.slice(1);
    rest.forEach(io.read);
    if (rest.length === 0) io.read('.');
  },
  searchClasses,
);
reader('locate plocate mdfind', {}, () => {}, () => ['search']);
reader('ls', { short: 'IwTD', long: L('block-size color format sort time time-style indicator-style hide ignore quoting-style tabsize width') }, readAll, noClasses);
reader('stat', { short: 'cf', long: L('format printf') }, readAll, noClasses);
reader('file', { short: 'fmeP', long: L('files-from magic-file') }, (p, io) => {
  readAll(p, io);
  p.vals('f', '--files-from', 'm', '--magic-file').forEach(io.read);
}, noClasses);
reader('base64', { short: 'iobwD', long: L('input output break wrap') }, (p, io) => {
  readAll(p, io);
  p.vals('i', '--input').forEach(io.read);
  p.vals('o', '--output').forEach(io.write);
});
reader('xxd', { short: 'cgolsLn', long: L('cols groupsize') }, (p, io) => {
  p.operands.slice(0, 1).forEach(io.read);
  p.operands.slice(1).forEach(io.write);
});
reader('od', { short: 'AjNtwS', long: L('address-radix skip-bytes read-bytes format width') });
reader('hexdump', { short: 'nsef' }, (p, io) => {
  readAll(p, io);
  p.vals('f').forEach(io.read);
});
reader('strings', { short: 'ntTe', long: L('bytes radix encoding target') });
reader('md5sum sha1sum sha224sum sha256sum sha384sum sha512sum cksum sum md5 b2sum', {}, readAll, noClasses);
reader('shasum', { short: 'a' }, readAll, noClasses);
reader('paste', { short: 'ds', long: L('delimiters') });
reader('join comm fold fmt expand unexpand column', { short: 'tjo12wsc', long: L('width') });
reader('tree', { short: 'LPIDoHT', long: L('charset filelimit') }, (p, io) => {
  readAll(p, io);
  if (p.operands.length === 0) io.read('.');
  p.vals('o').forEach(io.write);
}, noClasses);
reader('du', { short: 'dtBSX', long: L('max-depth threshold block-size exclude exclude-from files0-from time-style') }, (p, io) => {
  readAll(p, io);
  if (p.operands.length === 0) io.read('.');
  p.vals('--files0-from', '--exclude-from').forEach(io.read);
}, noClasses);
reader('df readlink realpath', { short: 'tx' }, readAll, noClasses);
// jq's `env` and `$ENV` print the environment (not `.env`, a key)
const JQ_ENV = /(?<![.\w])env(?![\w])|\$ENV(?![\w])/;
reader('jq', {}, readAll, (p) => (p.hasUnknown || p.operands.some((o) => isStr(o) && JQ_ENV.test(o)) ? ['env-dump'] : []));
// awk's ENVIRON array
def('awk gawk mawk nawk', { classes: (p) => (p.operands.some((o) => isStr(o) && o.includes('ENVIRON')) ? ['env-dump'] : []) });
reader('bat batcat', { short: 'lrHLmdp', long: L('language line-range highlight-line map-syntax style theme') });
def('date', { short: 'dfrstuvz', classes: () => [], fx: (p, io) => p.vals('f', 'r').forEach(io.read) });

// Shell builtins that name a file: `history -w/-a [FILE]` writes or appends the history file,
// `-r/-n [FILE]` reads one; without FILE it is $HISTFILE, which is unknown here. zsh's fc: -W/-A
// write, -R/-p read. `source FILE` / `. FILE` read the file (T16 re-parses it).
function historyFx(write, read) {
  return (p, io) => {
    if (p.hasUnknown) io.rw(UNKNOWN);
    const file = p.operands[0] ?? UNKNOWN;
    if (p.has(...write)) io.write(file);
    if (p.has(...read)) io.read(file);
  };
}
def('history', { classes: () => [], fx: historyFx(['w', 'a'], ['r', 'n']) });
def('fc', { classes: () => [], fx: historyFx(['W', 'A'], ['R', 'p']) });
def('source .', { classes: () => [], fx: (p, io) => p.operands.slice(0, 1).forEach(io.read) });

// ---------------------------------------------------------------------------------------------
// Rows: curl and wget

const CURL_SHORT = 'AbcCdDeEFHKmoPQrtTuUwxXyYz';
const CURL_LONG = L(
  'data data-ascii data-binary data-raw data-urlencode header user-agent output output-dir proxy proxy-user cookie cookie-jar cert key cacert capath resolve connect-to form form-string request upload-file user referer max-time connect-timeout retry retry-delay retry-max-time write-out config url url-query dump-header trace trace-ascii stderr libcurl limit-rate range cert-type key-type ciphers interface local-port dns-servers doh-url socks5 socks5-hostname socks4 socks4a proxy-header proxy-cert proxy-key proxy-cacert preproxy json aws-sigv4 oauth2-bearer continue-at time-cond telnet-option quote mail-from mail-rcpt ftp-port pinnedpubkey pass tls-max unix-socket abstract-unix-socket noproxy request-target max-filesize max-redirs speed-limit speed-time keepalive-time etag-save etag-compare hsts alt-svc variable service-name proto proto-default proto-redir netrc-file crlfile parallel-max rate',
);
const curlUrls = (p) => [...p.operands, ...p.vals('--url')];

// `-d @file` names a file; `--data-urlencode name@file` too. null: not a file.
function fileInData(v, urlencode) {
  if (!isStr(v)) return v;
  if (v.startsWith('@')) return v.slice(1);
  if (urlencode) {
    const eq = v.indexOf('=');
    const at = v.indexOf('@');
    if (at >= 0 && (eq < 0 || at < eq)) return v.slice(at + 1);
  }
  return null;
}

// `-F name=@file;type=x` / `name=<file`: the files it uploads or reads.
function formFiles(v) {
  if (!isStr(v)) return [v];
  const eq = v.indexOf('=');
  if (eq < 0) return [];
  const rest = v.slice(eq + 1);
  if (rest[0] !== '@' && rest[0] !== '<') return [];
  const semi = rest.indexOf(';');
  return (semi < 0 ? rest.slice(1) : rest.slice(1, semi)).split(',').map((s) => s.replace(/^"|"$/g, '')).filter((s) => s !== '');
}

// The file name curl -O / wget derive from a URL: a name, UNKNOWN, or `fallback` for a URL that
// ends in a slash.
function urlFileName(word, fallback) {
  if (!isStr(word)) return UNKNOWN;
  const u = splitUrl(word);
  const cut = u.path.search(/[?#]/);
  const pathOnly = cut < 0 ? u.path : u.path.slice(0, cut);
  const name = pathOnly.slice(pathOnly.lastIndexOf('/') + 1);
  if (name === '') return fallback;
  if (name.includes('%') || /[\0\\]/.test(name)) return UNKNOWN;
  return name;
}

function decodeFilePath(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return UNKNOWN;
  }
}

def('curl', {
  short: CURL_SHORT,
  long: CURL_LONG,
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    const urls = curlUrls(p);
    for (const u of urls) {
      const d = urlDomain(u);
      if (d !== null) out.push(d);
    }
    if (p.hasUnknown) out.push(UNKNOWN);
    for (const v of p.vals('x', '--proxy', '--preproxy', '--socks5', '--socks5-hostname', '--socks4', '--socks4a', '--doh-url')) {
      out.push(isStr(v) ? (urlDomain(v) ?? UNKNOWN) : UNKNOWN);
    }
    // a config file, a DNS override or a unix socket changes where the request goes
    if (p.hasVal('K', '--config', '--resolve', '--connect-to', '--dns-servers', '--interface', '--unix-socket', '--abstract-unix-socket')) out.push(UNKNOWN);
    // no URL at all: ~/.curlrc may name one
    if (urls.length === 0) out.push(UNKNOWN);
  },
  fx: (p, io0) => {
    // a leading ~/ inside an @file value is not expanded by the shell; a tool may expand it: read both
    const io = {
      ...io0,
      read: (w) => {
        io0.read(w);
        const home = io0.ctx.home;
        if (isStr(w) && w.startsWith('~/') && isStr(home)) io0.read(`${home.replace(/\/+$/, '')}/${w.slice(2)}`);
      },
    };
    const dir = p.vals('--output-dir')[0];
    const out = dir === undefined ? io : io.under(dir);
    for (const v of p.vals('d', '--data', '--data-ascii', '--data-binary', '--json')) {
      const f = fileInData(v, false);
      if (f !== null) io.read(f);
    }
    for (const v of p.vals('--data-urlencode')) {
      const f = fileInData(v, true);
      if (f !== null) io.read(f);
    }
    for (const v of p.vals('F', '--form')) for (const f of formFiles(v)) io.read(f);
    // -H @file / --proxy-header @file read the headers from a file
    for (const v of p.vals('H', '--header', '--proxy-header')) if (!isStr(v) || v.startsWith('@')) io.read(isStr(v) ? v.slice(1) : v);
    for (const v of p.vals('--url-query', '--variable')) {
      const f = fileInData(v, true);
      if (f !== null) io.read(f);
    }
    for (const f of p.vals('T', '--upload-file', 'K', '--config', '--cacert', '--capath', '--key', '--netrc-file', '--crlfile', '--proxy-cacert', '--proxy-key')) io.read(f);
    for (const v of p.vals('E', '--cert', '--proxy-cert')) io.read(isStr(v) ? v.split(':')[0] : v);
    for (const v of p.vals('b', '--cookie')) if (v === UNKNOWN || (isStr(v) && !v.includes('='))) io.read(v);
    // a config file may name any output file
    if (p.hasVal('K', '--config')) io.write(UNKNOWN);
    for (const f of p.vals('o', '--output', 'D', '--dump-header', 'c', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--libcurl', '--etag-save')) {
      out.write(f);
      if (p.ambiguous && dir !== undefined) io.write(f); // an ambiguous --o… may not be --output-dir
    }
    for (const f of p.vals('--hsts', '--alt-svc')) out.rw(f);
    const named = p.has('J') || p.longLike('remote-header-name');
    let downloads = false;
    if (p.has('O') || p.longLike('remote-name') || p.longStarts('remote-name')) {
      for (const u of curlUrls(p)) {
        if (isStr(u) && splitUrl(u).scheme === 'file') continue;
        const n = named ? UNKNOWN : urlFileName(u, null);
        if (n !== null) out.write(n);
        downloads = true;
      }
    }
    // file:// reads the file
    for (const u of curlUrls(p)) {
      if (isStr(u) && splitUrl(u).scheme === 'file') {
        const path = splitUrl(u).path.split(/[?#]/)[0];
        io.read(path === '' ? UNKNOWN : decodeFilePath(path));
      }
    }
    // -O downloads into the cwd (or --output-dir): a protected cwd is written
    return downloads ? 'mutates' : undefined;
  },
});

const WGET_SHORT = 'aABDeiIloOPQRtTUwXY';
const WGET_LONG = L(
  'output-document output-file append-output directory-prefix input-file base post-data post-file body-data body-file header user-agent referer load-cookies save-cookies ca-certificate certificate private-key ca-directory random-file egd-file http-user http-password user password ftp-user ftp-password proxy-user proxy-password bind-address timeout dns-timeout connect-timeout read-timeout wait waitretry tries level quota limit-rate accept reject accept-regex reject-regex include-directories exclude-directories domains exclude-domains follow-tags ignore-tags execute config rejected-log warc-file warc-header method default-page secure-protocol hsts-file progress report-speed restrict-file-names local-encoding remote-encoding preferred-location regex-type backups cut-dirs',
);
const wgetRecursive = (p) => p.has('r', 'm', 'p', 'x') || p.longStarts('recursive') || p.longStarts('mirror') || p.longStarts('page-requisites') || p.longStarts('force-directories');
def('wget', {
  short: WGET_SHORT,
  long: WGET_LONG,
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    for (const u of p.operands) out.push(u === UNKNOWN ? UNKNOWN : (urlDomain(u) ?? UNKNOWN));
    if (p.hasVal('i', '--input-file', '--base', 'B', '--config')) out.push(UNKNOWN);
    // `-e command` is a wgetrc line: it can set a proxy or the URL base
    if (p.vals('e', '--execute').some((v) => v === UNKNOWN || /proxy|base|input/i.test(v))) out.push(UNKNOWN);
    if (p.operands.length === 0 || p.hasUnknown) out.push(UNKNOWN);
  },
  fx: (p, io) => {
    const doc = p.vals('O', '--output-document');
    const prefix = p.vals('P', '--directory-prefix')[0];
    const out = prefix === undefined ? io : io.under(prefix);
    for (const f of p.vals('i', '--input-file', '--post-file', '--body-file', '--load-cookies', '--ca-certificate', '--certificate', '--private-key', '--config')) io.read(f);
    for (const f of p.vals('o', '--output-file', 'a', '--append-output', '--save-cookies', '--rejected-log', '--warc-file')) io.write(f);
    for (const f of p.vals('--hsts-file')) io.rw(f);
    if (doc.length > 0) {
      doc.forEach(io.write);
      return undefined;
    }
    // no -O: downloads land in the cwd (or -P dir); -i and recursion name files unknown here
    const recursive = wgetRecursive(p);
    if (recursive || p.hasVal('i', '--input-file')) out.write('.');
    if (!recursive) for (const u of p.operands) out.write(urlFileName(u, 'index.html'));
    return 'mutates';
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: ssh, scp, sftp, nc, telnet, socat and the other network programs

// `-o Key=value` options of ssh and scp.
const sshOptionKey = (v) => (isStr(v) ? /^[^=\s]*/.exec(v)[0].toLowerCase() : '');
const sshOptionValue = (v) => (isStr(v) ? v.replace(/^[^=\s]+[=\s]\s*/, '') : v);
function sshDomains(p, out) {
  for (const j of p.vals('J')) {
    if (j === UNKNOWN) out.push(UNKNOWN);
    else for (const h of j.split(',')) out.push(hostOperand(h));
  }
  if (p.hasVal('F')) out.push(UNKNOWN); // a config file can set HostName and ProxyJump
  for (const v of p.vals('o')) {
    if (v === UNKNOWN || /^(?:hostname|proxyjump|proxycommand|localcommand)$/.test(sshOptionKey(v))) out.push(UNKNOWN);
  }
}
function sshFx(p, io) {
  p.vals('i', 'F').forEach(io.read);
  for (const v of p.vals('o')) {
    const key = sshOptionKey(v);
    if (key === 'identityfile' || key === 'certificatefile' || key === 'include') io.read(sshOptionValue(v));
    else if (key === 'userknownhostsfile' || key === 'globalknownhostsfile' || key === 'controlpath') io.write(sshOptionValue(v));
  }
}
def('ssh', {
  short: 'bcDEeFIiJLlmOopQRSWw',
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    sshDomains(p, out);
    // -W host:port forwards stdio to that host
    for (const w of p.vals('W')) out.push(isStr(w) ? authorityDomain(w) : UNKNOWN);
    out.push(hostOperand(p.operands[0]));
    if (p.hasUnknown) out.push(UNKNOWN);
  },
  fx: (p, io) => {
    sshFx(p, io);
    p.vals('E', 'S').forEach(io.write);
  },
});
def('scp', {
  short: 'cDFiJlPoSX',
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    sshDomains(p, out);
    for (const o of p.operands) {
      if (o === UNKNOWN) out.push(UNKNOWN);
      else {
        const d = remoteDomain(o);
        if (d !== null) out.push(d);
      }
    }
  },
  fx: (p, io) => {
    sshFx(p, io);
    const ops = p.operands;
    if (ops.length >= 2) {
      ops.slice(0, -1).filter((o) => !isRemote(o)).forEach(io.read);
      if (!isRemote(ops[ops.length - 1])) writeInto(io, ops[ops.length - 1], ops.slice(0, -1).filter((o) => !isRemote(o)));
    } else ops.filter((o) => !isRemote(o)).forEach(io.rw);
  },
});
def('sftp', {
  short: 'BbcDFiJlPoRSsX',
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    sshDomains(p, out);
    const host = p.operands[0];
    out.push(host === UNKNOWN || host === undefined ? UNKNOWN : (remoteDomain(host) ?? hostOperand(host)));
  },
  fx: (p, io) => {
    sshFx(p, io);
    p.vals('b').forEach(io.read);
  },
});
def('nc ncat netcat', {
  short: 'IiOPpqsTVWwXxgGmeco',
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    if (p.has('l', '--listen')) out.push(UNKNOWN); // any peer may connect
    if (p.has('U', '--unixsock')) return;
    out.push(hostOperand(p.operands[0]));
    for (const v of p.vals('x', '--proxy')) out.push(isStr(v) ? authorityDomain(v) : UNKNOWN);
  },
  fx: (p, io) => {
    if (p.has('U')) p.operands.slice(0, 1).forEach(io.rw);
  },
});
def('telnet', {
  short: 'bekluSX',
  classes: () => ['network-fetch'],
  domains: (p, out) => out.push(hostOperand(p.operands[0])),
});
const SOCAT_NET = /^(?:tcp|tcp4|tcp6|tcp-connect|udp|udp4|udp6|udp-connect|sctp|sctp4|sctp6|sctp-connect|openssl|openssl-connect|ssl|socks4|socks4a|proxy):/i;
const SOCAT_FILE = /^(?:file|open|create|gopen|pipe|unix-connect|unix-client|unix-listen|unix-sendto|unix-recv|unix-recvfrom|uds):/i;
def('socat', {
  short: 'bdDlmpstTuUv',
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    for (const o of p.operands) {
      if (o === UNKNOWN) out.push(UNKNOWN);
      else if (SOCAT_NET.test(o)) {
        const addr = o.slice(o.indexOf(':') + 1).split(',')[0];
        out.push(addr.startsWith('[') ? UNKNOWN : hostToDomain(addr.split(':')[0]));
      } else if (/-listen:/i.test(o) || /^(?:exec|system|socks5|tun|vsock|ip|ip4|ip6|rawip|interface):/i.test(o)) out.push(UNKNOWN);
    }
  },
  fx: (p, io) => {
    for (const o of p.operands) {
      if (o === UNKNOWN) io.rw(UNKNOWN);
      else if (o === '-' || SOCAT_NET.test(o) || /-listen:/i.test(o) || /^(?:exec|system):/i.test(o)) continue;
      else if (SOCAT_FILE.test(o)) io.rw(o.slice(o.indexOf(':') + 1).split(',')[0]);
      else if (!/^[A-Za-z0-9-]+:/.test(o)) io.rw(o);
    }
  },
});

// Hosts of the remaining network programs. 'all': every operand that is not a number (a count, a
// port, a timeout) or a DNS record type is a host.
// Option letters that take a value, per 'all'-kind program (so `ping -c 3 host` does not read `3` as
// a host). A numeric operand left over is a possible host spelled as a number: UNKNOWN.
const NET_ALL_SHORT = {
  ping: 'cilmMpQsStTwWIGghz',
  ping6: 'cilmMpQsStTwWIGghz',
  dig: 'bcfkmpqtxy',
  host: 'cNRtWml',
  drill: 'bcQtTxy',
  whois: 'hp',
  traceroute: 'fgimpqstwzAlL',
  traceroute6: 'fgimpqstwzAlL',
  tracepath: 'lmp',
  mtr: 'cifmsSaBPIZo',
  'ssh-keyscan': 'ptTf',
};
const NET_DOMAINS = {
  first: (p, out) => out.push(hostOperand(p.operands[0])),
  all: (p, out) => {
    let found = false;
    for (const o of p.operands) {
      if (o === UNKNOWN) {
        out.push(UNKNOWN);
        found = true;
      } else if (!o.startsWith('+') && !RR_TYPES.has(o.toLowerCase())) {
        out.push(o.startsWith('@') ? hostOperand(o.slice(1)) : hostOperand(o.split('/')[0]));
        found = true;
      }
    }
    if (!found) out.push(UNKNOWN);
  },
  urls: (p, out) => {
    for (const o of p.operands) out.push(o === UNKNOWN ? UNKNOWN : (urlDomain(o) ?? UNKNOWN));
    if (p.operands.length === 0) out.push(UNKNOWN);
  },
  none: (p, out) => out.push(UNKNOWN),
};
for (const kind of Object.keys(NETWORK_HOSTS)) {
  for (const name of words(NETWORK_HOSTS[kind])) {
    if (D.has(name)) continue;
    def(name, {
      short: kind === 'first' ? 'IiOPpqsTVWwXxgGmeco' : kind === 'all' ? (NET_ALL_SHORT[name] ?? '') : '',
      classes: () => ['network-fetch'],
      domains: NET_DOMAINS[kind],
      // no `fx`: these programs are not modeled for file effects, so the unmodeled-program rule
      // applies (every non-flag word is read and written; a protected cwd is written)
    });
  }
}
def('openssl', {
  classes: (p) => (p.operands.some((o) => o === UNKNOWN || o === 's_client' || o === 's_server') ? ['network-fetch'] : []),
  domains: (p, out) => {
    if (p.operands.includes('s_client') || p.hasUnknown) {
      const c = p.vals('-connect')[0];
      out.push(isStr(c) ? authorityDomain(c) : UNKNOWN);
    }
    if (p.operands.includes('s_server')) out.push(UNKNOWN);
  },
});
def(BROWSER_OPENERS, {
  classes: (p) => (p.operands.some((o) => o === UNKNOWN || (isStr(o) && SCHEME.test(o) && !/^file:/i.test(o))) ? ['network-fetch'] : []),
  domains: (p, out) => {
    for (const o of p.operands) {
      if (o === UNKNOWN) out.push(UNKNOWN);
      else if (SCHEME.test(o)) {
        const d = urlDomain(o);
        if (d !== null) out.push(d);
      }
    }
  },
});
def('gh', {
  short: 'RHqt',
  long: L('hostname repo method header field raw-field input jq template'),
  classes: () => ['network-fetch'],
  domains: (p, out) => {
    const hosts = p.vals('--hostname');
    if (hosts.length === 0) out.push('github.com');
    for (const h of hosts) out.push(isStr(h) ? authorityDomain(h) : UNKNOWN);
    if (p.hasUnknown) out.push(UNKNOWN);
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: git

const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source']);

// git's global options, then the sub-command and its arguments.
function gitSplit(argv) {
  const g = { chdirs: [], configs: [], sub: null, rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      g.sub = UNKNOWN;
      g.rest = argv.slice(i + 1);
      return g;
    }
    if (GIT_GLOBAL_VALUE.has(a)) {
      const v = argv[++i];
      if (v === undefined) return g;
      if (a === '-C') g.chdirs.push(v);
      else if (a === '-c' || a === '--config-env') g.configs.push(v);
      continue;
    }
    if (a.startsWith('--config-env=')) {
      g.configs.push(a.slice('--config-env='.length));
      continue;
    }
    if (a.startsWith('-') && a !== '-') continue;
    g.sub = a;
    g.rest = argv.slice(i + 1);
    return g;
  }
  return g;
}

// `git -C a -C b`: each relative to the previous. undefined when there is no -C.
function gitBase(chdirs) {
  let base;
  for (const d of chdirs) {
    if (!isStr(d)) return UNKNOWN;
    base = base === undefined || d.startsWith('/') ? d : `${base}/${d}`;
  }
  return base;
}

const GIT_FETCHERS = new Set(words('fetch pull push clone ls-remote fetch-pack send-pack lfs svn send-email imap-send'));
// vcs-write is the history-changing set: these sub-commands whatever their flags (they move branch
// tips or rewrite history), plus `branch -D/-d/-f/-m`, `checkout -f/-B` and `switch -C`. Not
// vcs-write (controller rulings): stash, tag, worktree add, remote add, submodule update, bisect,
// branch <name>, pull, reflog expire, gc --prune, prune, symbolic-ref, notes.
const GIT_VCS_ALWAYS = new Set(words('commit merge rebase reset push cherry-pick revert update-ref am filter-branch filter-repo replace fast-import'));
// Builtins that change things without being vcs-write; listed so they are not mistaken for an alias.
const GIT_OTHER_WRITERS = words('prune bisect');
// Sub-commands that only read, whatever their flags and operands.
const GIT_PURE_READ = new Set(
  words('status diff log show rev-parse ls-files ls-tree ls-remote cat-file blame annotate grep describe shortlog show-ref for-each-ref rev-list merge-base name-rev check-ignore check-attr count-objects fsck var version help whatchanged range-diff diff-tree diff-index diff-files verify-commit verify-tag show-branch cherry difftool request-pull'),
);
// Sub-commands whose arguments decide whether they write (branch, tag, remote, ...).
const GIT_CONDITIONAL = new Set(words('branch tag remote config stash notes worktree submodule bundle reflog symbolic-ref gc'));
const GIT_KNOWN_SUBS = new Set([
  ...GIT_FETCHERS,
  ...GIT_VCS_ALWAYS,
  ...GIT_OTHER_WRITERS,
  ...GIT_PURE_READ,
  ...GIT_CONDITIONAL,
  ...words('add rm mv restore checkout switch clean init apply archive format-patch sparse-checkout checkout-index read-tree write-tree update-index hash-object mergetool bugreport credential daemon http-fetch instaweb interpret-trailers mktag mktree pack-objects unpack-file get-tar-commit-id diagnose repack pack-refs maintenance commit-tree'),
]);

const GIT_SPECS = {
  fetch: { short: 'ojsX', long: L('push-option receive-pack exec repo depth deepen shallow-since shallow-exclude jobs upload-pack server-option strategy strategy-option negotiation-tip refmap filter recurse-submodules submodule-prefix') },
  clone: { short: 'bocjuc', long: L('branch origin depth reference reference-if-able separate-git-dir jobs template config upload-pack filter shallow-since shallow-exclude bundle-uri ref-format revision server-option') },
  branch: { short: 'ust', long: L('set-upstream-to track sort format contains no-contains merged no-merged points-at abbrev column color') },
  tag: { short: 'umF', long: L('message file local-user sort format contains no-contains merged no-merged points-at column') },
  checkout: { short: 'bBU', long: L('conflict pathspec-from-file') },
  switch: { short: 'cC', long: L('create force-create conflict') },
  stash: { short: 'm', long: L('message') },
  remote: { short: 'tmM', long: L('track master') },
  commit: { short: 'mCcFtSu', long: L('message file author date template reuse-message reedit-message fixup squash cleanup gpg-sign') },
  clean: { short: 'e', long: L('exclude') },
  config: { short: 'f', long: L('file blob default type') },
};
for (const k of ['pull', 'push', 'ls-remote']) GIT_SPECS[k] = GIT_SPECS.fetch;
const gitParse = (g) => parseArgs([g.sub, ...g.rest], GIT_SPECS[g.sub] || {});

const BRANCH_MUTATOR_LETTERS = /[dDmMcCfut]/; // any ref change (for the cwd write); t: --track creates
const BRANCH_REWRITE_LETTERS = /[dDfmM]/; // delete, force, move: vcs-write
const BRANCH_MUTATOR_LONG = ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog'];
const BRANCH_REWRITE_LONG = ['--delete', '--force', '--move'];

// A branch listing has no mutating flag and no creating operand.
function branchWrites(p) {
  if (p.hasUnknown) return true;
  for (const f of p.flags) {
    if (f.length === 1 ? BRANCH_MUTATOR_LETTERS.test(f) : BRANCH_MUTATOR_LONG.some((m) => f === m || (f.length >= 3 && m.startsWith(f)))) return true;
  }
  if (p.has('l', '--list', '--show-current')) return false;
  return p.operands.length > 0;
}

// `branch -D/-d/-f/-m` (and -M, --delete/--force/--move through any prefix): history-changing.
function branchRewrites(p) {
  if (p.hasUnknown) return true;
  for (const f of p.flags) {
    if (f.length === 1 ? BRANCH_REWRITE_LETTERS.test(f) : BRANCH_REWRITE_LONG.some((m) => f === m || (f.length >= 3 && m.startsWith(f)))) return true;
  }
  return false;
}

function tagWrites(p) {
  if (p.hasUnknown) return true;
  if (p.has('d', 'f', 'a', 's', 'u', 'm', 'F', '--delete', '--force', '--annotate', '--sign', '--message', '--file')) return true;
  if (p.has('l', '--list', 'n', 'v', '--verify')) return false;
  return p.operands.length > 0;
}

const stashReads = (p) => p.operands.length > 0 && p.operands.every((o) => o === 'list' || o === 'show');
const REMOTE_WRITE_VERBS = ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'];
const WORKTREE_WRITE_VERBS = ['add', 'remove', 'move', 'prune', 'lock', 'unlock', 'repair'];
const NOTES_WRITE_VERBS = ['add', 'append', 'copy', 'edit', 'merge', 'remove', 'prune'];
const CONFIG_READ_LONG = ['get', 'get-all', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool', 'list', 'show-origin', 'show-scope'];

// Does the sub-command change anything (refs, index, working tree, config)?
function gitWrites(g, p) {
  const sub = g.sub;
  if (GIT_PURE_READ.has(sub)) return false;
  switch (sub) {
    case 'branch':
      return branchWrites(p);
    case 'tag':
      return tagWrites(p);
    case 'remote':
      return p.hasUnknown || REMOTE_WRITE_VERBS.includes(p.operands[0]);
    case 'config':
      return p.hasUnknown || !(p.has('l') || CONFIG_READ_LONG.some((n) => p.longStarts(n) || [...p.flags].some((f) => f.startsWith('--') && f.length >= 4 && n.startsWith(f.slice(2)))));
    case 'stash':
      return p.hasUnknown || !stashReads(p);
    case 'notes':
      return p.hasUnknown || NOTES_WRITE_VERBS.includes(p.operands[0]);
    case 'worktree':
      return p.hasUnknown || WORKTREE_WRITE_VERBS.includes(p.operands[0]);
    case 'submodule':
      return p.hasUnknown || !p.operands.every((o) => o === 'status' || o === 'summary');
    case 'bundle':
      return p.operands[0] === 'create' || p.hasUnknown;
    case 'reflog':
      return p.hasUnknown || ['expire', 'delete'].includes(p.operands[0]);
    case 'symbolic-ref':
      return p.hasUnknown || p.operands.length >= 2 || p.has('d', '--delete');
    case 'gc':
      return true;
    default:
      return true;
  }
}

function gitClasses(g) {
  const sub = g.sub;
  const out = [];
  if (sub === null) return out;
  if (sub === UNKNOWN) return ['network-fetch', 'vcs-write', 'delete'];
  const p = gitParse(g);
  if (g.configs.includes(UNKNOWN)) out.push('network-fetch', 'vcs-write');
  if (GIT_FETCHERS.has(sub) && !(sub === 'ls-remote' && p.has('--get-url'))) out.push('network-fetch');
  if (GIT_VCS_ALWAYS.has(sub)) out.push('vcs-write');
  if (sub === 'checkout' && (p.has('f', 'B', '--force') || p.longLike('force'))) out.push('vcs-write');
  if (sub === 'switch' && (p.has('C', '--force-create') || p.longLike('force-create'))) out.push('vcs-write');
  if (sub === 'branch' && branchRewrites(p)) out.push('vcs-write');
  if (sub === 'remote') {
    const verb = p.operands[0];
    if (p.hasUnknown || ['update', 'prune', 'show'].includes(verb) || (verb === 'add' && p.has('f', '--fetch'))) out.push('network-fetch');
  }
  if (sub === 'submodule' && gitWrites(g, p)) out.push('network-fetch');
  if (sub === 'archive' && p.longStarts('remote')) out.push('network-fetch');
  if (sub === 'clean' || sub === 'rm') out.push('delete');
  if (sub === 'grep') out.push('search');
  // not a git builtin: an alias or an external git-<sub> can do anything
  if (!GIT_KNOWN_SUBS.has(sub)) out.push('network-fetch', 'vcs-write', 'delete');
  // an UNKNOWN word may be -D / -f
  if (p.hasUnknown && (sub === 'branch' || sub === 'checkout')) out.push('vcs-write');
  return out;
}

// The domain of a git remote operand: string, UNKNOWN, or null when it is a local path.
function gitRemoteDomain(word, bareIsLocal) {
  if (word === UNKNOWN || !isStr(word)) return UNKNOWN;
  if (word.includes('::') && !SCHEME.test(word)) return UNKNOWN; // ext::, fd::, other transports
  if (SCHEME.test(word)) return urlDomain(word);
  if (isLocalPathWord(word)) return null;
  if (scpHost(word) !== null) return remoteDomain(word);
  return bareIsLocal ? null : UNKNOWN; // a bare word is a named remote: its URL is in .git/config
}

function gitDomains(g, out) {
  const sub = g.sub;
  if (sub === null) return;
  if (sub === UNKNOWN) {
    out.push(UNKNOWN);
    return;
  }
  const p = gitParse(g);
  const networked = GIT_FETCHERS.has(sub) || sub === 'remote' || sub === 'submodule' || (sub === 'archive' && p.longStarts('remote'));
  if (!networked) return;
  // a -c that rewrites URLs or sets a proxy changes where any remote operand goes
  for (const c of g.configs) {
    if (c === UNKNOWN || /^(?:url\.|remote\.|http\.|core\.(?:gitproxy|sshcommand)|protocol\.|credential\.)/i.test(c)) out.push(UNKNOWN);
  }
  if (sub === 'submodule') {
    if (gitWrites(g, p)) out.push(UNKNOWN);
    return;
  }
  if (sub === 'remote') {
    if (p.hasUnknown || ['update', 'prune', 'show'].includes(p.operands[0]) || (p.operands[0] === 'add' && p.has('f', '--fetch'))) out.push(UNKNOWN);
    return;
  }
  if (sub === 'archive') {
    const r = p.vals('--remote')[0];
    out.push(r === undefined ? UNKNOWN : (gitRemoteDomain(r, false) ?? UNKNOWN));
    return;
  }
  if (['lfs', 'svn', 'send-email', 'imap-send'].includes(sub)) {
    out.push(UNKNOWN);
    return;
  }
  if (sub === 'ls-remote' && p.has('--get-url')) return;
  if (p.hasUnknown || p.has('--all')) out.push(UNKNOWN);
  const repo = p.vals('--repo')[0];
  const operands = repo === undefined ? p.operands : [repo, ...p.operands];
  if (operands.length === 0) {
    out.push(UNKNOWN); // the default remote's URL is in .git/config
    return;
  }
  if (sub === 'clone') {
    const d = gitRemoteDomain(operands[0], true);
    if (d !== null) out.push(d);
    return;
  }
  const first = p.has('--multiple') ? operands : operands.slice(0, 1);
  for (const o of first) {
    const d = gitRemoteDomain(o, false);
    if (d !== null) out.push(d);
  }
}

// The directory `git clone <url>` creates.
function repoDirName(url) {
  if (!isStr(url)) return UNKNOWN;
  let s = url;
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  const name = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf(':')) + 1);
  return name === '' || name === '.' || name === '..' ? UNKNOWN : name;
}

// Sub-commands whose pathspec operands are files they overwrite, and those that only read them.
const GIT_PATH_RW = new Set(words('restore checkout reset switch stash commit sparse-checkout checkout-index read-tree'));
const GIT_PATH_READ = new Set(words('diff log show blame annotate grep ls-files ls-tree status cat-file shortlog diff-index diff-files diff-tree rev-list archive format-patch check-ignore check-attr difftool hash-object whatchanged describe name-rev cherry range-diff'));

// File effects of a git command; returns 'mutates' when the working tree or .git may change.
function gitFx(g, io0, call) {
  const sub = g.sub;
  if (sub === null) return undefined;
  const base = gitBase(g.chdirs);
  const io = base === undefined ? io0 : io0.under(base);
  if (sub === UNKNOWN) {
    io.rw(UNKNOWN);
    return 'mutates';
  }
  const p = gitParse(g);
  const ctx = io0.ctx;
  const exists = (w) => {
    if (typeof ctx.exists !== 'function') return true;
    const r = io.resolve(w);
    return r === UNKNOWN || (isStr(r) && ctx.exists(r));
  };
  for (const f of p.vals('--output')) io.write(f);
  // pathspecs: everything after `--`, and an operand that names an existing file (anything else
  // is a ref)
  const dash = g.rest.indexOf('--');
  const after = dash < 0 ? [] : g.rest.slice(dash + 1);
  const before = dash < 0 ? p : parseArgs([sub, ...g.rest.slice(0, dash)], GIT_SPECS[sub] || {});
  const pathWords = () => [...after, ...before.operands.filter((o) => o === UNKNOWN || exists(o))];
  switch (sub) {
    case 'clone': {
      const [url, dest] = p.operands;
      io.write(dest !== undefined ? dest : url === undefined ? UNKNOWN : repoDirName(url));
      return undefined;
    }
    case 'init':
      io.write(p.operands[0] ?? '.');
      return undefined;
    case 'rm':
      p.operands.forEach(io.write);
      return 'mutates';
    case 'mv':
      p.operands.forEach(io.rw);
      return 'mutates';
    case 'clean':
      if (p.operands.length === 0) io.write('.');
      else p.operands.forEach(io.write);
      return 'mutates';
    case 'add':
      p.operands.forEach(io.read);
      if (p.operands.length === 0 && p.has('A', 'u', '--all', '--update')) io.read('.');
      return 'mutates';
    case 'apply':
    case 'am':
      p.operands.forEach(io.read);
      return 'mutates';
    case 'config': {
      // the file it reads or writes: --file F, --global (~/.gitconfig), --system (/etc/gitconfig)
      const writes = gitWrites(g, p);
      const touch = (w) => (writes ? io.write(w) : io.read(w));
      for (const f of p.vals('f', '--file')) touch(f);
      if (p.longLike('global')) {
        const home = ctx.home;
        touch(isStr(home) && home.startsWith('/') ? `${home.replace(/\/+$/, '')}/.gitconfig` : UNKNOWN);
      }
      if (p.longLike('system')) touch('/etc/gitconfig');
      return writes ? 'mutates' : undefined;
    }
    case 'worktree':
      if (WORKTREE_WRITE_VERBS.includes(p.operands[0])) p.operands.slice(1).forEach(io.write);
      break;
    case 'submodule':
      if (p.operands[0] === 'add') p.operands.slice(1).forEach(io.write);
      break;
    default:
      break;
  }
  // `rev:path` names a file's contents in history
  if (['show', 'cat-file', 'diff', 'log'].includes(sub)) {
    for (const o of p.operands) {
      if (!isStr(o) || SCHEME.test(o)) continue;
      const colon = o.indexOf(':');
      if (colon > 0 && colon < o.length - 1) io.read(o.slice(colon + 1));
    }
  }
  if (GIT_PATH_RW.has(sub)) pathWords().forEach(io.rw);
  else if (GIT_PATH_READ.has(sub)) pathWords().forEach(io.read);
  return gitWrites(g, p) ? 'mutates' : undefined;
}

def('git', {
  classes: (p, call) => gitClasses(gitSplit(call.argv)),
  domains: (p, out, call) => gitDomains(gitSplit(call.argv), out),
  fx: (p, io, call) => gitFx(gitSplit(call.argv), io, call),
  ops: (call) => {
    const g = gitSplit(call.argv);
    if (g.sub !== 'clean' && g.sub !== 'rm') return [];
    const base = gitBase(g.chdirs);
    const p = gitParse(g);
    const at = (w) => (base === undefined || (isStr(w) && w.startsWith('/')) ? w : base === UNKNOWN ? UNKNOWN : w === '.' ? base : `${base}/${w}`);
    const targets = p.operands.length > 0 ? p.operands : g.sub === 'clean' ? ['.'] : [];
    return targets.map((path) => ({ path: at(path), op: 'delete' }));
  },
});

// Other version control systems: the sub-commands that change the repository, and those that
// talk to a server.
const OTHER_VCS = {
  svn: {
    writes: words('commit ci import delete del remove rm move mv rename ren copy cp merge revert resolve switch sw update up checkout co lock unlock propset ps propedit pe propdel pd mkdir cleanup upgrade patch changelist'),
    network: words('commit ci import checkout co update up switch sw export lock unlock'),
  },
  hg: {
    writes: words('commit ci push pull update up merge rebase strip backout revert rollback graft import tag bookmark histedit clone shelve unshelve amend'),
    network: words('push pull clone incoming outgoing fetch'),
  },
  jj: {
    writes: words('commit describe desc squash rebase abandon new edit restore split diffedit resolve bookmark b git undo redo'),
    network: [],
  },
};
for (const name of Object.keys(OTHER_VCS)) {
  const t = OTHER_VCS[name];
  const isNet = (p) => {
    const sub = p.operands[0];
    if (sub === UNKNOWN || p.hasUnknown) return true;
    if (name === 'jj') return sub === 'git' && ['push', 'fetch', 'clone'].includes(p.operands[1]);
    return t.network.includes(sub) || p.operands.some((o) => isStr(o) && SCHEME.test(o));
  };
  def(name, {
    classes: (p) => {
      const sub = p.operands[0];
      const out = [];
      if (sub === UNKNOWN || p.hasUnknown || t.writes.includes(sub)) out.push('vcs-write');
      if (isNet(p)) out.push('network-fetch');
      return out;
    },
    domains: (p, out) => {
      if (!isNet(p)) return;
      let any = false;
      for (const o of p.operands) {
        if (isStr(o) && SCHEME.test(o)) {
          const d = urlDomain(o);
          if (d !== null) out.push(d);
          any = true;
        }
      }
      if (!any || p.hasUnknown) out.push(UNKNOWN);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Rows: shells. `-c CODE` is code (re-parsed by the normalizer), not a path; a script file operand
// is read (the normalizer reads it too); the words after the code or the file are the script's own
// arguments, which it may use as paths (read and written, as for an unmodeled program). `-o NAME`
// and `-O NAME` take an option name; an UNKNOWN word where an option could stand is UNKNOWN.

function shellFx(argv, io) {
  let i = 1;
  let code = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      io.rw(UNKNOWN);
      continue;
    }
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a.startsWith('--')) continue;
    if (a.length < 2 || (a[0] !== '-' && a[0] !== '+')) break;
    for (let k = 1; k < a.length; k++) {
      if (a[k] === 'c') code = true;
      else if (a[k] === 'o' || a[k] === 'O') i++;
    }
  }
  if (i < argv.length) {
    if (code) i++; // the code word
    else if (isStr(argv[i]) && argv[i] !== '') io.read(argv[i++]); // the script file
  }
  for (; i < argv.length; i++) io.rw(argv[i]);
  return 'mutates';
}
def('sh bash zsh dash ksh', { fx: (_p, io, call) => shellFx(call.argv, io) });

// ---------------------------------------------------------------------------------------------
// Rows: package managers

function installClasses(name, p) {
  const m = PACKAGE_MANAGERS[name];
  const add = () => (m.code ? ['package-install', 'runs-repo-code'] : ['package-install']);
  if (m.always) return add();
  if ((m.shortFlags || []).some((f) => p.has(f)) || (m.longFlags || []).some((f) => p.has(f) || p.longLike(f.slice(2)))) return add();
  const subs = new Set(words(m.subs || ''));
  const first = p.operands.slice(0, 2);
  const considered = first.length > 0 && NOT_INSTALL_FIRST.has(first[0]) ? first.slice(0, 1) : first;
  if (considered.some((o) => o === UNKNOWN || subs.has(o))) return add();
  if ((m.pairs || []).some((pair) => {
    const [a, b] = pair.split(' ');
    return first[0] === a && first[1] === b;
  })) return add();
  if (m.bare && p.operands.length === 0 && !p.hasUnknown) return add();
  return [];
}
for (const name of Object.keys(PACKAGE_MANAGERS)) {
  def(name, {
    classes: (p) => {
      const out = installClasses(name, p);
      // `npm init <initializer>` and `npm audit fix` install; `npm init -y` does not
      if (name === 'npm' && ((p.operands[0] === 'init' && p.operands.length > 1) || (p.operands[0] === 'audit' && p.operands[1] === 'fix'))) {
        out.push('package-install', 'runs-repo-code');
      }
      return out;
    },
  });
}
def('python', {
  classes: (p, call) => {
    const argv = call.argv;
    // `python -m pip install x`, `python -mpip install x`
    const m = argv.findIndex((a, i) => i > 0 && (a === '-m' || (isStr(a) && /^-[A-Za-z]*mpip$/.test(a))));
    if (m >= 0) {
      const attached = argv[m] !== '-m';
      if (attached || /^pip[0-9.]*$/.test(argv[m + 1])) return installClasses('pip', parseArgs(['pip', ...argv.slice(attached ? m + 1 : m + 2)], {}));
    }
    // `python setup.py install` / `develop`
    const s = argv.findIndex((a) => isStr(a) && /(?:^|\/)setup\.py$/.test(a));
    if (s >= 0 && argv.slice(s + 1).some((a) => a === UNKNOWN || a === 'install' || a === 'develop')) return ['package-install'];
    return [];
  },
});

// ---------------------------------------------------------------------------------------------
// Rows: known runners and tools. Their sub-command words and plain positionals (`npm test`,
// `make build`, `cargo build`, `go test ./...`) are not file names; a script, a file or a build
// context is a read; a path-looking word (a `/`, a leading `.` or `~`) stays a read and write
// unless the tool reads its operands only; flags with file values (`-f x.yaml`, `--out=FILE`,
// `-oFILE`) are followed. A program with no row keeps the unmodeled rule.

const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const HAS_EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const DOMAIN_FIRST = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\//;

// Does a word of a known tool look like a path? `ext`: a file name with an extension does too.
function toolPath(word, ext) {
  let w = word;
  if (w === '' || w === '-' || w === '...' || w === './...') return null; // go package patterns
  if (w.endsWith('/...')) w = w.slice(0, -4);
  if (URL_LIKE.test(w) || w.startsWith('@')) return null; // a URL, an npm scope
  if (w.startsWith('.') || w.startsWith('~') || w.startsWith('/')) return w;
  if (w.includes('/')) return DOMAIN_FIRST.test(w) ? null : w; // github.com/x/y, gcr.io/p/i are not paths
  return ext && HAS_EXT.test(w) ? w : null;
}

// An io whose paths that start with `~/` are also recorded with the home directory expanded: the
// shell leaves a ~ alone inside `@~/file` or `source=~/dir`, but a tool may expand it.
function homeAware(io0) {
  const home = io0.ctx.home;
  const wrap = (f) => (w) => {
    f(w);
    if (isStr(w) && w.startsWith('~/') && isStr(home) && home.startsWith('/')) f(`${home.replace(/\/+$/, '')}/${w.slice(2)}`);
  };
  return { ...io0, read: wrap(io0.read), write: wrap(io0.write), rw: wrap(io0.rw) };
}

// The host paths a docker/podman volume flag mounts: `-v SRC:DST[:opts]` (SRC when it is a path, not
// a volume name) and `--mount type=bind,source=SRC,target=DST` (source= / src=).
const hostLike = (w) => w.startsWith('/') || w.startsWith('.') || w.startsWith('~');
function volumeHosts(v, flag) {
  if (v === UNKNOWN || !isStr(v)) return [UNKNOWN];
  if (flag === '--mount') {
    const out = [];
    for (const part of v.split(',')) {
      const m = /^(?:source|src)=(.*)$/.exec(part);
      if (m && hostLike(m[1])) out.push(m[1]);
    }
    return out;
  }
  const src = v.split(':')[0];
  return src !== '' && hostLike(src) ? [src] : [];
}

// `docker build -o DIR`, `--output type=local,dest=DIR`, `docker save -o FILE`, `docker export -o FILE`.
function outputTargets(v) {
  if (v === UNKNOWN || !isStr(v)) return [UNKNOWN];
  if (!v.includes('=')) return [v];
  const out = [];
  for (const part of v.split(',')) {
    const m = /^dest=(.*)$/.exec(part);
    if (m) out.push(m[1]);
  }
  return out;
}

// How a known tool's operands are read (controller ruling, fix round 3: the policy is inverted).
// An operand is skipped (not a file) ONLY when it is
//   (a) the sub-command word itself, taken from the program's explicit `safe` list, or
//   (b) a plain target/name word directly after a safe sub-command whose grammar is known:
//       `safe[sub]` says how many (1 for `npm run <script>`, INF for `cargo build <pkg>...`,
//       `go test <pkg>...`, `docker <verb> <name>...`, `npm install <pkg>...`); `noSub` programs
//       (make, ninja, gradle, mvn) take plain targets from the first word.
// Everything else is read AND written like an unmodeled program's words: a sub-command that is
// not on the list, a word beyond the known targets, every word after `--`, and everything after a
// code-running sub-command (`runs`: npm exec, pnpm dlx, go run, cargo run, deno run, uv run, ...,
// where `runs[sub]` is how many leading plain program names to skip, `runner` for npx and friends).
// A path-looking word (a `/`, a leading `.` or `~`) is always a path.
const INF = Infinity;
const infMap = (names, zero = '', one = '') => ({
  ...Object.fromEntries(words(names).map((n) => [n, INF])),
  ...Object.fromEntries(words(zero).map((n) => [n, 0])),
  ...Object.fromEntries(words(one).map((n) => [n, 1])),
});

function toolFx(spec) {
  return (p, io0, call) => {
    const io = homeAware(io0);
    const rd = spec.read || [];
    const wr = spec.write || [];
    const ops = p.operands;
    const before = p.dashAt >= 0 ? ops.slice(0, p.dashAt) : ops;
    const after = p.dashAt >= 0 ? ops.slice(p.dashAt) : [];
    const subHere = !spec.readOnlySubs || spec.readOnlySubs.includes(before[0]);
    for (const v of p.vals(...rd)) io.read(v);
    if (subHere) for (const v of p.vals(...(spec.readInSubs || []))) io.read(v);
    else {
      // outside the verbs where it names a file (`kubectl logs -f POD`, `docker run -c 512`) the
      // word it took is an ordinary word: a path when it looks like one, read and written after a
      // verb that is not on the safe list
      const safeSub = isStr(before[0]) && spec.safe && Object.hasOwn(spec.safe, before[0]);
      for (const v of p.vals(...(spec.readInSubs || []))) {
        if (!isStr(v)) io.rw(UNKNOWN);
        else if (!safeSub) io.rw(v);
        else if (toolPath(v, false) !== null) io.rw(toolPath(v, false));
      }
    }
    for (const v of p.vals(...wr)) for (const t of spec.mapWrite ? spec.mapWrite(v) : [v]) io.write(t);
    // docker/podman volumes: the host side is read and written (bind mounts are writable)
    const vol = spec.volumes || [];
    for (const v of p.values) {
      if (!vol.includes(v.flag)) continue;
      for (const h of volumeHosts(v.value, v.flag)) io.rw(h);
    }
    const inlineCode = spec.inline && p.has(...spec.inline);
    const rewrites = spec.writeFlags && p.has(...spec.writeFlags);
    const reading = (spec.operandsRead || (spec.readSubs && spec.readSubs.includes(before[0]))) && !rewrites;
    const touch = (w) => (reading ? io.read(w) : io.rw(w));
    const bareName = (w) => toolPath(w, true) === null; // no `/`, no leading . or ~, no file extension
    // a word right after an option the row does not list (as taking a value or as a flag) may be
    // that option's value: read and written, never skipped as a target or a program name
    const optValue = (j) => p.afterOpt.has(j);
    // `go test ... -args ARGS`: every word after -args goes to the test binary
    const argsAt = spec.argsRest ? call.argv.findIndex((a, k) => k > 0 && spec.argsRest.includes(a)) : -1;
    const passed = (j) => argsAt >= 0 && p.opArgv[j] > argsAt;
    // a word after a bare `--`: a dash word is an option of the program that receives it (its
    // `=value` is read and written); every other word is read and written
    const passOn = (w) => {
      if (!isStr(w) || w[0] !== '-') io.rw(w);
      else if (w.includes('=')) io.rw(w.slice(w.indexOf('=') + 1));
    };

    if (spec.script) {
      // the script is a read; every argument after it (or after -m MODULE / -e CODE) is read and
      // written: nothing proves the script only reads its arguments
      ops.forEach((o, i) => {
        if (p.dashAt >= 0 && i >= p.dashAt) passOn(o);
        else if (i === 0 && !inlineCode && !optValue(0)) io.read(o);
        else io.rw(o);
      });
    } else if (spec.operandsRead) {
      // test runners and linters: every operand is a file they read (written with --fix / --write)
      before.forEach((o, j) => (o === UNKNOWN || optValue(j) ? io.rw(o) : touch(o)));
      after.forEach(passOn);
    } else {
      let i = 0;
      let skip = 0; // plain target words still to skip
      let nameSkip = 0; // leading program names of a code-running sub-command
      let readArgs = false; // plain words after the sub-command are files it reads (terraform apply PLAN)
      const sub = optValue(0) ? undefined : before[0]; // a word after an unlisted option is no sub-command
      const nested = isStr(sub) && spec.nestedRuns && Object.hasOwn(spec.nestedRuns, sub) ? spec.nestedRuns[sub] : null;
      if (spec.runner) nameSkip = 1;
      else if (spec.noSub) skip = INF;
      else if (nested && isStr(before[1]) && !optValue(1) && Object.hasOwn(nested, before[1])) {
        i = 2; // uv tool run NAME ..., dotnet tool run NAME ...
        nameSkip = nested[before[1]];
      } else if (isStr(sub) && spec.safe && Object.hasOwn(spec.safe, sub)) {
        i = 1;
        skip = spec.safe[sub];
        readArgs = (spec.readArgs || []).includes(sub);
      } else if (isStr(sub) && spec.runs && Object.hasOwn(spec.runs, sub)) {
        i = 1;
        nameSkip = spec.runs[sub];
      }
      for (let j = i; j < before.length; j++) {
        const o = before[j];
        if (o === UNKNOWN || optValue(j) || passed(j)) {
          io.rw(o);
          continue;
        }
        if (nameSkip > 0 && bareName(o)) {
          nameSkip--; // the program a runner starts
          continue;
        }
        const path = toolPath(o, false);
        if (path !== null) touch(path); // a path is a path wherever it stands
        else if (readArgs) io.read(o);
        else if (skip > 0) skip--; // a plain target of a known sub-command
        else io.rw(o); // beyond the grammar, an unknown sub-command, code-running arguments: unmodeled
      }
      after.forEach(passOn);
    }
    if (argsAt >= 0) {
      // flags after -args belong to the test binary too: their values are read and written
      for (const a of call.argv.slice(argsAt + 1)) {
        if (!isStr(a)) io.rw(UNKNOWN);
        else if (a.startsWith('-') && a.includes('=')) io.rw(a.slice(a.indexOf('=') + 1));
        else if (!a.startsWith('-')) io.rw(a);
      }
    }
    // the value of any other option that looks like a path (--out=FILE, --target-dir /tmp/t); the
    // `--opt=value` of an option the row does not list is read and written whatever it looks like
    const skipFlags = [...rd, ...wr, ...vol, ...(spec.readInSubs || []), ...(spec.inline || [])];
    const listed = (f) => (f.length === 1 ? (spec.short || '').includes(f) : (spec.long || []).includes(f));
    for (const v of p.values) {
      if (skipFlags.includes(v.flag)) continue;
      if (v.value === UNKNOWN) io.rw(UNKNOWN);
      else if (!listed(v.flag)) {
        if (v.value !== '') io.rw(v.value);
      } else {
        const w = toolPath(v.value, false);
        if (w !== null) touch(w);
      }
    }
    // a short option with an attached value (-oFILE, -o=FILE)
    for (const a of spec.singleDash ? [] : call.argv.slice(1)) {
      if (!isStr(a) || a.length < 3 || a[0] !== '-' || a[1] === '-') continue;
      if (spec.script && inlineCode) continue; // -e CODE / -c CODE: the code is not a path
      const w = toolPath(a[2] === '=' ? a.slice(3) : a.slice(2), false);
      if (w !== null) touch(w);
    }
    return 'mutates';
  };
}

// gh. Nouns and verbs are grammar words. A listing/viewing verb (or a noun like `api`, `auth`) keeps
// bare words as non-paths; `gist create|edit` and `release upload|create` take FILE operands (reads);
// `repo|gist clone` writes its target; every other verb falls back to the unmodeled rule.
const GH_NOUNS = new Set(words('pr issue run repo release gist workflow auth status api search browse config alias extension label project cache secret variable ruleset codespace ssh-key gpg-key org completion help version attestation'));
const GH_PLAIN_NOUNS = new Set(words('api auth status search browse config alias completion help version'));
const GH_VERBS = new Set(words('list ls view status checks diff watch create edit comment close reopen merge ready review checkout delete rename fork clone sync download upload archive unarchive set remove enable disable cancel rerun lock unlock pin unpin transfer develop refresh login logout setup-git token switch install upgrade'));
const GH_SAFE_VERBS = new Set(words('list ls view status checks diff watch close reopen merge comment ready review rerun cancel checkout'));
const GH_FILE_OPERANDS = { gist: ['create', 'edit'], release: ['upload', 'create'] };
const ghPath = (w) => isStr(w) && !URL_LIKE.test(w) && (w.startsWith('.') || w.startsWith('~') || w.startsWith('/'));
function ghFx(p, io0) {
  const io = homeAware(io0);
  for (const v of p.vals('D', '--dir', 'o', '--output', 'O')) io.write(v);
  for (const v of p.vals('--input', '--body-file', '--notes-file')) io.read(v);
  for (const v of p.values) {
    if (!['F', '--field', 'f', '--raw-field'].includes(v.flag)) continue;
    if (!isStr(v.value)) io.read(v.value);
    else {
      const m = /^[^=]*=@(.*)$/.exec(v.value);
      if (m) io.read(m[1]);
      else if (!v.value.includes('=') && (v.flag === 'F' || v.flag === '--field')) io.read(v.value); // -F FILE: a body file
    }
  }
  const ops = p.operands;
  const noun = isStr(ops[0]) && GH_NOUNS.has(ops[0]) ? ops[0] : null;
  const verb = noun !== null && !GH_PLAIN_NOUNS.has(noun) && isStr(ops[1]) && GH_VERBS.has(ops[1]) ? ops[1] : null;
  const rest = ops.slice((noun === null ? 0 : 1) + (verb === null ? 0 : 1));
  if (noun !== null && GH_PLAIN_NOUNS.has(noun)) {
    // gh api / auth / status / ...: the words are endpoints and names; only path-looking ones are paths
    for (const o of rest) if (o === UNKNOWN) io.rw(UNKNOWN);
    for (const o of ops) if (ghPath(o)) io.rw(o);
  } else if ((noun === 'repo' || noun === 'gist') && verb === 'clone') {
    if (rest.length >= 2) io.write(rest[rest.length - 1]);
    else if (rest.length === 1) io.write(rest[0] === UNKNOWN ? UNKNOWN : repoDirName(rest[0]));
    for (const o of rest.slice(0, -1)) if (ghPath(o) || o === UNKNOWN) io.rw(o);
  } else if (noun === 'repo' && verb === 'fork') {
    const repo = rest.find((o) => isStr(o) && !o.startsWith('-'));
    if (p.has('--clone') || p.longLike('clone')) io.write(repo === undefined ? UNKNOWN : repoDirName(repo));
    for (const o of rest) if (ghPath(o) || o === UNKNOWN) io.rw(o);
  } else if (noun !== null && verb !== null && (GH_FILE_OPERANDS[noun] || []).includes(verb)) {
    for (const o of rest) io.read(o); // files to upload
  } else if (verb !== null && GH_SAFE_VERBS.has(verb)) {
    for (const o of rest) if (ghPath(o) || o === UNKNOWN) io.rw(o);
  } else {
    for (const o of rest) io.rw(o); // an unknown verb, or no known grammar: the unmodeled rule
  }
  return 'mutates';
}

const SCRIPT = { script: true };
// `flags`: options known to take no value (so the next word keeps its place in the grammar). Any
// other option the row does not list in `short`/`long` may take the next word as its value.
const MAKE = {
  noSub: true,
  short: 'fCIW',
  long: L('file makefile directory include-dir what-if'),
  read: ['f', 'I', 'W', '--file', '--makefile', '--include-dir', '--what-if'],
  write: ['C', '--directory'],
  flags: '-k -n -s -q -B -e -i -r -R -S -t -w -p -d -j --keep-going --dry-run --just-print --silent --quiet --always-make --question --ignore-errors --print-directory --no-print-directory --jobs',
};
const DOCKER_VERBS = 'ps images pull push logs stop start restart kill rm rmi inspect stats top port tag login logout info version search network volume system container image builder context events diff pause unpause wait rename update attach history commit run exec build buildx compose stack create manifest plugin swarm service node secret config trust scan save export up down';
const DOCKER = {
  short: 'fovOcepuwm',
  long: L('file env-file output volume mount compose-file env publish name user workdir network entrypoint platform tag label build-arg target restart hostname format filter tail since memory project-name profile'),
  flags: '-a -d -i -t -q -P -s -l --rm --detach --interactive --tty --all --quiet --privileged --init --no-cache --pull --build --remove-orphans --force-recreate --no-deps --follow --latest --force',
  safe: infMap(DOCKER_VERBS),
  read: ['--env-file'],
  readInSubs: ['f', '--file', 'c', '--compose-file'],
  readOnlySubs: ['build', 'buildx', 'compose', 'stack'],
  write: ['o', '--output'],
  mapWrite: outputTargets,
  volumes: ['v', '--volume', '--mount'],
  readSubs: ['build', 'buildx'],
};
const RUNNER = { runner: true, short: 'p', long: L('package from with python'), flags: '-y -q --yes --quiet --no' };
const GRADLE = { noSub: true, short: 'x', flags: '-q -i -d -s -S --info --debug --stacktrace --scan --offline --no-daemon --daemon --parallel --continue --refresh-dependencies --build-cache' };
const MVN = { noSub: true, short: 'f', long: L('file'), read: ['f', '--file'], flags: '-q -B -U -o -e -X --batch-mode --quiet --offline' };
const JS_TEST = { operandsRead: true, flags: '-i -u --watch --coverage --runInBand --ci --silent --verbose --bail' };
const PM_SAFE = 'install i add remove rm uninstall un update up upgrade list ls outdated audit why config cache prune rebuild link unlink dedupe fetch import licenses publish pack store info view init';
const TOOLS = {
  npm: {
    short: 'Cw',
    long: L('prefix workspace omit registry tag loglevel'),
    write: ['C', '--prefix'],
    flags: '-D -S -g -E -O -P -B -y -s -f -q --save-dev --save --global --save-exact --no-save --legacy-peer-deps --force --silent --production --workspaces --ignore-scripts --dry-run --yes --if-present',
    safe: infMap(
      'install i in ins inst insta instal isnt isnta isntal isntall add ci clean-install ic install-clean uninstall remove rm un unlink r update up upgrade udpate ls list ll la outdated view v info show search s find audit fund doctor ping whoami login logout adduser publish unpublish pack prune dedupe ddp rebuild rb link ln version config c cache help h docs home bugs repo prefix root bin explain why org team access owner token star stars unstar dist-tag deprecate profile hook completion diff query',
      'test t tst start stop restart init',
      'run run-script rum urn',
    ),
    runs: { exec: 1, x: 1 },
  },
  yarn: { long: L('cwd'), write: ['--cwd'], flags: '-D -E -P -O -W -s --dev --exact --peer --optional --frozen-lockfile --immutable --silent --ignore-workspace-root-check', safe: infMap(PM_SAFE + ' check global workspaces autoclean generate-lock-entry', 'build test start dev lint format typecheck', 'run'), runs: { dlx: 1, exec: 1 } },
  pnpm: { short: 'CF', long: L('dir prefix filter'), write: ['C', '--dir', '--prefix'], flags: '-D -O -g -r -E -P -s --save-dev --frozen-lockfile --recursive --global --save-exact --silent', safe: infMap(PM_SAFE + ' store setup', 'test t start dev build lint format typecheck', 'run'), runs: { exec: 1, dlx: 1 } },
  bun: { flags: '-d -D -g -E --dev --global --exact --frozen-lockfile --production', safe: infMap('install i add a remove rm update upgrade pm link unlink outdated'), runs: { run: 1, x: 1 } },
  npx: RUNNER,
  pnpx: RUNNER,
  bunx: RUNNER,
  uvx: RUNNER,
  pip: {
    short: 'rcetdw',
    long: L('requirement constraint editable target prefix root dest wheel-dir src'),
    read: ['r', 'c', '--requirement', '--constraint'],
    write: ['t', 'd', 'w', '--target', '--prefix', '--root', '--dest', '--wheel-dir', '--src'],
    flags: '-U -q -v -I --upgrade --user --no-deps --force-reinstall --pre --no-cache-dir --quiet --verbose --break-system-packages --dry-run --ignore-installed',
    safe: infMap('install list show uninstall freeze download check search config cache help inspect wheel index debug'),
  },
  pipx: { flags: '-f --force --include-deps', safe: infMap('install list uninstall upgrade upgrade-all reinstall reinstall-all inject ensurepath environment'), runs: { run: 1 } },
  uv: {
    short: 'rcp',
    long: L('requirement constraint directory project target python with from index-url extra-index-url package'),
    read: ['r', 'c', '--requirement', '--constraint'],
    write: ['--directory', '--project', '--target'],
    flags: '-q -v -U --frozen --locked --no-sync --system --dev --all-extras --offline --upgrade --native-tls --no-dev --isolated --no-project',
    safe: infMap('pip add remove sync lock venv tool python self cache version help build publish tree export', 'init'),
    runs: { run: 1 },
    nestedRuns: { tool: { run: 1 } },
  },
  poetry: {
    short: 'CGE',
    long: L('directory group with without only extras'),
    write: ['C', '--directory'],
    flags: '-D -n -q -v --dev --no-root --no-interaction --dry-run --sync --lock --no-update',
    safe: infMap('add remove install update lock show build publish check config env version self cache search export'), runs: { run: 1 } },
  pipenv: { flags: '-d --dev', safe: infMap('install uninstall update sync lock graph check clean'), runs: { run: 1 } },
  conda: { short: 'cn', flags: '-y -q --yes --quiet', safe: infMap('install create remove uninstall update upgrade list search info config env clean activate deactivate init'), runs: { run: 1 } },
  mamba: { short: 'cn', flags: '-y -q --yes --quiet', safe: infMap('install create remove uninstall update upgrade list search info config env clean activate deactivate init'), runs: { run: 1 } },
  micromamba: { short: 'cn', flags: '-y -q --yes --quiet', safe: infMap('install create remove uninstall update upgrade list search info config env clean activate deactivate init'), runs: { run: 1 } },
  gem: {
    short: 'invs',
    long: L('install-dir bindir version source'),
    write: ['i', 'n', '--install-dir', '--bindir'],
    flags: '-N -f -q --no-document --user-install --force --conservative --pre --quiet',
    safe: infMap('install uninstall update list search info outdated cleanup sources env help'),
  },
  bundle: { safe: infMap('install add remove update outdated list show info check config lock'), runs: { exec: 1 } },
  bundler: { safe: infMap('install add remove update outdated list show info check config lock'), runs: { exec: 1 } },
  composer: {
    short: 'd',
    long: L('working-dir'),
    write: ['d', '--working-dir'],
    flags: '-n -o -q -v --dev --no-dev --no-interaction --prefer-dist --prefer-source --optimize-autoloader --no-scripts --no-progress',
    safe: infMap('install require remove update outdated show search validate dump-autoload'), runs: { 'run-script': 1 } },
  dotnet: {
    short: 'ocfrv',
    long: L('output configuration framework runtime verbosity'),
    write: ['o', '--output'],
    flags: '-g --global --no-restore --no-build --nologo',
    safe: infMap('build test restore clean publish pack add list nuget tool sdk'),
    runs: { run: 0 },
    nestedRuns: { tool: { run: 1, exec: 1, execute: 1 } },
  },
  deno: { safe: infMap('info help', '', 'task'), runs: { run: 0 } },
  pod: { safe: infMap('install update repo') },
  mix: { safe: infMap('deps.get compile test'), runs: { run: 0 } },
  brew: { flags: '-f -q -v --cask --formula --force --quiet --verbose --HEAD', safe: infMap('install reinstall uninstall remove upgrade update list info search tap untap cleanup doctor services outdated leaves deps uses') },
  apt: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install reinstall remove purge autoremove update upgrade full-upgrade dist-upgrade list search show info clean autoclean build-dep') },
  'apt-get': { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install reinstall remove purge autoremove update upgrade dist-upgrade clean autoclean build-dep') },
  aptitude: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install reinstall remove purge update upgrade safe-upgrade full-upgrade search show') },
  dnf: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install reinstall remove upgrade update list search info clean localinstall groupinstall') },
  yum: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install reinstall remove upgrade update list search info clean localinstall groupinstall') },
  zypper: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install in remove rm update up dist-upgrade search info list-updates') },
  apk: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('add del upgrade update search info') },
  snap: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install remove refresh list info find') },
  flatpak: { flags: '-y -q -f --yes --assume-yes --assumeyes --no-install-recommends --fix-broken --quiet', safe: infMap('install uninstall update list info search') },
  go: {
    singleDash: true,
    long: L('C o p f coverprofile cpuprofile memprofile blockprofile mutexprofile trace outputdir modfile overlay exec pkgdir count run skip bench benchtime timeout tags ldflags gcflags asmflags mod parallel cpu shuffle covermode coverpkg'),
    write: ['--C', '--o', '--coverprofile', '--cpuprofile', '--memprofile', '--blockprofile', '--mutexprofile', '--trace', '--outputdir', '--pkgdir'],
    read: ['--modfile', '--overlay', '--exec'],
    flags: '--v --x --n --a --u --i --d --t --c --race --cover --short --failfast --json --trimpath --modcacherw --msan --asan --benchmem',
    safe: infMap('build test vet list get install doc env version mod clean help work generate'),
    runs: { run: 0, tool: 1 },
    argsRest: ['-args', '--args'],
  },
  cargo: {
    short: 'pFj',
    long: L('manifest-path root target-dir path package features bin example target jobs profile test bench'),
    read: ['--manifest-path', '--path'],
    write: ['--root', '--target-dir', '--path'],
    flags: '-q -v -r --release --locked --offline --frozen --all-features --workspace --all-targets --verbose --quiet --force --no-default-features',
    safe: infMap('build b check c test t bench clippy doc fetch update add remove install uninstall search tree metadata clean publish login version help fmt'), runs: { run: 0, r: 0 } },
  make: MAKE,
  gmake: MAKE,
  gradle: GRADLE,
  gradlew: GRADLE,
  mvn: MVN,
  mvnw: MVN,
  sbt: { noSub: true },
  ninja: { noSub: true, short: 'Cfjkt', read: ['f'], write: ['C'], flags: '-v -n' },
  cmake: { noSub: true, short: 'SBj', long: L('build install target config parallel'), read: ['S'], write: ['B', '--build', '--install'], flags: '-v --verbose --fresh --clean-first' },
  terraform: {
    singleDash: true,
    long: L('out state state-out backup chdir var var-file lock-timeout parallelism target replace'),
    write: ['--out', '--state', '--state-out', '--backup', '--chdir'],
    read: ['--var-file', '--state', '--chdir'],
    flags: '--auto-approve --no-color --upgrade --reconfigure --migrate-state --refresh-only --destroy --json --compact-warnings',
    readArgs: ['apply', 'show'],
    safe: infMap('plan apply destroy init validate output show state workspace providers refresh version import taint untaint get graph login logout console') },
  docker: DOCKER,
  podman: { ...DOCKER, readOnlySubs: ['build'], readSubs: ['build'] },
  'docker-compose': { short: 'fvp', long: L('file env-file volume project-name profile'), flags: '-d -q --detach --build --remove-orphans --force-recreate --no-deps --rm', read: ['f', '--file', '--env-file'], volumes: ['v', '--volume'], safe: infMap('up down ps logs build pull push stop start restart rm config exec run create kill images pause unpause port top version') },
  kubectl: {
    short: 'fnolc',
    long: L('filename kubeconfig namespace output selector container context'),
    flags: '-A -w -R --all-namespaces --watch --all --force --recursive',
    read: ['--kubeconfig'],
    // -f is --filename for these verbs; for logs it is --follow, and port-forward, exec, attach, cp,
    // top and events take no file
    readInSubs: ['f', '--filename'],
    readOnlySubs: words('get describe apply delete create edit patch rollout scale diff label annotate expose autoscale wait replace set kustomize'), safe: infMap('get describe logs apply delete create edit patch rollout scale top config version api-resources api-versions explain diff label annotate cordon uncordon drain taint expose autoscale auth wait port-forward events kustomize replace set') },
  helm: { short: 'fn', long: L('values kubeconfig namespace set set-string version repo'), flags: '-i --create-namespace --wait --atomic --dry-run --debug --install --devel', read: ['f', '--values', '--kubeconfig'], safe: infMap('list ls install upgrade uninstall status repo search show get template lint history rollback version env') },
  gh: { fx: ghFx, short: 'RHqtFfDoObBmpAXn', long: L('hostname repo method header field raw-field input jq template body-file notes-file dir output pattern base head title body') },
  // interpreters: the first operand is the script (a read); every argument after it is read and written
  node: {
    ...SCRIPT,
    short: 'epr',
    long: L('eval print require import loader experimental-loader input-type env-file conditions'),
    inline: ['e', 'p', '--eval', '--print'],
    read: ['r', '--require', '--import', '--env-file'],
    flags: '--test --watch --inspect --inspect-brk --no-warnings --enable-source-maps --trace-warnings --experimental-vm-modules --expose-gc',
  },
  python: { ...SCRIPT, short: 'cmWXQ', inline: ['c', 'm'], flags: '-u -B -O -I -E -s -S -v -q -b -d -i' },
  ruby: { ...SCRIPT, short: 'eIr', inline: ['e'], flags: '-w -v -d' },
  perl: { ...SCRIPT, short: 'eEIM', inline: ['e', 'E'], flags: '-w -n -p -s -T' },
  php: { ...SCRIPT, short: 'rd', inline: ['r'], flags: '-n -q' },
  tsx: { ...SCRIPT, flags: '--watch' },
  'ts-node': { ...SCRIPT },
  // test runners and linters: every operand is a file they read
  pytest: { operandsRead: true, short: 'kmcpo', read: ['c'], flags: '-v -q -x -s -l --lf --ff --verbose --quiet --exitfirst --last-failed --failed-first --no-header --pdb' },
  jest: JS_TEST,
  vitest: JS_TEST,
  mocha: JS_TEST,
  tsc: { operandsRead: true, short: 'p', long: L('project outDir outFile'), read: ['p', '--project'], write: ['--outDir', '--outFile'], flags: '-w -b --noEmit --watch --build --strict --pretty --incremental' },
  eslint: { operandsRead: true, short: 'cfo', long: L('config format output-file ext ignore-path'), read: ['c', '--config', '--ignore-path'], write: ['o', '--output-file'], writeFlags: ['--fix'], flags: '--fix --cache --quiet --no-eslintrc --debug' },
  prettier: { operandsRead: true, long: L('config ignore-path'), read: ['--config', '--ignore-path'], writeFlags: ['w', '--write'], flags: '-c -w -l --check --write --list-different --cache' },
};
for (const [name, spec] of Object.entries(TOOLS)) {
  const prior = D.get(name);
  const known = words(spec.flags || '');
  const boolShort = known.filter((f) => /^-[^-]$/.test(f)).map((f) => f[1]).join('');
  const bool = known.filter((f) => f.startsWith('--'));
  D.set(name, { ...(prior || { classes: () => [] }), short: spec.short, long: spec.long, boolShort, bool, singleDash: spec.singleDash, fx: spec.fx || toolFx(spec) });
}

// ---------------------------------------------------------------------------------------------
// Public API

export { READ_ONLY as READ_ONLY_PROGRAMS };

/**
 * The classes a command carries (policy/classes.mjs names, in that order).
 * @param {(string|typeof UNKNOWN)[]} argv
 * @returns {string[]}
 */
export function classesOf(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const call = callOf(argv);
  if (call === null) return [...CLASS_NAMES];
  const out = new Set();
  const d = D.get(call.name);
  if (d && d.classes) for (const c of d.classes(parseArgs(call.argv, d), call)) out.add(c);
  for (const w of call.argv.slice(1)) {
    if (!isStr(w)) continue;
    if (wordHasEnviron(w)) out.add('env-dump');
    if (w.includes('/dev/tcp/') || w.includes('/dev/udp/')) out.add('network-fetch');
  }
  return CLASS_NAMES.filter((c) => out.has(c));
}

/**
 * The reads and writes of a command, as resolved absolute paths or UNKNOWN.
 * ctx = {resolve(word), isProtected(absPath), cwd, home, exists?(absPath)}
 */
export function fileEffects(argv, ctx) {
  const reads = [];
  const writes = [];
  if (!Array.isArray(argv) || argv.length === 0) return { reads, writes };
  const call = callOf(argv);
  const io = makeIo(ctx, reads, writes);
  if (call === null) {
    io.rw(UNKNOWN);
    return { reads: uniq(reads), writes: uniq(writes) };
  }
  const d = D.get(call.name);
  let mutates = false;
  if (d && d.fx) mutates = d.fx(parseArgs(call.argv, d), io, call) === 'mutates';
  else if (!NO_FILE_PROGRAMS.has(call.name)) {
    unmodeled(call.argv, io);
    mutates = true;
  }
  if (mutates) cwdWrite(io, ctx);
  return { reads: uniq(reads), writes: uniq(writes) };
}

// A program with no table: every non-flag word, and the value of --flag=value and of a short flag
// with an attached value (-oFILE), is read and written.
function unmodeled(argv, io) {
  let end = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!isStr(a)) {
      io.rw(UNKNOWN);
      continue;
    }
    if (end || a[0] !== '-') {
      io.rw(a);
      continue;
    }
    if (a === '--') {
      end = true;
      continue;
    }
    if (a === '-') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) io.rw(a.slice(eq + 1));
    } else if (a.length > 2) io.rw(a[2] === '=' ? a.slice(3) : a.slice(2));
  }
}

// The cwd counts as a write target when it is, or lies under, a protected path; an UNKNOWN cwd may.
function cwdWrite(io, ctx) {
  const cwd = io.resolve('.');
  if (!isStr(cwd)) io.writes.push(UNKNOWN);
  else if (typeof ctx.isProtected === 'function' && ctx.isProtected(cwd)) io.writes.push(cwd);
}

/**
 * The network hosts a command contacts.
 * @param {(string|typeof UNKNOWN)[]} argv
 * @returns {(string|typeof UNKNOWN)[]}
 */
export function domainsOf(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const call = callOf(argv);
  if (call === null) return [UNKNOWN];
  const out = [];
  const d = D.get(call.name);
  if (d && d.domains) d.domains(parseArgs(call.argv, d), out, call);
  for (const w of call.argv.slice(1)) {
    if (!isStr(w)) continue;
    const m = /\/dev\/(?:tcp|udp)\/([^/]*)/.exec(w);
    if (m) out.push(hostToDomain(m[1]));
  }
  return uniq(out);
}

/** Ancestor operations beyond the rm/mv/chmod/ln of ops.mjs: find -delete, rsync --delete, git clean. */
export function extraOps(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return [];
  const call = callOf(argv);
  const d = call === null ? undefined : D.get(call.name);
  return d && d.ops ? d.ops(call, parseArgs(call.argv, d)) : [];
}

/** True when the invocation cannot delete, overwrite, change permissions or write a file. */
export function writesNothing(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return true;
  const call = callOf(argv);
  if (call === null || (!READ_ONLY.has(call.name) && !NO_FILE_PROGRAMS.has(call.name))) return false;
  if (classesOf(argv).some((c) => c === 'delete' || c === 'overwrite' || c === 'perm-change' || c === 'privilege')) return false;
  return fileEffects(argv, { resolve: (w) => (isStr(w) ? w : UNKNOWN), isProtected: () => false }).writes.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Shared with tables/bulk.mjs (T18): the same program-name resolution and option grammars, so the
// bulk-writer table cannot read a command line differently from the file-effect rows above.

/** {name, argv, p}: the program (applets resolved) and argv parsed with its row's grammar, or with `spec`. null for an UNKNOWN program. */
export function parsedCall(argv, spec) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const call = callOf(argv);
  if (call === null) return null;
  const d = spec || D.get(call.name) || {};
  return { name: call.name, argv: call.argv, p: parseArgs(call.argv, d) };
}

export { parseArgs as parseOptions, gitSplit, gitBase, repoDirName };
