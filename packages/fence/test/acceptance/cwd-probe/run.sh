#!/bin/bash
# Probe: does the hook payload's `cwd` of a Claude Bash call follow a `cd` made in an earlier Bash call,
# both inside the project and OUTSIDE it, and does it agree with the shell's real `pwd`?
# ADD_OUTSIDE=0 runs without --add-dir for the outside directory (default 1).
# Uses a throwaway settings file (--settings is additive: the real hooks and ~/.claude still load, and
# claude -p writes its session transcript under the real ~/.claude/projects) and mktemp project dirs.
set -u
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
