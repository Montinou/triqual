# Contributing to Triqual

Issues and pull requests are welcome. This page says what a change needs to be merged.

## Before you start

- Open an issue first for anything bigger than a small fix, so the direction is agreed before you write code.
- Report a security problem through the private channel in [SECURITY.md](SECURITY.md), not in a public issue.

## Set up

You need Node 22.13 or newer and git 2.31 or newer. Clone the repository and run the tests:

```bash
git clone https://github.com/Montinou/triqual.git
cd triqual
npm test
```

`npm test` runs every plugin's tests and the repository's own, about 2,500 in all. It takes around ten minutes and
uses the whole machine while it runs, so a few timing-sensitive tests can fail on a loaded one. To work on one area,
run a single file: `node --test plugins/progress-tracking/test/tasks-line.test.mjs`.

## What a pull request needs

- A test that fails without the change and passes with it. The suite is the contract of this project.
- A small, focused diff. Unrelated clean-ups go in their own pull request.
- Code, docs and commit messages in English. Conventional commit prefixes (`fix:`, `feat:`, `docs:`, `test:`).
- No machine-specific paths, credentials, client or employer names anywhere in the diff.
- A README update when you change a command, a flag or a default; `test/readme.test.mjs` pins several of those facts.
- A version bump in the plugin's `plugin.json` and in `.claude-plugin/marketplace.json` when you change what a plugin
  ships (`test/marketplace.test.mjs` checks that the two agree and pins the versions of the release).

## How changes are merged

Development happens in this repository, `Montinou/triqual`, and pull requests from outside are welcome. `main` is
protected: every change goes through a pull request that the maintainer merges once the `ci` check passes.

### For the maintainer

- After `triqual progress-init --store`, `node bin/install-hooks.mjs` installs the local hooks after the store gate that
  `progress-init --store` installs: the content gate on every commit and the identity check on every push.
- The deny list is never in the repository. It lives in the file named by `PUBLIC_EXPORT_DENY`, else in
  `~/.config/triqual/public-export-deny.txt`, plus the `clientTerms` and `neverSend` of the memory-report config; never
  commit it. After changing it, run `node bin/lib/content-gate.mjs --all`, so the new entries are checked against the
  files that already exist.
- The maintainer's own pull requests need every commit authored and committed with the public `noreply` identity, and CI
  checks it. A GitHub "Update branch" merge commit fails that check: rebase or merge locally instead.

## Layout

| Path | What it holds |
|---|---|
| `plugins/methodology/` | The workflow skills, the global rules, `triqual sync`, `triqual doctor` and the harness setup |
| `plugins/progress-tracking/` | Progress entries, task ledgers and the three tracking modes |
| `plugins/roles/` | The role agents |
| `plugins/workflow-gate/` | The guard on Workflow scripts |
| `plugins/memory-report/` | The optional weekly memory report |
| `bin/` | `bootstrap`, the `triqual` shim, the maintainer hooks and the content gate |
| `test/` | Tests that cover the repository as a whole |

## License

By contributing you agree that your contribution is released under the [MIT License](LICENSE).
