// Pure text rewriting for replay cases: test commands, work-path placeholders, prompts and commit references. No I/O except the injected exists(). node: built-ins only.
import { posix } from 'node:path';

export const TEST_RUNNERS = ['node --test', 'npm test', 'npm run test', 'pnpm test', 'yarn test', 'bun test', 'vitest', 'jest', 'pytest', 'go test', 'cargo test'];

// Command substitution, backticks and redirections in the kept runner segment; fd duplications (2>&1) are allowed.
const UNSAFE_RUNNER = /`|\$\(|[<>]/;
const FD_DUP = /\d*>&\d+/g;
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const ENV_WORD = /^\w+=/;
const SAFE_DIR = /^[\w@+./-]+$/;
const SEG = '\\.?[\\w@+-](?:[\\w@+.-]*[\\w@+-])?';
// An absolute path token; the lookbehind keeps it from starting inside a relative path or after a {{PLACEHOLDER}}.
const ABS_PATH = new RegExp(`(?<![\\w@+./}-])\\/(?:${SEG}\\/)*${SEG}`, 'g');
const COMMIT_SHA = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/;

// Splits text at the positions where `at(i)` returns a separator length (> 0) outside single and double quotes. A backslash
// outside single quotes escapes the next character. The pieces are trimmed and the empty ones dropped.
function splitOutsideQuotes(text, at) {
  const pieces = [];
  let quote = '';
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = ''; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (quote === '"') { if (ch === '"') quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const len = at(i);
    if (len > 0) {
      pieces.push(text.slice(from, i));
      i += len - 1;
      from = i + 1;
    }
  }
  pieces.push(text.slice(from));
  return pieces.map((p) => p.trim()).filter(Boolean);
}

// Separators: && || ; newline | and a background &; a & inside a redirection (2>&1, &>) is not a separator.
function separatorLength(text, i) {
  const ch = text[i];
  if ((ch === '&' || ch === '|') && text[i + 1] === ch) return 2;
  if (ch === ';' || ch === '\n' || ch === '|') return 1;
  if (ch === '&' && text[i - 1] !== '<' && text[i - 1] !== '>') return 1;
  return 0;
}

// The words of a segment with their start offsets; a quoted part stays inside its word, quotes included.
function words(segment) {
  const out = [];
  let start = -1;
  let quote = '';
  for (let i = 0; i <= segment.length; i += 1) {
    const ch = segment[i];
    const space = ch === undefined || (quote === '' && /\s/.test(ch));
    if (space) {
      if (start >= 0) out.push({ raw: segment.slice(start, i), start });
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (quote === "'") { if (ch === "'") quote = ''; } else if (quote === '"') {
      if (ch === '\\') i += 1; else if (ch === '"') quote = '';
    } else if (ch === '\\') i += 1;
    else if (ch === "'" || ch === '"') quote = ch;
  }
  return out;
}

// One shell word without its quotes: a single-quoted word is literal, a double-quoted one keeps \" and \\ unescaped.
function unquote(raw) {
  if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return raw;
}

// True when the text starts with a test runner.
function startsWithRunner(text) {
  const rest = text.trim();
  return TEST_RUNNERS.some((runner) => rest === runner || rest.startsWith(`${runner} `));
}

// The runner of one segment: its env prefix and the runner command, with a test-lock wrapper, a `timeout N` prefix and an
// `sh -c '<command>'` wrapper removed. Null when the segment holds no runner. `cd` is the directory of an inner `cd`.
function runnerOf(segment, workDirs) {
  const ws = words(segment);
  const env = [];
  let i = 0;
  for (;;) {
    const w = ws[i]?.raw;
    if (w === 'env' || (w !== undefined && ENV_WORD.test(w))) { env.push(w); i += 1; continue; }
    if (w === 'timeout' && /^\d+[smhd]?$/.test(ws[i + 1]?.raw ?? '')) { i += 2; continue; }
    break;
  }
  const tail = ws[i] ? segment.slice(ws[i].start) : '';
  const withEnv = (runner) => (runner === null ? null : { ...runner, runner: [...env, runner.runner].join(' ') });
  const [head, second, third] = [ws[i]?.raw, ws[i + 1]?.raw, ws[i + 2]?.raw];
  if (head === 'node' && /(^|\/)test-lock$/.test(second ?? '') && third === '--') return withEnv(runnerOf(segment.slice(ws[i + 3]?.start ?? segment.length), workDirs));
  if (SHELLS.has(head) && second === '-c' && ws.length === i + 3) return withEnv(commandRunner(unquote(third), workDirs));
  return startsWithRunner(tail) ? { runner: [...env, tail].join(' '), cd: null } : null;
}

// What a `cd` segment keeps: false when the segment is no cd; null when the cd is dropped (not strictly below a work dir);
// the directory when kept; undefined when a directory below a work dir has characters a command cannot carry safely.
function cdTarget(segment, workDirs) {
  const ws = words(segment);
  if (ws[0]?.raw !== 'cd' || ws.length !== 2) return false;
  const dir = posix.normalize(unquote(ws[1].raw)).replace(/(.)\/$/, '$1');
  if (!posix.isAbsolute(dir) || !workDirs.some((w) => dir.startsWith(`${w.replace(/\/$/, '')}/`))) return null;
  return SAFE_DIR.test(dir) ? dir : undefined;
}

// The first runner of a compound command and the kept `cd` before it. Null when there is none or a kept cd is unsafe.
function commandRunner(command, workDirs) {
  let cd = null;
  for (const segment of splitOutsideQuotes(command, (i) => separatorLength(command, i))) {
    const target = cdTarget(segment, workDirs);
    if (target === undefined) return null;
    if (target !== false) { cd = target; continue; }
    const found = runnerOf(segment, workDirs);
    if (found !== null) return { runner: found.runner, cd: found.cd ?? cd };
  }
  return null;
}

// The runner segment of a command with its env prefix; test-lock, `timeout N` and `sh -c` wrappers are removed first, and the
// `cd <dir> &&` before it stays when <dir> is below one of the work dirs. Null when none, or when that segment substitutes or redirects.
export function unwrapTestCommand(command, workDirs = []) {
  const found = commandRunner(String(command), workDirs.filter(Boolean));
  if (found === null || UNSAFE_RUNNER.test(found.runner.replace(FD_DUP, ''))) return null;
  return found.cd ? `cd ${found.cd} && ${found.runner}` : found.runner;
}

// The unwrapped command of the last successful bash whose unwrapped form is a test runner. Null when none.
export function testCommandOf(bashes, workDirs = []) {
  return bashes.filter((b) => b.ok).map((b) => unwrapTestCommand(b.command, workDirs)).filter((c) => c !== null).at(-1) ?? null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every absolute path under a work dir (longest dir first) becomes {{WORK}}/<rest>; the dir itself becomes {{WORK}}.
export function rewriteWorkPaths(text, workDirs) {
  const dirs = [...workDirs].filter(Boolean).sort((a, b) => b.length - a.length);
  if (dirs.length === 0) return text;
  const re = new RegExp(`(?<![\\w@+./-])(?:${dirs.map(escapeRe).join('|')})(?![\\w@+-]|\\.[\\w@+-])`, 'g');
  return text.replace(re, '{{WORK}}');
}

// Maps report paths to {{WORK}}/replay-report.md, recovers deleted .md briefs from their whole read, and flags the rest as lost; the
// work paths are rewritten last, so a brief under a work dir is judged by its real path. A path under a work dir exists in a clone
// only when it is tracked at the original commit (tracked(p), else exists(p)); any other path counts as present when exists(p).
export function rewritePrompt(prompt, { workDirs, reads, exists, tracked = exists }) {
  const dirs = workDirs.filter(Boolean).map((d) => d.replace(/(.)\/$/, '$1'));
  const underWork = (p) => dirs.some((d) => p === d || p.startsWith(`${d}/`));
  const files = new Map();
  let lost = false;
  const text = prompt.replace(ABS_PATH, (p) => {
    if (posix.basename(p).endsWith('report.md')) return '{{WORK}}/replay-report.md';
    if (!p.endsWith('.md') || (underWork(p) ? tracked(p) : exists(p)) !== false) return p;
    const read = reads.find((r) => r.path === p);
    if (!read) {
      lost = true;
      return p;
    }
    const name = posix.basename(p);
    files.set(p, { name, content: rewriteWorkPaths(read.content, workDirs) });
    return `{{CASE}}/files/${name}`;
  });
  return { prompt: rewriteWorkPaths(text, workDirs), files: [...files.values()], lost };
}

// The harness replaces a long Bash output with a preview behind one of these markers (never a whole file).
const TRUNCATED_OUTPUT = /<persisted-output>|^Output too large|\.\.\. \[\d+ (?:characters|chars|lines) truncated\] \.\.\./m;
const UNSAFE_PATH = /[*?[\]$`~{}!<>]/;

