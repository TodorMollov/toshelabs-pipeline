#!/usr/bin/env bash
# PreToolUse hook for the Read tool.
#
# When a pipeline worker tries to Read a file the orchestrator already
# pre-loaded into the prompt, this hook returns a "block" decision with a
# message pointing at the <file> block. The worker can still re-Read by
# specifying explicit `offset` and `limit` parameters (the "I need a
# different section" escape hatch).
#
# No-op for any Claude Code session that does not have
# PIPELINE_PRELOADED_FILES set in its environment, so the user's other
# sessions in the same project are unaffected.
#
# Wiring (project's .claude/settings.local.json or settings.json):
#
#   "hooks": {
#     "PreToolUse": [
#       {
#         "matcher": "Read",
#         "hooks": [
#           {
#             "type": "command",
#             "command": "bash /home/toshe/toshelabs-pipeline/scripts/preload-soft-hook.sh",
#             "timeout": 5
#           }
#         ]
#       }
#     ]
#   }

set -euo pipefail

# No-op when the env var is missing or empty (covers the user's own Claude
# sessions outside the pipeline).
if [[ -z "${PIPELINE_PRELOADED_FILES:-}" ]]; then
  exit 0
fi

INPUT=$(cat)

# Extract file_path. Tolerate jq missing — fall back to crude grep.
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
  HAS_OFFSET=$(echo "$INPUT" | jq -r '.tool_input.offset // empty')
else
  FILE_PATH=$(echo "$INPUT" | grep -oE '"file_path"\s*:\s*"[^"]+"' | head -1 | sed -E 's/.*"file_path"\s*:\s*"([^"]+)"/\1/' || true)
  HAS_OFFSET=$(echo "$INPUT" | grep -oE '"offset"\s*:\s*[0-9]+' | head -1 || true)
fi

# Nothing to check.
[[ -z "$FILE_PATH" ]] && exit 0

# Worker explicitly asked for a different section — let it through.
[[ -n "$HAS_OFFSET" ]] && exit 0

# Normalise the path: workers can Read with absolute path, project-relative,
# or with a `./` prefix. Compare against the project-relative form because
# that's how the orchestrator records pre-loaded paths.
CWD="$(pwd)"
REL_PATH="$FILE_PATH"
REL_PATH="${REL_PATH#./}"
REL_PATH="${REL_PATH#$CWD/}"

# PIPELINE_PRELOADED_FILES is comma-separated.
IFS=',' read -ra PRELOADS <<< "$PIPELINE_PRELOADED_FILES"
for p in "${PRELOADS[@]}"; do
  if [[ "$REL_PATH" == "$p" ]]; then
    # Block with a message the worker can act on. Keeping the JSON small
    # because Claude Code echoes the reason back as a tool_result.
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"$REL_PATH is already pre-loaded in your prompt — refer to the <file path=\"$REL_PATH\"> block. If you need a section that is NOT in the pre-loaded block, retry this Read with explicit \`offset\` and \`limit\` parameters."}}
EOF
    exit 0
  fi
done

# Path not in preload set — let it through.
exit 0
