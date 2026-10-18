#!/bin/bash
# The Claude jev runner (spec, "Acceptance", item 1): jev-harness guard 1.2.0, default corpus, with the
# staged fence launcher as the only guard.
#
#   run-claude.sh [--policy <file>] [--out <report.json>]
#
# A temp root holds an empty project (`git init`-ed on the unprotected branch `acceptance`), a staged
# HOME (stage-home.mjs: versions/0.0.0-test, current, the bundled watchdog, git.json and the policy,
# default packages/fence/policies/strict.json) and empty state and admin directories. The guard
# string overrides HOME only for the launcher (`env HOME=<staged>`). jev runs from the project with no
# user or managed settings, sends every payload as stdin JSON (nothing is executed), writes its JSON
# report and this script prints the report's metrics. UVX overrides the uvx program.
#
# jev runs every hook, and sets every payload's `cwd`, in its own workspace: a tempfile.mkdtemp
# directory (prefix jev-harness-), not the directory jev was started from. Left in the system temp
# directory that workspace is outside any repository, so ${repo} would not resolve and strict.json
# would deny harmless in-repo edits. uvx therefore runs with TMPDIR, TMP and TEMP set to
# <project>/.jev-tmp, which puts jev's workspace (and the hook cwd) inside the repository, as in a
# real session. After the run, every engine log line must show a cwd inside the project and the
# project as its repo root (compare.mjs --check-cwd); otherwise the script fails with exit 3.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../../.." && pwd)"
POLICY="$PKG/policies/strict.json"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --policy) POLICY="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --out) mkdir -p "$(dirname "$2")"; OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    *) echo "usage: run-claude.sh [--policy <file>] [--out <report.json>]" >&2; exit 2 ;;
  esac
done
UVX="${UVX:-uvx}"
JEV_SPEC='jev-harness-sdk[stats]==1.2.0'

ROOT="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/fence-jev-claude-XXXXXX")" && pwd -P)"
PROJECT="$ROOT/project"
STATE="$ROOT/state"
ADMIN="$ROOT/admin"
mkdir -p "$PROJECT" "$STATE" "$ADMIN"
[ -n "$OUT" ] || OUT="$ROOT/claude-report.json"

# The paths go into a /bin/sh command string unquoted: allow only characters the shell takes literally.
if [[ "$ROOT" =~ [^A-Za-z0-9_./-] ]]; then
  echo "run-claude: the temp root $ROOT can not be named in a guard command" >&2
  exit 2
fi

git init -q "$PROJECT"
git -C "$PROJECT" symbolic-ref HEAD refs/heads/acceptance
# jev's temp root (and so its workspace, the hook cwd) inside the repository
JEV_TMP="$PROJECT/.jev-tmp"
mkdir -p "$JEV_TMP"
case "$(cd "$JEV_TMP" && pwd -P)/" in
  "$PROJECT"/*) ;;
  *) echo "run-claude: $JEV_TMP does not resolve inside $PROJECT" >&2; exit 3 ;;
esac

STAGED="$(node "$PKG/test/acceptance/stage-home.mjs" "$ROOT/stage" --policy "$POLICY")"
HOME_DIR="$ROOT/stage/home"
HOOK="$HOME_DIR/.local/bin/fence-hook"
case "$STAGED" in
  *"\"watchdog\":\"$HOOK\""*) ;;
  *) echo "run-claude: stage-home did not stage $HOOK ($STAGED)" >&2; exit 2 ;;
esac

GUARD="env HOME=$HOME_DIR $HOOK pre --host claude --policy $HOME_DIR/.config/fence/policy.json --state-dir $STATE --admin-dir $ADMIN"
echo "guard: $GUARD"

cd "$PROJECT"
# jev exits non-zero when payloads got through; the metrics are printed either way.
status=0
TMPDIR="$JEV_TMP" TMP="$JEV_TMP" TEMP="$JEV_TMP" \
  "$UVX" --from "$JEV_SPEC" jev-harness guard run --no-user-settings --no-managed-settings \
  --guard "$GUARD" -f json -o "$OUT" || status=$?

[ -f "$OUT" ] || { echo "run-claude: jev wrote no report (exit $status)" >&2; exit 2; }
echo "jev report: $OUT (jev exit $status)"
node "$HERE/compare.mjs" --metrics "$OUT"
# every hook must have run inside the repository (see the header)
node "$HERE/compare.mjs" --check-cwd "$STATE" "$PROJECT" || exit 3
exit "$status"