// The path a command prints whole: `cat <path>`, optionally after `cd <dir> &&`. Both may be relative (to dir, to cwd). Null for
// anything else: options, several files, a pipe, a redirection, a glob or a variable.
function catPath(command, cwd) {
  const segments = splitOutsideQuotes(command, (i) => separatorLength(command, i));
  if (segments.length === 0 || segments.length > 2) return null;
  const resolve = (path, base) => {
    if (UNSAFE_PATH.test(path)) return null;
    if (posix.isAbsolute(path)) return posix.normalize(path);
    return typeof base === 'string' && posix.isAbsolute(base) ? posix.resolve(base, path) : null;
  };
  let dir = cwd;
  if (segments.length === 2) {
    const cd = words(segments[0]);
    if (cd.length !== 2 || cd[0].raw !== 'cd') return null;
    dir = resolve(unquote(cd[1].raw), cwd);
  }
  const cat = words(segments.at(-1));
  if (cat.length !== 2 || cat[0].raw !== 'cat' || cat[1].raw.startsWith('-')) return null;
  return resolve(unquote(cat[1].raw), dir);
}

// The files the agent printed whole with `cat`: { path, content } of each successful, untruncated `cat <path>` call.
export function catReadsOf(bashes) {
  const reads = [];
  for (const b of bashes) {
    if (!b.ok || typeof b.output !== 'string' || b.output === '' || TRUNCATED_OUTPUT.test(b.output)) continue;
    const path = catPath(b.command, b.cwd);
    if (path !== null) reads.push({ path, content: b.output });
  }
  return reads;
}

