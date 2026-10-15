// The owner-identity rules for the public repository: everything pushed there is pushed by the GitHub account OWNER.login, over
// PUBLIC_SSH_URL, as author and committer OWNER.name <OWNER.email>, and carries no AI attribution line.
//
//   node bin/lib/identity.mjs --range <base>..<head> [--strict]
//
// Exit 0 clean, 1 with one `sha · reason` line per flagged commit (or when git cannot be read), 2 on a usage error. CI runs it
// with --strict on a pull request's commits; the pre-push hook (bin/hooks/identity-pre-push.mjs) uses the same rules. git calls
// inherit process.env unchanged (the git helpers in lib/export.mjs strip GIT_*, so they are not used).
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const OWNER = { login: 'Montinou', name: 'Montinou', email: '33442778+Montinou@users.noreply.github.com' };
export const PUBLIC_SSH_URL = 'git@github.com:Montinou/triqual.git';
// The ssh account host (`user@host`), derived from the URL so the bare form is not a second literal.
export const SSH_HOST = PUBLIC_SSH_URL.slice(0, PUBLIC_SSH_URL.indexOf(':'));

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SSH_TIMEOUT_MS = 30_000;

// An AI attribution line: `Claude-Session:` or `Generated with` at the start of a line, or a `Co-Authored-By:` line naming
// Claude or an anthropic.com address. A human Co-Authored-By is not one.
const ATTRIBUTION = [/^Claude-Session:/im, /^Generated with/im, /^Co-Authored-By:[^\n]*(?:claude|anthropic\.com)/im];

const isOwner = (name, email) => name === OWNER.name && email === OWNER.email;

// commits: [{ sha, authorName, authorEmail, committerName, committerEmail, message }]. Returns [{ sha, reason }], one per
// finding, in commit order. An AI attribution line is always a finding; with `strict`, so is any author or committer other
// than OWNER.
export function checkCommits(commits, { strict = false } = {}) {
  const found = [];
  for (const commit of commits) {
    if (ATTRIBUTION.some((pattern) => pattern.test(commit.message))) {
      found.push({ sha: commit.sha, reason: 'AI attribution line in the message' });
    }
    if (strict && !isOwner(commit.authorName, commit.authorEmail)) {
      found.push({ sha: commit.sha, reason: `author is not ${OWNER.name}` });
    }
    if (strict && !isOwner(commit.committerName, commit.committerEmail)) {
      found.push({ sha: commit.sha, reason: `committer is not ${OWNER.name}` });
    }
  }
  return found;
}

// `range` is one revision argument or an array of them (`['<sha>', '--not', '--remotes=origin']`). Throws when git fails.
export function readCommits(range, { cwd = process.cwd() } = {}) {
  const revisions = Array.isArray(range) ? range : [range];
  const format = '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B';
  let output;
  try {
    output = execFileSync('git', ['log', '-z', format, ...revisions, '--'], { cwd, env: process.env, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const reason = String(error.stderr ?? '').trim().split('\n')[0];
    throw new Error(`git log failed${reason ? `: ${reason}` : ''}`);
  }
  return output
    .split('\0')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, authorName, authorEmail, committerName, committerEmail, ...message] = record.replace(/^\n/, '').split('\x1f');
      return { sha, authorName, authorEmail, committerName, committerEmail, message: message.join('\x1f') };
    });
}

const defaultExec = (file, args) => spawnSync(file, args, { env: process.env, encoding: 'utf8', timeout: SSH_TIMEOUT_MS });

// The GitHub login the ssh key authenticates as, or null. GitHub answers `Hi <login>! You've successfully authenticated, ...`
// on stderr and exits 1, so the login is parsed from stderr whatever the exit code; without a `Hi` line the answer is null.
export function sshAccount({ exec = defaultExec } = {}) {
  const result = exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', SSH_HOST]);
  const match = /^Hi ([^!\s]+)!/m.exec(String(result?.stderr ?? ''));
  return match ? match[1] : null;
}

export const formatFinding = ({ sha, reason }) => `${sha} · ${reason}`;

function main(argv, { out = console.log, err = console.error } = {}) {
  let range = null;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--range' && argv[index + 1] !== undefined) range = argv[++index];
    else if (argv[index] === '--strict') strict = true;
    else {
      err(`usage: identity.mjs --range <base>..<head> [--strict] (unknown argument ${argv[index]})`);
      return 2;
    }
  }
  if (range === null) {
    err('usage: identity.mjs --range <base>..<head> [--strict]');
    return 2;
  }
  try {
    const found = checkCommits(readCommits(range), { strict });
    for (const finding of found) out(formatFinding(finding));
    return found.length > 0 ? 1 : 0;
  } catch (error) {
    err(`identity: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
