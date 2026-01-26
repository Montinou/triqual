#!/usr/bin/env bash
echo "[DEBUG] PreToolUse hook called at $(date)" >> /tmp/triqual_hook_debug.log
echo "[DEBUG] TOOL_INPUT: ${TOOL_INPUT}" >> /tmp/triqual_hook_debug.log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

main() {
    local input="${TOOL_INPUT:-$1}"
    local file_path=$(extract_file_path "$input")
    
    echo "[DEBUG] file_path: $file_path" >> /tmp/triqual_hook_debug.log
    
    if [ -z "$file_path" ]; then
        echo "[DEBUG] No file path, exiting" >> /tmp/triqual_hook_debug.log
        output_empty
        exit 0
    fi
    
    if is_temp_file "$file_path"; then
        echo "[DEBUG] Temp file, skipping" >> /tmp/triqual_hook_debug.log
        output_empty
        exit 0
    fi
    
    if is_non_code_file "$file_path"; then
        echo "[DEBUG] Non-code file, skipping" >> /tmp/triqual_hook_debug.log
        output_empty
        exit 0
    fi
    
    if ! is_spec_file "$file_path"; then
        echo "[DEBUG] Not a spec file, skipping" >> /tmp/triqual_hook_debug.log
        output_empty
        exit 0
    fi
    
    echo "[DEBUG] Spec file detected, outputting context" >> /tmp/triqual_hook_debug.log
    
    local context="[Triqual] Writing test file. BEFORE generating: quoth_search_index({ query: \"playwright test patterns\" }) to find existing Page Objects and helpers."
    output_context "$context" "PreToolUse"
}

main "$@"
