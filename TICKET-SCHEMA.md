# TosheLabs Pipeline — Ticket Schema

This document defines the contract for tickets that the pipeline will accept. Tickets that don't conform are rejected with a per-field reason (not silently coerced or "best-guessed"). Producers — operators, LLMs, scripts — are responsible for emitting conformant tickets.

The schema is **per-project**: each project's `pipeline.config.yaml` declares which schema version it accepts and may override field vocabularies (e.g. project-specific `type` enum values). The shape below is the **default schema (version 1)** shipped with the pipeline.

---

## Top-level structure

A backlog file is a JSON object:

```json
{
  "schema": "backlog-v1",
  "updated_at": "2026-05-03",
  "tickets": [ /* array of ticket objects */ ]
}
```

Each ticket object MUST have the required fields below. Optional fields are recognised but not enforced.

---

## Required fields

| Field | Type | Constraint |
|---|---|---|
| `id` | string | Pattern: `^[A-Z][A-Z0-9]*-\d+[A-Z]?$` (e.g. `BUG-261`, `T-359`, `BUG-261A`, `PIPE-001`). Must be unique within the backlog file. |
| `schema_version` | integer | Currently `1`. Pipeline rejects tickets whose version isn't in its configured `accepts_schema_versions` list. |
| `title` | string | 10–200 characters. Imperative, specific, no trailing punctuation. |
| `status` | enum | One of: `requested`, `in_progress`, `blocked`, `done`, `monitor`. See definitions below. |
| `priority` | enum | One of: `P0`, `P1`, `P2`, `P3`. |
| `type` | enum | One of: `bug`, `feature`, `enhancement`, `refactor`, `test`, `performance`, `ux`, `ops`. |
| `complexity` | enum | One of: `trivial`, `small`, `medium`, `large`. |
| `description` | string | ≥ 50 characters. Forces actual context, not one-liners. |

### `status` definitions (closed set)

- **`requested`** — ready to run. Pipeline will pick this up.
- **`in_progress`** — pipeline is currently working it. Set by the pipeline; producers should not set this.
- **`blocked`** — halted mid-run, needs operator. Set by the pipeline.
- **`done`** — completed cleanly. Set by the pipeline.
- **`monitor`** — observation only, no work scheduled. Operator-set. Pipeline does not pick these up.

There are no `deferred`, `subsumed`, `moot`, `decided`, `fixed`, `closed`, `archived`, `needs-info`, or other status values. Those concepts live as **fields**, not statuses:

- "I want to defer this" → `status: requested` + `priority: P3` + `defer_until: <date>` (optional field).
- "Subsumed by another ticket" → `status: done` + `subsumed_by: <ticket-id>`.
- "We discussed and decided not to do it" → `status: done` + `resolution: decided` + `decision_note: <string>`.
- "Moot — no longer relevant" → `status: done` + `resolution: moot`.

This keeps the state machine small and pipeline behaviour predictable.

### `priority`

P0 = production breakage, drop everything. P1 = important, this sprint. P2 = nice-to-have, this quarter. P3 = backlog / monitor.

### `type`

- **bug** — a defect in shipped behaviour. Pipeline runs the `root_cause` step for these.
- **feature** — net-new capability.
- **enhancement** — improves an existing feature.
- **refactor** — changes structure without changing behaviour.
- **test** — adds or improves tests; no behaviour change.
- **performance** — optimisation; no behaviour change.
- **ux** — visual / interaction polish; no functional change.
- **ops** — infra, tooling, deploy, observability work.

### `complexity`

- **trivial** — single file, no logic change (rename, typo, copy edit).
- **small** — 1–3 files, contained logic.
- **medium** — up to ~10 files, multiple subsystems but no architectural shift.
- **large** — >10 files OR architectural shift OR migration. Pipeline may refuse to plan these in one shot and request a split.

---

## Optional fields

Recognised but not required. The pipeline reads them when present.

| Field | Type | Purpose |
|---|---|---|
| `area` | string | Free-form module/path hint, e.g. `app/lib/core/auth/` |
| `source` | string | How / when the ticket originated (Crashlytics ID, user email, internal review, etc.) |
| `reported` | string (ISO date) | When the issue was first observed. |
| `user_impact` | string | Who is affected, how badly. |
| `acceptance_criteria` | array of strings | GIVEN/WHEN/THEN clauses or equivalent. |
| `decisions` | array of strings | Architectural choices already made + rationale. |
| `fix_plan` | array of strings | Operator's proposed approach (the planner step uses this as a starting point). |
| `files_likely_affected` | array of strings | Hints; planner verifies. |
| `out_of_scope` | array of strings | Explicit non-goals. |
| `blocked_by` | array of strings | Other ticket IDs that must complete first. Pipeline respects ordering but does not currently enforce. |
| `tags` | array of strings | Free-form labels. Project config can constrain to a closed vocabulary if desired. |
| `defer_until` | string (ISO date) | Don't pick up before this date. |
| `subsumed_by` | string | When `status: done` + this ticket was rolled into another. |
| `resolution` | enum | When `status: done`, why: `fixed` (default), `decided`, `moot`, `wont_fix`. |
| `decision_note` | string | Required when `resolution: decided`. |

