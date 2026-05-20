# Worker — apply review feedback (spawn 3)

You are continuing ticket {{TICKET_ID}} after the reviewer ran. You are a fresh session — re-read what you need from the checkpoint files; you have no memory of the earlier worker session.

## Inputs

- **Ticket spec**:
```json
{{TICKET_SPEC}}
```
- **Plan**: `{{WORKER_OUTPUT_DIR}}/plan.json`
- **Implement summary**: `{{WORKER_OUTPUT_DIR}}/implement.json`
- **Review findings**: `{{WORKER_OUTPUT_DIR}}/review.json` (read this — it's the authoritative list)
- **Worktree**: `{{WORKTREE_DIR}}` (your edits land here; orchestrator commits when you exit cleanly)

## Phases

### 1. `apply_review_feedback`

Read `review.json`. For each finding in `findings[]`:

- If `scope == "in_ticket"`: you MUST address it. Choose one of:
  - **`applied`**: implement the fix. Update the finding's `status` to `"applied"` and set `response.applied_at` to current ISO timestamp. Atomic-write `review.json` back to disk after each finding so partial completion is recoverable on restart.
  - **`argued`**: write a rebuttal in `response.argued_reason` (minimum 30 chars, specific reasoning — not "I disagree"). The orchestrator records this in `disputed-findings.json` for operator audit. Use sparingly — most blockers should be applied.
  - **`deferred`**: only allowed for `severity` ≤ `major`. Create a follow-up ticket entry (the orchestrator will pick it up from `disputed-findings.json`) and set `response.deferred_to_ticket` to a placeholder ID like `"FOLLOWUP_<T-XXX>"` — orchestrator assigns the real ID.
- If `scope == "adjacent"` or `scope == "unrelated"`: do NOT apply. The orchestrator files these as follow-up tickets automatically. Set status to `"deferred"` with `response.deferred_to_ticket = "AUTO_FOLLOWUP"`.

After processing every finding, re-run the test suite + analyzer. They must be clean before you proceed. If a fix you applied broke tests, fix the regression (recursive small loop, max 3 iterations; if you can't converge, halt).

**Output**: `review.json` updated in place with every finding's `status` non-`pending`. **Also write** `{{WORKER_OUTPUT_DIR}}/disputed-findings.json` summarising only the `argued`/`deferred` findings with their responses — this is what the operator audits next morning.

Markers: `<<<PHASE: apply_review_feedback_started>>>` / `<<<PHASE: apply_review_feedback_done>>>`.

### 2. `root_cause` — ONLY if ticket type == "bug"

For bug tickets, write `{{WORKER_OUTPUT_DIR}}/root_cause.json`:

```json
{
  "schema_version": 1,
  "ticket": "{{TICKET_ID}}",
  "why": "<one-paragraph mechanical explanation of why the bug occurred>",
  "why_not_caught": "<one-paragraph: which existing test/check should have caught this, and why it didn't>",
  "bug_class": "<short label, e.g. 'TOCTOU on Firestore write', 'silent catch swallows errors', 'wrong field-name constant'>",
  "new_rule": {
    "proposed": "<one-line rule to add to docs/code_validation.md that would prevent this class>",
    "or_null_if_none_needed": "<reason no rule is warranted, e.g. one-off environmental issue>"
  },
  "recurrence_check": {
    "searched_for": "<grep pattern or static check used to find other instances of the same bug class>",
    "other_instances": ["<file:line>", "..."]
  }
}
```

Markers: `<<<PHASE: root_cause_started>>>` / `<<<PHASE: root_cause_done>>>`.

### Exit

When done:
```
<<<PHASE: worker_apply_done>>>
```
…and exit. Orchestrator handles commit + cherry-pick + archive.

## Rules

- Re-read files; don't trust memory. You're a fresh session.
- The `review.json` file is mutable in this phase — you UPDATE each finding's `status` in place. Atomic write per update (write `review.json.tmp`, rename).
- Never `git commit`. Orchestrator owns commit.
- `argued` is a real option — use it when the finding is wrong (e.g. reviewer misread the contract, the finding contradicts the plan, the suggested fix would break something else). But have a concrete reason; vague "I think this is fine" responses get rejected by the operator audit and become correction tickets.
- If applying a finding requires editing files outside `plan.files_to_change` (e.g. the reviewer found a real bug in an adjacent file), record this in `disputed-findings.json` AND apply — the diff scope grew, but the work is genuinely required.

## What "good" looks like

- Most findings applied directly with clear fixes.
- 0-2 `argued` per ticket on average; each with substantive reasoning.
- 0-2 `deferred` per ticket on average; each with clear follow-up handle.
- Suite stays green after apply.
- `disputed-findings.json` (if non-empty) reads like a code review thread — both sides articulated.
