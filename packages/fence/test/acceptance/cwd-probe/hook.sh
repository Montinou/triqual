#!/bin/bash
# Logs the hook payload's event, cwd, Bash command and (PostToolUse) the command's stdout; makes no decision.
LOG="${FENCE_PROBE_LOG:?FENCE_PROBE_LOG must name the log file}"
node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.tool_response;process.stdout.write(JSON.stringify({event:j.hook_event_name,cwd:j.cwd,command:j.tool_input&&j.tool_input.command,stdout:r&&(typeof r==="string"?r:r.stdout)})+"\n")})' >> "$LOG"
exit 0
