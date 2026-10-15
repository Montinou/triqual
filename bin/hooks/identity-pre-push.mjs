// Pre-push hook: refuses a push to the public repository unless it goes over PUBLIC_SSH_URL as the GitHub account OWNER.login
// and every commit it would send is by OWNER with no AI attribution line. Installed as .git/hooks/pre-push (by the setup, not
// here): `node "$(git rev-parse --show-toplevel)/bin/hooks/identity-pre-push.mjs" "$@"`.
//
// git passes `<remote name> <remote url>` as arguments and one `<local ref> <local sha> <remote ref> <remote sha>` line per ref
// on stdin. A deletion (local sha all zeros) sends no commits and is skipped. The commits checked are those of
// `git rev-list <local sha> --not --remotes=<remote name>`: whatever the remote already has (GitHub's own merge and squash
// commits included) is never checked, and a new branch checks only its new commits.
//
// Exit 0 clean; 1 on a refusal or any failure, since a hook that cannot check must not let a push by.
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OWNER, PUBLIC_SSH_URL, checkCommits, formatFinding, readCommits, sshAccount } from '../lib/identity.mjs';

const ZERO_SHA = /^0+$/;

export function main(argv, { stdin = () => readFileSync(0, 'utf8'), err = console.error, account = sshAccount } = {}) {
  try {
    const [remote, url] = argv;
    if (!remote || remote.startsWith('-') || url === undefined) throw new Error('usage: identity-pre-push.mjs <remote> <url>');
    if (url !== PUBLIC_SSH_URL) {
      err(`identity: refusing the push, the remote URL is not ${PUBLIC_SSH_URL}: push over ssh only`);
      return 1;
    }
    const login = account();
    if (login !== OWNER.login) {
      err(`identity: refusing the push, ssh authenticates as ${login === null ? 'no GitHub account' : login} and not ${OWNER.login}`);
      return 1;
    }
    let refused = 0;
    for (const line of stdin().split('\n')) {
      if (line.trim() === '') continue;
      const [, localSha] = line.trim().split(/\s+/);
      if (!localSha || ZERO_SHA.test(localSha)) continue;
      const findings = checkCommits(readCommits([localSha, '--not', `--remotes=${remote}`]), { strict: true });
      for (const finding of findings) err(`identity: ${formatFinding(finding)}`);
      refused += findings.length;
    }
    return refused > 0 ? 1 : 0;
  } catch (error) {
    err(`identity: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
