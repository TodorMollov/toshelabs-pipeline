#!/usr/bin/env bash
# Chaos test for the soft pipeline's phase-verification + restart-resume.
#
# Strategy: simulate a worker that wrote checkpoints for some phases then
# died mid-way, and confirm that determineResumePoint correctly identifies
# where to resume. Does NOT actually run Claude — operates on synthetic
# checkpoint files written to a temp dir.
#
# Coverage:
#   1. Empty ticket dir       → resume from plan
#   2. Plan only              → resume from tests_red
#   3. Plan + tests_red       → resume from implement
#   4. Plan + corrupted tr    → halt for operator
#   5. Plan + tr + impl + tg  → resume from docs_update (feature) or review (chore)
#   6. All worker phases done → resume null (move to review spawn)
#   7. Partial write (.tmp only, no rename) → resume from that phase
#   8. Worktree-checkpoint divergence (declared file not in worktree)
#      → halt for operator

set -euo pipefail
cd "$(dirname "$0")/.."

PIPELINE_DIR=$(pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

WORKTREE="$TMP/worktree"
TICKET_DIR="$TMP/wo/T-TEST"
mkdir -p "$WORKTREE" "$TICKET_DIR"
cd "$WORKTREE" && git init -q && git commit --allow-empty -qm baseline >/dev/null 2>&1
cd "$PIPELINE_DIR"

pass=0; fail=0
declare -a fails

run_case() {
  local desc="$1"; shift
  local expected="$1"; shift
  local ticket="$1"; shift
  local phases_js="${1:-undefined}"
  local actual
  actual=$(node -e "
    import('$PIPELINE_DIR/src/phase-verify.js').then(m => {
      const phases = $phases_js;
      const r = m.determineResumePoint({
        ticketDir: '$TICKET_DIR',
        worktree: '$WORKTREE',
        ticket: $ticket,
        ...(phases ? { phases } : {}),
      });
      console.log(JSON.stringify({ resumeFrom: r.resumeFrom, requiresOperator: r.requiresOperator || false, divergences: r.divergences.length }));
    });
  ")
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $desc"
    pass=$((pass + 1))
  else
    echo "  ✗ $desc"
    echo "    expected: $expected"
    echo "    got:      $actual"
    fails+=("$desc")
    fail=$((fail + 1))
  fi
}

reset_ticket() { rm -rf "$TICKET_DIR"/*.json "$TICKET_DIR"/*.tmp 2>/dev/null || true; }

valid_plan() {
  cat > "$TICKET_DIR/plan.json" <<'EOF'
{"ticket":"T-TEST","files_to_change":[{"path":"app/lib/foo.dart","reason":"new feature","what_to_do":"add bar method"}],"test_strategy":"unit test in foo_test.dart"}
EOF
}
valid_tests_red() {
  mkdir -p "$WORKTREE/app/test"
  touch "$WORKTREE/app/test/foo_test.dart"
  cat > "$TICKET_DIR/tests_red.json" <<'EOF'
{"tests_added":[{"path":"app/test/foo_test.dart","deliverable":"add bar method"}],"failure_evidence":{"app/test/foo_test.dart":"undefined method bar"}}
EOF
}
valid_implement() {
  mkdir -p "$WORKTREE/app/lib"
  touch "$WORKTREE/app/lib/foo.dart"
  cat > "$TICKET_DIR/implement.json" <<'EOF'
{"files_changed":["app/lib/foo.dart"],"files_skipped":[],"changes_summary":"added bar method"}
EOF
}
valid_tests_green() {
  cat > "$TICKET_DIR/tests_green.json" <<'EOF'
{"all_pass":true,"unit_tests":{"passed":42,"failed":0,"skipped":0},"analyzer_errors":0,"test_output_summary":"all green","metrics":{"wallMs":15000}}
EOF
}
valid_docs() {
  mkdir -p "$WORKTREE/docs"
  touch "$WORKTREE/docs/SPEC.md"
  cat > "$TICKET_DIR/docs_update.json" <<'EOF'
{"files_changed":["docs/SPEC.md"],"reason_skipped":null}
EOF
}
WORKER_PHASES='["plan","tests_red","implement","tests_green","docs_update"]'

echo "Chaos test: soft pipeline phase verification"
echo

# Case 1: empty
reset_ticket
run_case "empty ticket dir → resume from plan" \
  '{"resumeFrom":"plan","requiresOperator":false,"divergences":0}' \
  '{type:"feature"}'

# Case 2: plan only
reset_ticket; valid_plan
run_case "plan only → resume from tests_red" \
  '{"resumeFrom":"tests_red","requiresOperator":false,"divergences":0}' \
  '{type:"feature"}'

# Case 3: plan + tests_red
reset_ticket; valid_plan; valid_tests_red
run_case "plan + tests_red → resume from implement" \
  '{"resumeFrom":"implement","requiresOperator":false,"divergences":0}' \
  '{type:"feature"}'

# Case 4: corrupted tests_red (empty file)
reset_ticket; valid_plan
echo "" > "$TICKET_DIR/tests_red.json"
run_case "plan + corrupted tests_red → resume from tests_red" \
  '{"resumeFrom":"tests_red","requiresOperator":false,"divergences":0}' \
  '{type:"feature"}'

# Case 5: all worker phases done (feature)
reset_ticket; valid_plan; valid_tests_red; valid_implement; valid_tests_green; valid_docs
run_case "all worker phases done (feature) → resume null" \
  '{"resumeFrom":null,"requiresOperator":false,"divergences":0}' \
  '{type:"feature"}' \
  "$WORKER_PHASES"

# Case 6: worker phases done, type=bug (docs_update skipped → still resume null)
reset_ticket; valid_plan; valid_tests_red; valid_implement; valid_tests_green
run_case "worker phases done (bug, no docs needed) → resume null" \
  '{"resumeFrom":null,"requiresOperator":false,"divergences":0}' \
  '{type:"bug"}' \
  "$WORKER_PHASES"

# Case 7: partial write — only tmp exists
reset_ticket; valid_plan
cat > "$TICKET_DIR/tests_red.json.tmp" <<'EOF'
{"tests_added":[{"path":"app/test/foo_test.dart","deliverable":"add bar method"
EOF
run_case "partial tmp write → resume from tests_red (tmp ignored)" \
  '{"resumeFrom":"tests_red","requiresOperator":false,"divergences":0}' \
  '{type:"feature"}'

# Case 8: divergence — implement declares file that doesn't exist
reset_ticket; valid_plan; valid_tests_red
cat > "$TICKET_DIR/implement.json" <<'EOF'
{"files_changed":["app/lib/MISSING.dart"],"files_skipped":[],"changes_summary":"oops"}
EOF
run_case "divergence — implement declares missing file → halt operator" \
  '{"resumeFrom":null,"requiresOperator":true,"divergences":1}' \
  '{type:"feature"}'

# Case 9: tests_green checkpoint says all_pass=false → divergence
reset_ticket; valid_plan; valid_tests_red; valid_implement
cat > "$TICKET_DIR/tests_green.json" <<'EOF'
{"all_pass":false,"unit_tests":{"passed":40,"failed":2,"skipped":0},"analyzer_errors":0,"test_output_summary":"two failures"}
EOF
run_case "tests_green all_pass=false → halt operator" \
  '{"resumeFrom":null,"requiresOperator":true,"divergences":1}' \
  '{type:"feature"}'

# Case 10: no-test tests_red
reset_ticket; valid_plan
cat > "$TICKET_DIR/tests_red.json" <<'EOF'
{"tests_added":[],"no_test_reason":"docs-only change, no behavioural delta"}
EOF
run_case "no-test tests_red (docs-only) → resume from implement" \
  '{"resumeFrom":"implement","requiresOperator":false,"divergences":0}' \
  '{type:"feature"}'

echo
echo "Pass: $pass | Fail: $fail"
if [[ $fail -gt 0 ]]; then
  echo "Failures:"
  for f in "${fails[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "All chaos cases handled correctly."
