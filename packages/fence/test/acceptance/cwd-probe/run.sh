#!/bin/bash
# Probe: does the hook payload's `cwd` of a Claude Bash call follow a `cd` made in an earlier Bash call,
# both inside the project and OUTSIDE it, and does it agree with the shell's real `pwd`?
# ADD_OUTSIDE=0 runs without --add-dir for the outside directory (default 1).
# Uses a throwaway settings file (--settings is additive: the real hooks and ~/.claude still load, and
# claude -p writes its session transcript under the real ~/.claude/projects) and mktemp project dirs.
#
# This is a manual real-host probe: `claude` loads the real hooks and writes its transcript under the real
# ~/.claude. It therefore refuses to run unless HOME (or CLAUDE_CONFIG_DIR) points inside a temp directory,
# or FENCE_TEST_ISOLATION=off says to use the real setup (test/helpers/isolation.mjs).
set -u
LEVEL="${FENCE_TEST_ISOLATION:-writes}"
case "$LEVEL" in
  writes|full) ;;
  off) echo "cwd-probe: WARNING: FENCE_TEST_ISOLATION=off, this run uses your real claude setup (hooks, ~/.claude)" >&2 ;;
  *) echo "cwd-probe: FENCE_TEST_ISOLATION='$LEVEL' is not a level; use one of: writes, full, off" >&2; exit 2 ;;
esac
if [ "$LEVEL" != off ]; then
  inside_temp() { # is the existing path $1 inside a temp directory (after resolving links)?
    local p t
    p="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
    for t in "${TMPDIR:-/tmp}" /tmp /var/tmp; do
      t="$(cd "$t" 2>/dev/null && pwd -P)" || continue
      case "$p/" in "$t"/?*) return 0 ;; esac
    done
    return 1
  }
  # claude keeps its config under CLAUDE_CONFIG_DIR when that is set, else under HOME/.claude
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    inside_temp "$CLAUDE_CONFIG_DIR" && ok=1 || ok=0
  else
    inside_temp "${HOME:-/nonexistent}" && ok=1 || ok=0
  fi
  if [ "$ok" != 1 ]; then
    echo "cwd-probe: refusing to run: the claude config (CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-unset}, HOME=${HOME:-unset}) is not inside a temp directory," >&2
    echo "cwd-probe: so claude would load your real hooks and write its transcript under the real ~/.claude." >&2
    echo "cwd-probe: point CLAUDE_CONFIG_DIR (or, when it is unset, HOME) at a temp directory, or set FENCE_TEST_ISOLATION=off to use the real setup." >&2
    exit 2
  fi
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export FENCE_PROBE_LOG="$T/log.jsonl"
mkdir -p "$T/project/sub" "$T/outside"
cat > "$T/settings.json" <<JSON
{"hooks":{
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$HERE/hook.sh"}]}],
 "PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$HERE/hook.sh"}]}]}}
JSON
cd "$T/project"
ADD=(); [ "${ADD_OUTSIDE:-1}" = 1 ] && ADD=(--add-dir "$T/outside")
claude -p --settings "$T/settings.json" --allowedTools "Bash" ${ADD[@]+"${ADD[@]}"} --max-turns 8 \
  "Make exactly four separate Bash tool calls, one at a time, in this order: (1) cd sub (2) pwd (3) cd $T/outside (4) pwd. Then reply DONE." \
  < /dev/null > "$T/out.txt" 2>&1
status=$?
echo "== claude exit status: $status =="
echo "== hook log (event, cwd, command, stdout); <t> is the temp root =="
RT="$(cd "$T" && pwd -P)"
sed -e "s#$RT#<t>#g" -e "s#$T#<t>#g" "$FENCE_PROBE_LOG" 2>/dev/null
[ "$status" -ne 0 ] && { echo "== claude output =="; sed -e "s#$RT#<t>#g" "$T/out.txt" | tail -20; }
echo "== layout: <t>/project (cwd of the session), <t>/project/sub, <t>/outside =="
