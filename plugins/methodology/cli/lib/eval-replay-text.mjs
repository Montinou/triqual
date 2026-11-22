// Pure text rewriting for replay cases: test commands, work-path placeholders, prompts and commit references. No I/O except the injected exists(). node: built-ins only.
import { posix } from 'node:path';

export const TEST_RUNNERS = ['node --test', 'npm test', 'npm run test', 'pnpm test', 'yarn test', 'bun test', 'vitest', 'jest', 'pytest', 'go test', 'cargo test'];

// Separators: && || ; newline | and a background &; a & inside a redirection (2>&1, &>) is not a separator.
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\n|\||(?<![<>])&)\s*/;
// Command substitution, backticks and redirections in the kept runner segment; fd duplications (2>&1) are allowed.
const UNSAFE_RUNNER = /`|\$\(|[<>]/;
const FD_DUP = /\d*>&\d+/g;
const TEST_LOCK = /^((?:env\s+|\w+=\S+\s+)*)node\s+\S*test-lock\s+--\s+(.+)$/;
const SEG = '\\.?[\\w@+-](?:[\\w@+.-]*[\\w@+-])?';
// An absolute path token; the lookbehind keeps it from starting inside a relative path or after a {{PLACEHOLDER}}.
const ABS_PATH = new RegExp(`(?<![\\w@+./}-])\\/(?:${SEG}\\/)*${SEG}`, 'g');
const COMMIT_SHA = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/;
const MESSAGE = /\s-[a-zA-Z]*m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;

// True when the segment, past any `env` and VAR=value prefix, starts with a test runner.
function isRunner(segment) {
  const words = segment.split(/\s+/);
  let i = 0;
  while (i < words.length && (words[i] === 'env' || /^\w+=/.test(words[i]))) i += 1;
  const rest = words.slice(i).join(' ');
  return TEST_RUNNERS.some((runner) => rest === runner || rest.startsWith(`${runner} `));
}

// The runner segment of a command, with its env prefix; test-lock wrappers are removed first. Null when none, or when that segment substitutes or redirects.
export function unwrapTestCommand(command) {
  const segments = String(command).split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean)
    .map((s) => {
      const m = TEST_LOCK.exec(s);
      return m ? `${m[1]}${m[2]}` : s;
    });
  const runner = segments.find(isRunner);
  if (runner === undefined || UNSAFE_RUNNER.test(runner.replace(FD_DUP, ''))) return null;
  return runner;
}

// The unwrapped command of the last successful bash whose unwrapped form is a test runner. Null when none.
export function testCommandOf(bashes) {
  return bashes.filter((b) => b.ok).map((b) => unwrapTestCommand(b.command)).filter((c) => c !== null).at(-1) ?? null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every absolute path under a work dir (longest dir first) becomes {{WORK}}/<rest>; the dir itself becomes {{WORK}}.
export function rewriteWorkPaths(text, workDirs) {
  const dirs = [...workDirs].filter(Boolean).sort((a, b) => b.length - a.length);
  if (dirs.length === 0) return text;
  const re = new RegExp(`(?<![\\w@+./-])(?:${dirs.map(escapeRe).join('|')})(?![\\w@+-]|\\.[\\w@+-])`, 'g');
  return text.replace(re, '{{WORK}}');
}

// Maps report paths to {{WORK}}/replay-report.md, recovers deleted .md briefs from their whole read, and flags the rest as lost.
export function rewritePrompt(prompt, { workDirs, reads, exists }) {
  let text = prompt.replace(ABS_PATH, (p) => (posix.basename(p).endsWith('report.md') ? '{{WORK}}/replay-report.md' : p));
  text = rewriteWorkPaths(text, workDirs);
  const files = new Map();
  let lost = false;
  text = text.replace(ABS_PATH, (p) => {
    if (!p.endsWith('.md') || exists(p) !== false) return p;
    const read = reads.find((r) => r.path === p);
    if (!read) {
      lost = true;
      return p;
    }
    const name = posix.basename(p);
    files.set(p, { name, content: rewriteWorkPaths(read.content, workDirs) });
    return `{{CASE}}/files/${name}`;
  });
  return { prompt: text, files: [...files.values()], lost };
}

// Per successful `git commit`: the sha printed by the commit, else its -m subject, else the first line after a `-F -` heredoc.
export function commitRefsOf(bashes) {
  const refs = [];
  for (const b of bashes) {
    if (!b.ok || !b.command.includes('git commit')) continue;
    const sha = COMMIT_SHA.exec(b.output ?? '');
    if (sha) {
      refs.push({ sha: sha[1] });
      continue;
    }
    const firstLine = b.command.split('\n')[0];
    const m = MESSAGE.exec(firstLine);
    if (m) {
      refs.push({ subject: m[1] ?? m[2] ?? m[3] });
      continue;
    }
    const nl = b.command.indexOf('\n');
    if (/-F\s+-/.test(firstLine) && nl >= 0) refs.push({ subject: b.command.slice(nl + 1).split('\n')[0].trim() });
  }
  return refs;
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
