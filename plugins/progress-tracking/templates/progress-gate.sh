#!/bin/sh
# progress-tracking: every commit with changes carries progress.md and status.md, and a staged task ledger
# (docs/plans/*.tasks.json) must agree with its plan and status.md (triqual tasks check --staged; the deprecated cm
# alias when only it is on PATH).
# Installed by /progress-tracking:progress-init; re-running it updates this file. Plain POSIX sh: teammates without
# the plugin run it too.
# Git runs hooks from the top of the working tree. A repo without progress.md is not opted in (a global hooks dir
# reaches every repo): nothing to check. `find -name` matches the exact name, even on a case-insensitive file system
# (where `[ -f progress.md ]` would also find PROGRESS.md).
find . -maxdepth 1 -name progress.md | grep -q . || exit 0
gp() { git rev-parse --git-path "$1"; }
# Merges, cherry-picks, reverts and rebases replay work that was already logged.
for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [ -e "$(gp "$f")" ] && exit 0
done
ledger='docs/plans/[^/]+\.tasks\.json'
# No rename detection: a file renamed into a tracking path still counts on its old side. A type change (file to
# symlink) is a change. Paths unquoted (non-ASCII).
staged=$(git -c core.quotePath=false diff --cached --name-only --no-renames --diff-filter=ACMRDT)
others=$(printf '%s\n' "$staged" | grep -vxE "progress\.md|status\.md|$ledger" | grep -v '^$')
if [ -n "$others" ]; then
  missing=""
  printf '%s\n' "$staged" | grep -qxF 'progress.md' || missing="progress.md"
  printf '%s\n' "$staged" | grep -qxF 'status.md' || missing="${missing:+$missing and }status.md"
  if [ -n "$missing" ]; then
    echo "pre-commit (progress-tracking): the commit has changes but does not include $missing." >&2
    echo "Add this task's entry at the top of progress.md, update status.md and git add both." >&2
    exit 1
  fi
fi
printf '%s\n' "$staged" | grep -qxE "$ledger" || exit 0
skip() { echo "pre-commit (progress-tracking): $1 not available; skipped the ledger check." >&2; exit 0; }
if command -v triqual >/dev/null 2>&1; then
  cli=triqual
elif command -v cm >/dev/null 2>&1; then
  cli=cm
else
  skip "triqual or cm"
fi
out=$("$cli" tasks check --staged 2>&1)
rc=$?
[ "$rc" -eq 0 ] && exit 0
# 3: the CLI was found but cannot run the check (the plugin is missing).
[ "$rc" -eq 3 ] && skip "$cli"
if [ -n "$out" ]; then
  printf '%s\n' "$out" >&2
else
  echo "pre-commit (progress-tracking): $cli tasks check --staged failed (exit $rc)." >&2
fi
exit 1
