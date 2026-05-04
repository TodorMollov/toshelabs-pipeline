# TosheLabs Pipeline

An external orchestrator for [Claude Code](https://claude.com/claude-code) that runs a **TDD-shaped, multi-step pipeline against a backlog of tickets** — autonomously, with crash recovery, rate-limit awareness, and a live web UI.

> Status: experimental. Built for the author's personal project under a Claude Max plan.

## What it does

Given a JSON backlog file, the pipeline processes tickets one at a time through an opinionated sequence of steps. For each ticket it spawns one or more Claude CLI sessions, validates the output against a per-step schema, and writes per-ticket state to disk.

### The per-ticket flow

```
plan → tests_red → implement → tests_green → review → [root_cause] → docs_update
```

- **plan** — Opus reads the ticket + project context, produces a structured plan (files to change, edge cases, test strategy). Gated by a "think-loop" that challenges the plan and rewrites if weak.
- **tests_red** — Sonnet writes new failing tests and records baseline failures.
- **implement** — Sonnet writes the minimal change needed to make the new tests pass. Reuses the tests_red session for cheap context.
- **tests_green** — Haiku runs the tests and confirms no regressions.
- **review** — Opus re-reads the diff against a checklist, fixes findings inline. Think-loop applies here too.
- **root_cause** — (bugs only) explains the defect mechanism for the build log.
- **docs_update** — Sonnet rolls docs / backlog / build log forward.

Each step is configured in `pipeline.config.yaml` — model, allowed tools, max turns, validation rules, whether the session is reused, whether a think-loop runs.

## What's distinctive

- **TDD-enforced per ticket** — tests written before code, validated by gates that check outcome + criteria-to-test mapping.
- **Session reuse between adjacent steps** — tests_red → implement, tests_green → review, root_cause → docs_update. Reduces redundant context re-reads.
- **Think-loop** — expensive steps (plan, implement, review) re-challenge their own output for up to N rounds before committing.
- **Self-heal** — when a gate fails, the pipeline re-invokes the same step with the failure reason injected, up to 3 times.
- **5-hour window awareness** — parses rate-limit events from the Claude CLI stream, pauses until the next window, resumes automatically.
- **Crash recovery** — each step writes state to a per-ticket JSON; on restart, in-progress tickets resume from the failed step.
- **Code lock** — a file-based lock prevents two pipeline runs (or the user) from editing the target repo concurrently.
- **Live monitoring UI** — Express + SSE web console at `http://localhost:3847` with per-step metrics, 5h window, context usage.

## Requirements

- Node 20+
- Claude Code CLI installed and authenticated
- A target project with:
  - a backlog JSON (shape documented below)
  - a set of prompt templates (referenced from your config)
  - a test/analyzer wrapper script (e.g. `run-tests.sh`)

## Setup

```bash
git clone https://github.com/TodorMollov/toshelabs-pipeline.git
cd toshelabs-pipeline
npm install
cp pipeline.config.example.yaml pipeline.config.yaml
# Edit pipeline.config.yaml — set name, project_dir, context_files, etc.
./start.sh
```

Then open http://localhost:3847

Your local `pipeline.config.yaml` is gitignored — it's where you encode the paths specific to your machine and project.

## Config shape

See `pipeline.config.example.yaml`. Key sections:

- `project_dir` — absolute path to the target repo.
- `backlog_file` — JSON with a `tickets: [...]` array.
- `context_files` — markdown files injected into the plan step so Claude has project context.
- `validation_rules` — a markdown file injected as a system-prompt append when `inject_validation_rules: true` on a step.
- `session.model` — default model; each step can override.
- `steps[]` — ordered list of steps. Each step has `name`, `prompt_template`, `tools`, `model`, `max_turns`, and a `validation` block.

## Backlog shape

The pipeline accepts tickets that conform to a versioned schema. Full contract — required/optional fields, enums, rejection behaviour, multi-project notes, and how to instruct LLMs to produce conformant tickets — lives in **[TICKET-SCHEMA.md](./TICKET-SCHEMA.md)**.

Minimum required ticket:

```json
{
  "id": "T-100",
  "schema_version": 1,
  "title": "Short imperative description, 10–200 chars",
  "type": "bug | feature | enhancement | refactor | test | performance | ux | ops",
  "priority": "P0 | P1 | P2 | P3",
  "complexity": "trivial | small | medium | large",
  "status": "requested | in_progress | blocked | done | monitor",
  "description": "≥ 50 chars of actual context"
}
```

Status is a closed set of five values. Concepts like "deferred", "subsumed", "moot", "decided" live as **fields** (`defer_until`, `subsumed_by`, `resolution`, `decision_note`) on `done`-status tickets — not as separate statuses. See TICKET-SCHEMA.md for the full list and rationale.

Tickets that don't validate are skipped from the actionable queue and emit a `ticket_rejected` event with field-level reasons (sidecar at `pipeline-state/{id}.rejected.json`). The pipeline does not silently coerce or auto-fix tickets — producers (operator, LLM, scripts) are responsible for shape.

## Endpoints

- `GET  /` — web UI
- `GET  /events` — Server-Sent Events stream (terminal feed)
- `GET  /api/backlog` — current backlog (actionable + all)
- `GET  /api/pipeline/:ticketId` — per-ticket state
- `GET  /api/usage` — current 5h / 7d usage
- `POST /api/run/ticket/:id` — run one ticket
- `POST /api/run/all` — run the whole actionable queue
- `POST /api/stop` — stop after current step (releases code lock)

## Checkpoints (META-001 Phase 3)

Opt-in per-ticket git branch + per-step snapshot commits. When enabled,
the pipeline makes every step atomic at the git layer: success → commit
+ tag; failure → working tree rewound to the previous snapshot so
partial work never leaks onto disk.

```yaml
# pipeline.config.yaml
checkpoints:
  enabled: true                   # opt-in, default false
  keep_branch_on_success: false   # delete branch + step tags when done
  merge_to_master: true           # squash-merge at clean completion (Phase 4)
```

### How it works

1. **Ticket start** — `ensureBranch` creates `pipeline/{ticketId}` branched
   off `master`. Refuses if the working tree is dirty (commit or stash
   first). Recovers stale branches from crashed runs by resetting to
   master tip and cleaning untracked files.
2. **After each passing step** — `commitStepSnapshot` stages everything
   under `project_dir`, commits with message
   `[pipeline] {ticketId} step-{N}-{stepName}`, and tags the commit
   `pipeline/{ticketId}/step-{N}-{stepName}`. Zero-change steps are a
   no-op (no commit, no tag).
3. **Step failure (after heal exhaustion)** — `revertToLastSnapshot`
   resets the working tree to the most recent step tag, or to the
   branch base if no snapshots exist. `git clean -fd` drops any
   untracked files the failed step wrote.
4. **Ticket completes successfully** — if `merge_to_master: true`
   (default when checkpoints are enabled), the ticket branch is
   squash-merged into master as ONE commit per ticket. The commit
   subject is `[{ticketId}] {title}`; the body lists the step tags
   for audit. After the merge, unless `keep_branch_on_success: true`,
   the branch and all its step tags are deleted.

### Squash-merge semantics (Phase 4)

- **Replaces** `reconcile-graveyard.js` for projects with checkpoints
  enabled. Each pipeline run produces its own commits atomically;
  no batch attribution step runs after the fact.
- **Conflict handling**: if master has moved under the pipeline and
  the merge conflicts, the attempt is aborted (`git merge --abort`),
  master is left at its current tip, and the ticket branch is
  preserved untouched. The orchestrator emits
  `ticket_merge_conflict { ticket, code, message }` and proceeds to
  the next ticket. Operator runs
  `git checkout pipeline/{id} && git rebase master` then re-runs the
  ticket (which will skip directly to the merge step).
- **Dirty master**: the merge refuses if master has uncommitted
  local changes (same event, code `DIRTY_TREE`). Commit or stash
  first.
- **Empty branch** (every step was a no-op): no commit, no error.
  Branch is cleaned up as usual.

### What this prevents

The class of defect seen in BUG-206, BUG-211, T-343 on 2026-04-17..19:
a step that blocks on `_maxTurnsHit` or a failed gate leaves partial
files on disk. The next ticket's baseline treats those files as
pre-existing; graveyard reconciliation later commits them under
whichever ticket's plan happens to name overlapping paths. With
checkpoints on, those files are gone the moment the step fails.

### Events emitted

- `checkpoint_branch_ready { ticket, branch, createdFromMaster, recoveredFromExisting }`
- `checkpoint_refused { ticket, reason }` — dirty tree at ticket start
- `checkpoint_step_committed { ticket, step, sha }`
- `checkpoint_reverted { ticket, step }`
- `checkpoint_reverted_for_restart { ticket, from, to }` — Phase 5B, git state rewound for restart
- `checkpoint_merged_to_master { ticket, sha }` — Phase 4, on successful squash-merge
- `ticket_merge_conflict { ticket, code, message }` — Phase 4, merge aborted; branch preserved
- `ticket_restart_triggered { ticket, failedStep, restartFromStep, restartCount, maxRestarts }` — Phase 5B
- `ticket_restart_declined { ticket, failedStep, reason, restartCount, maxRestarts }` — Phase 5B
- `checkpoint_branch_cleaned { ticket }`

## Retry escalation + restart-from-N-1 (META-001 Phase 5)

Two independent mechanisms that compose with checkpoints.

### Escalation ladder (Phase 5A)

Heal attempts within a single step now climb a model-capability ladder
rather than spinning Sonnet twice. Attempt 1 honours `stepConfig.model`
(explicit per-step pins like "plan always on opus" are preserved);
heals 2+ walk the ladder:

```yaml
restart:
  escalation_ladder:
    - haiku    # attempt 2 (first heal)
    - sonnet   # attempt 3
    - opus     # attempt 4+ (clamped to top)
```

### Restart-from-step-N-1 (Phase 5B)

When a step exhausts all heal attempts, the pipeline optionally walks
back one step and re-runs it — on the theory that a weak plan or weak
tests_red causes downstream steps to fail, and retrying the downstream
step with a smarter model can't rescue the upstream gap.

```yaml
restart:
  enabled: true         # opt-in, default false
  max_restarts: 1       # how many walk-backs per ticket
```

Walk-back steps:

1. Emit `ticket_restart_triggered` with failed step + restart-from step.
2. Reset both steps' pipeline-state status to `pending`.
3. If checkpoints are enabled: revert the working tree to the N-2
   snapshot so the prior step re-runs with the same inputs it had
   originally.
4. Decrement the step-loop index; the prior step re-executes.
5. The failing step then re-executes in sequence with fresh upstream
   output.

If `restart.enabled: false` or budget is exhausted, the heal-exhausted
throw propagates up as before and the ticket is marked blocked.
`ticket_restart_declined` records the "would have restarted but..."
case for audit.

### Testing

`npm test` runs the Node built-in test runner against
`test/checkpoint.test.js`. Each case spins up an isolated repo in
`/tmp` — the real project tree is never touched.

## Known limits

- Single-project per config — the pipeline runs against one `project_dir`.
- Single-builder invariant — assumes **nothing** modifies the target repo while the pipeline is running. Humans editing concurrently = broken test baselines and merge headaches.
- No dependency graph — tickets are processed in priority order, with no awareness of cross-ticket file overlap.
- WSL / Linux tested; macOS should work; Windows untested.

## License

MIT
