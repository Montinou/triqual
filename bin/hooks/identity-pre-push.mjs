// Local account-routing guard: push to the public SSH URL only as the maintainer GitHub account.
// Commit authors, committers and attribution trailers are unrestricted. GitHub controls merge authorization.
// Installed as .git/hooks/pre-push; git supplies the remote name and URL as arguments.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OWNER, PUBLIC_SSH_URL, sshAccount } from '../lib/identity.mjs';

export function main(argv, { err = console.error, account = sshAccount } = {}) {
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
    return 0;
  } catch (error) {
    err(`identity: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
