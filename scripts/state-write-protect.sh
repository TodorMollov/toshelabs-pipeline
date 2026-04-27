#!/usr/bin/env bash
# PreToolUse hook for the Write and Edit tools.
#
# Denies writes to the canonical pipeline state directory
# (PIPELINE_STATE_PROTECTED). Workers must write their per-step output to
# PIPELINE_WORKER_OUT instead — the orchestrator validates that against a
# per-step schema before merging into canonical state.
#
# No-op for any Claude Code session that does not have
# PIPELINE_STATE_PROTECTED set in its environment, so the user's other
# Claude sessions in the same project are unaffected.
#
# Wiring (project's .claude/settings.local.json or settings.json):
#
#   "hooks": {
#     "PreToolUse": [
#       {
#         "matcher": "Edit|Write|MultiEdit",
#         "hooks": [
#           {
#             "type": "command",
#             "command": "bash /home/toshe/toshelabs-pipeline/scripts/state-write-protect.sh",
#             "timeout": 5
#           }
#         ]
#       }
#     ]
#   }

set -euo pipefail

# No-op when the env var is missing or empty.
if [[ -z "${PIPELINE_STATE_PROTECTED:-}" ]]; then
  exit 0
fi

INPUT=$(cat)

# Extract file_path and tool name. Tolerate jq missing — fall back to grep.
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
else
  TOOL_NAME=$(echo "$INPUT" | grep -oE '"tool_name"\s*:\s*"[^"]+"' | head -1 | sed -E 's/.*"tool_name"\s*:\s*"([^"]+)"/\1/' || true)
  FILE_PATH=$(echo "$INPUT" | grep -oE '"file_path"\s*:\s*"[^"]+"' | head -1 | sed -E 's/.*"file_path"\s*:\s*"([^"]+)"/\1/' || true)
fi

# Only gate Write / Edit / MultiEdit / NotebookEdit. The matcher in
# settings.json should already handle this, but defense in depth.
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

[[ -z "$FILE_PATH" ]] && exit 0

# Normalise to absolute path. PIPELINE_STATE_PROTECTED is already absolute.
case "$FILE_PATH" in
  /*) ABS="$FILE_PATH" ;;
   *) ABS="$(pwd)/$FILE_PATH" ;;
esac
ABS="${ABS//\.\//}" # collapse "./"

# Block if path is inside the protected directory.
case "$ABS" in
  "$PIPELINE_STATE_PROTECTED"/*)
    HINT=""
    if [[ -n "${PIPELINE_WORKER_OUT:-}" ]]; then
      HINT=" Write your step output to \$PIPELINE_WORKER_OUT/<step>.json instead — the orchestrator validates and merges it into canonical state."
    fi
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"$ABS is the canonical pipeline state and is orchestrator-only. Workers must not write here.$HINT"}}
EOF
    exit 0
    ;;
esac

exit 0