---

## Pipeline-managed fields

These are **set by the pipeline**; producers must not write them. If present in an incoming ticket, the validator strips them before processing.

- `archived_at` — set when the pipeline moves the ticket to the archive file.
- `landed_commit` — sha of the ticket's commit on master.
- `merge_status` — pending/merged tag info.
- `pipeline_state_ref` — points at `projects/{name}/pipeline-state/{id}.json`.

---

## Project configuration (per-project schema overrides + filtering)

In `pipeline.config.yaml`, a project can declare:

```yaml
ticket_schema:
  accepts_schema_versions: [1]      # tickets at any other version are rejected
  reject_action: skip               # skip | halt
  rejection_sidecar: pipeline-state/{id}.rejected.json

  # Optional: override default enums for this project
  overrides:
    type:
      add: [marketing, content]      # extends the default enum
    complexity:
      replace: [xs, s, m, l, xl]     # replaces the default enum entirely
```

And the existing `ticket_filter` block decides which **conformant** tickets become actionable in a given run (e.g. `exclude_status: [done, monitor]`).

---

## Rejection behaviour

When a ticket fails validation:

1. The ticket is **excluded** from the actionable queue (does not run).
2. A sidecar file is written: `projects/{name}/pipeline-state/{id}.rejected.json` containing the ticket id, the violations (field-level), and the timestamp.
3. An event is emitted: `ticket_rejected` with the same payload, visible in the dashboard.
4. The ticket is **left in `backlog.json`** (not archived) so the operator can edit and re-run.

Rejection is final for the run — no LLM "fix the ticket" loop. Producers fix tickets, not the pipeline.

---

## How to instruct LLMs to produce conformant tickets

Three layers, weakest to strongest:

**1. Reference the schema in CLAUDE.md** (per-project)

Add to each project's `CLAUDE.md`:

```markdown
## Backlog tickets

When creating or editing tickets in `memory/backlog.json`, conform to the schema at
`~/toshelabs-pipeline/TICKET-SCHEMA.md`. Required fields: id, schema_version, title,
status, priority, type, complexity, description. Statuses are restricted to:
requested, in_progress, blocked, done, monitor. Use `resolution: decided|moot|wont_fix`
on done tickets to capture "we chose not to do it" — do NOT invent new statuses.
```

This is the cheapest path. LLMs will mostly comply if the schema is short and named in the prompt.

**2. Provide a JSON Schema file** (per-project, machine-checkable)

Ship `~/toshelabs-pipeline/schemas/ticket.v1.schema.json` (proper JSON Schema). LLMs that support structured output / tool-use can reference it directly. Operator scripts can validate before commit. Producers can run `ajv validate -s ticket.v1.schema.json -d backlog.json` as a pre-commit hook.

**3. Pre-commit hook in each project repo**

A git pre-commit hook that runs the validator against `memory/backlog.json` and rejects the commit if any ticket is non-conformant. This catches issues at the producer side before they reach the pipeline. Cheapest enforcement once set up.

Recommended order: start with #1 (immediate), add #2 (one file), enable #3 (one hook) when the schema stabilises.

---

## Multi-project + parallel work (forward-looking)

The schema is written to support what's coming, even if the runtime doesn't yet:

- **Per-project config** — `pipeline.config.yaml` is already per-project. Each project has its own `backlog.json`, `worktree/`, `pipeline-state/`, `code_lock`. Switching = pointing the server at a different config (e.g. `--config configs/busydad.yaml` vs `--config configs/projectX.yaml`) or a project registry the dashboard can switch between.
- **Parallel tickets within one project** — each ticket already gets its own worktree path under `projects/{name}/worktree-{id}/`. The current single-runner constraint (one `code_lock` per project) can be relaxed to a per-ticket lock. Cherry-pick to master serialises at the end. Risk: ordering conflicts on touched files — the validator can pre-flight by inspecting `files_likely_affected` overlaps and refusing to schedule conflicting tickets in parallel.
- **Parallel projects** — already supported architecturally (different config = different code_lock = different worktree). Just needs UI / API to expose multiple pipelines.

These are forward-looking design notes, not a current promise. The schema doesn't change to enable them — fields like `id` and `blocked_by` already carry the information the parallel scheduler will need.

---

## Versioning

Schema changes are versioned; tickets carry their `schema_version`. Pipeline configs declare which versions they accept (`accepts_schema_versions: [1, 2]` during a migration window). Migration scripts live in `~/toshelabs-pipeline/scripts/migrate-tickets-{from}-to-{to}.js`.

Bumping the schema:

1. Add `~/toshelabs-pipeline/TICKET-SCHEMA.md` section "Version N changes".
2. Add `~/toshelabs-pipeline/schemas/ticket.vN.schema.json`.
3. Add migration script.
4. Update default `accepts_schema_versions` once all projects have migrated.

---

## Default schema version: **1**
