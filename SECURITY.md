# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue: open the **Security** tab of this repository and choose **Report a
vulnerability**. That creates a private advisory that only you and the maintainer can read.

Include the versions (`claude plugin list` shows the version of each installed plugin; for the npm CLI, `npx triqual --version`), what you did, what you expected and what happened. A short
reproduction helps more than a long description.

This is a personal project, so there is no support contract and no guaranteed response time. Reports are read and
answered on a best-effort basis, and a confirmed problem is fixed in the next release.

## Supported versions

Only the latest release of each plugin on `main` receives fixes.

## What is in scope

Triqual installs hooks and a command line tool that run on your machine, and it edits your Claude Code, Codex and Grok
configuration (always after a backup). Problems that matter here include:

- command injection, path traversal or unsafe file writes in `triqual`, `bootstrap` or a hook;
- a way to make `bootstrap`, `sync` or `migrate` change or delete files it should not touch;
- the tracking store (a local SQLite database) exposing or corrupting data from another repository;
- the optional `memory-report` plugin sending notes it was told never to send: its allowlist, never-send list and
  secret filter are meant to hold, and a bypass is a vulnerability.

Out of scope: vulnerabilities in Claude Code, Codex, Grok, claude-mem or Node itself (report those to their
maintainers), and anything that needs an attacker who already controls your account or your `~/.claude` directory.
