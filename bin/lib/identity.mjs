// Authenticated account routing for the maintainer checkout. Commit metadata is not an authorization check.
import { spawnSync } from 'node:child_process';

export const OWNER = { login: 'Montinou', name: 'Montinou', email: '33442778+Montinou@users.noreply.github.com' };
export const PUBLIC_SSH_URL = 'git@github.com:Montinou/triqual.git';
// The ssh account host (`user@host`), derived from the URL so the bare form is not a second literal.
export const SSH_HOST = PUBLIC_SSH_URL.slice(0, PUBLIC_SSH_URL.indexOf(':'));

const SSH_TIMEOUT_MS = 30_000;

const defaultExec = (file, args) => spawnSync(file, args, { env: process.env, encoding: 'utf8', timeout: SSH_TIMEOUT_MS });

// The GitHub login the ssh key authenticates as, or null. GitHub answers `Hi <login>! You've successfully authenticated, ...`
// on stderr and exits 1, so the login is parsed from stderr whatever the exit code; without a `Hi` line the answer is null.
export function sshAccount({ exec = defaultExec } = {}) {
  const result = exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', SSH_HOST]);
  const match = /^Hi ([^!\s]+)!/m.exec(String(result?.stderr ?? ''));
  return match ? match[1] : null;
}