// A `git commit` call: `git`, any global options (-C <dir>, -c k=v, --no-pager...), `commit`; at the start of a command or after a separator.
const COMMIT_CALL = /(?:^|[;&|(]\s*|\n\s*)git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+(?:=\S+)?))*\s+commit\b/g;
const MESSAGE_FLAG = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:\s+|=)/;
const FILE_FLAG = /(?:^|\s)(?:-F|--file)(?:\s+|=)(\S+)/;
const HEREDOC_SUBSTITUTION = /^"?\$\(\s*cat\s*<<-?\s*['"]?(\w+)['"]?[^\n]*\n/;
const COMMIT_SHAS = new RegExp(COMMIT_SHA.source, 'g');

const firstLine = (text) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? null;

// The message value that starts at `text`: a quoted string, a `$(cat <<EOF ... EOF)` substitution, or a bare word.
function messageValue(text) {
  const heredoc = HEREDOC_SUBSTITUTION.exec(text);
  if (heredoc) return firstLine(text.slice(heredoc[0].length));
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < text.length; i += 1) {
      if (quote === '"' && text[i] === '\\') i += 1;
      else if (text[i] === quote) return firstLine(text.slice(1, i).replace(/\\(["\\$`])/g, '$1'));
    }
    return null;
  }
  return /^\S+/.exec(text)?.[0] ?? null;
}

// The subject of the commit call whose arguments are `args`: the first line of the message `-F -` reads from the heredoc that
// follows, else its first -m value, else the first line of the heredoc a command of the dispatch wrote to the -F file. Null when unknown.
function subjectOf(args, commands) {
  const nl = args.indexOf('\n');
  const file = FILE_FLAG.exec(nl >= 0 ? args.slice(0, nl) : args);
  if (file?.[1] === '-') return nl >= 0 ? firstLine(args.slice(nl + 1)) : null;
  const message = MESSAGE_FLAG.exec(args);
  if (message) return messageValue(args.slice(message.index + message[0].length));
  if (!file) return null;
  const path = file[1].replace(/^["']|["']$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const writer = new RegExp(`>\\s*["']?${path}["']?\\s*<<-?\\s*['"]?(\\w+)['"]?[^\\n]*\\n`);
  for (const command of commands) {
    const written = writer.exec(command);
    if (written) return firstLine(command.slice(written.index + written[0].length));
  }
  return null;
}

// Quiet commits: the sha is taken from a command that runs after the commit and names HEAD, never from one that names another
// commit. A heredoc body is dropped before a command is split, so a message line cannot pass for a command.
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const HEAD_MOVERS = new Set(['commit', 'checkout', 'switch', 'reset', 'rebase', 'cherry-pick', 'merge', 'am', 'pull', 'revert']);
const REV_PARSE_OPTION = /^(?:--short(?:=\d+)?|--verify|-q|--quiet)$/;
const DISPLAY_OPTION = /^(?:--oneline|--abbrev-commit|--no-abbrev-commit|--abbrev=\d+|--format=.*|--pretty(?:=.*)?|--decorate(?:=.*)?|--no-decorate|--stat|--name-only|--name-status|--no-patch|-s|--color(?:=.*)?|--no-color)$/;
const COUNT_ONE = /^(?:-1|-n1|--max-count=1)$/;

const segmentsOf = (command) => {
  const text = command.replace(HEREDOC_BODY, '$1');
  return splitOutsideQuotes(text, (i) => separatorLength(text, i));
};

// `git <global options> <subcommand> <arguments>` of one segment, else null.
function gitCall(segment) {
  const ws = words(segment.replace(/^[({\s]+/, '')).map((w) => unquote(w.raw));
  if (ws[0] !== 'git') return null;
  let i = 1;
  while (ws[i] === '-C' || ws[i] === '-c' || ws[i]?.startsWith('--')) i += ws[i].startsWith('--') ? 1 : 2;
  return ws[i] === undefined ? null : { sub: ws[i], args: ws.slice(i + 1) };
}

// True for `git rev-parse [--short[=n]] [--verify] HEAD` and for `git log` (limited to one commit) or `git show` with no ref or
// HEAD, display options only: any other ref, path limit or ref selection names another commit.
function namesHead({ sub, args }) {
  if (sub !== 'rev-parse' && sub !== 'log' && sub !== 'show') return false;
  const refs = [];
  let limited = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) refs.push(arg);
    else if (sub === 'log' && COUNT_ONE.test(arg)) limited = true;
    else if (sub === 'log' && arg === '-n' && args[i + 1] === '1') {
      limited = true;
      i += 1;
    } else if (!(sub === 'rev-parse' ? REV_PARSE_OPTION : DISPLAY_OPTION).test(arg)) return false;
  }
  if (refs.length > 1 || (refs.length === 1 && refs[0] !== 'HEAD')) return false;
  return sub === 'rev-parse' ? refs.length === 1 : sub === 'show' || limited;
}

// The last sha an echo printed: a `commit <sha>` line, else a line that starts with one.
function printedSha(output) {
  const text = output ?? '';
  const last = (re) => [...text.matchAll(re)].at(-1)?.[1] ?? null;
  return last(/^commit\s+([0-9a-f]{7,40})\b/gm) ?? last(/^([0-9a-f]{7,40})\b/gm);
}

// Looks through the segments that run after a commit: the first that names HEAD gives `echo`, one that moves HEAD gives `moved`.
function afterCommit(segments) {
  for (const segment of segments) {
    const call = gitCall(segment);
    if (call === null) continue;
    if (HEAD_MOVERS.has(call.sub)) return 'moved';
    if (namesHead(call)) return 'echo';
  }
  return null;
}

// The sha of the last commit call of `b` (its arguments start at `from`) from a command that runs after it and names HEAD: later
// in the same command, else in a later command, each up to the first command that moves HEAD. Null when there is none.
function echoedAfter(b, from, later) {
  const same = afterCommit(segmentsOf(b.command.slice(from)).slice(1));
  if (same !== null) return same === 'echo' ? printedSha(b.output) : null;
  for (const next of later) {
    if (!next.ok) continue;
    const found = afterCommit(segmentsOf(next.command));
    if (found !== null) return found === 'echo' ? printedSha(next.output) : null;
  }
  return null;
}

// Per successful `git commit` command: the shas the commit prints, else the sha a later command named HEAD printed, else the
// subject of the commit's message.
export function commitRefsOf(bashes) {
  const refs = [];
  const commands = bashes.filter((b) => b.ok).map((b) => b.command);
  bashes.forEach((b, i) => {
    if (!b.ok) return;
    const calls = [...b.command.matchAll(COMMIT_CALL)];
    if (calls.length === 0) return;
    const printed = [...(b.output ?? '').matchAll(COMMIT_SHAS)].map((m) => ({ sha: m[1] }));
    if (printed.length > 0) {
      refs.push(...printed);
      return;
    }
    calls.forEach((call, n) => {
      const from = call.index + call[0].length;
      const sha = n === calls.length - 1 ? echoedAfter(b, from, bashes.slice(i + 1)) : null;
      if (sha !== null) { refs.push({ sha }); return; }
      const subject = subjectOf(b.command.slice(from, calls[n + 1]?.index ?? b.command.length), commands);
      if (subject !== null) refs.push({ subject });
    });
  });
  return refs;
}

// The absolute directories the commands `cd` or `git -C` into, in first-use order. A directory the transcript's cwd never named
// (an agent's cwd is reset between commands) is still where the work happened.
const DIR_ARG = /(?:^|[;&|(]\s*|\n\s*)(?:cd|git\s+-C)\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|)"']+)/g;
export function dirsOf(bashes) {
  const dirs = new Set();
  for (const b of bashes) {
    for (const m of b.command.matchAll(DIR_ARG)) {
      const dir = unquote(m[1]);
      if (posix.isAbsolute(dir)) dirs.add(dir.replace(/(.)\/$/, '$1'));
    }
  }
  return [...dirs];
}

// The directories the successful `git commit` calls ran in, in first-use order: its `git -C` target, else the last `cd` before it in
// the same command, else the cwd of the bash call. A relative directory is resolved against that cwd.
const CD_ARG = /(?:^|[;&|(]\s*|\n\s*)cd\s+("[^"\n]+"|'[^'\n]+'|[^\s;&|)"']+)/g;
export function commitDirsOf(bashes) {
  const dirs = new Set();
  for (const b of bashes) {
    if (!b.ok) continue;
    for (const call of b.command.matchAll(COMMIT_CALL)) {
      const named = /(?:^|\s)-C\s+("[^"]*"|'[^']*'|\S+)/.exec(call[0])?.[1] ?? null;
      const cd = [...b.command.slice(0, call.index).matchAll(CD_ARG)].at(-1)?.[1] ?? null;
      const dir = named ?? cd;
      if (dir === null) {
        if (typeof b.cwd === 'string' && posix.isAbsolute(b.cwd)) dirs.add(b.cwd);
      } else if (posix.isAbsolute(unquote(dir))) dirs.add(posix.normalize(unquote(dir)).replace(/(.)\/$/, '$1'));
      else if (typeof b.cwd === 'string' && posix.isAbsolute(b.cwd)) dirs.add(posix.resolve(b.cwd, unquote(dir)));
    }
  }
  return [...dirs];
}

// The plan task id of a task description, e.g. "T7 fix round 1 fixer" -> "T7".
export function taskOf(description) {
  const m = /^T(\d+)\b/.exec(description);
  return m ? `T${m[1]}` : null;
}

// The plan file name (without .md) mentioned in a prompt.
export function planOf(prompt) {
  const m = /\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)+/.exec(prompt);
  return m ? m[0] : null;
}
