# Onboarding a new project to the TosheLabs Pipeline

Step-by-step setup for adding a project (call it `myapp`) to the pipeline so
its tickets, schema validation, plan critic, and write-zone enforcement all
work the same as the reference project (busydad).

This is the canonical guide. The earlier ad-hoc brief (`/tmp/busydad-mcp-onboarding.md`)
was busydad-specific; this one is project-agnostic.

---

## What "configured" means here

A project is configured when:

1. Its repo follows the **layout discipline** (`docs/`, `state/`, `secrets/`).
2. A YAML config file lives at `~/.toshelabs/projects/{id}.yaml`. The pipeline
   enumerates that directory at startup; no other registration step.
3. Its `CLAUDE.md` instructs future LLM sessions to author tickets via the
   pipeline's MCP server with direct file edits as the documented fallback.

That's it. No DB, no central registry beyond the directory, no deploy step.

---

## 1. Project repo layout

The pipeline assumes the same shape busydad ended up at after the 2026-05-03
reorg:

```
myapp/
├── app/  (or src/, lib/, etc.)    # CODE — committed
├── backend/                        # if present — committed
├── scripts/                        # automation — committed
├── docs/                           # SOURCE-OF-TRUTH — committed
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── FLOWS.md
│   ├── MEMORY.md
│   └── code_validation.md
├── state/                          # OPERATIONAL — gitignored
│   ├── backlog.json
│   ├── backlog-archive.json
│   └── closed-bugs.json
├── secrets/                        # CREDENTIALS — gitignored
├── CLAUDE.md
└── .gitignore                      # contains: /state/  /secrets/
```

Bootstrap `state/backlog.json` with the empty-but-valid shape:

```json
{"schema": "backlog-v1", "updated_at": "2026-05-04", "tickets": []}
```

Gitignore lines (in addition to whatever your stack already excludes):

```gitignore
/state/
/secrets/
```

The pipeline writes per-ticket worker output, build logs, and worktrees to
`~/toshelabs-pipeline/projects/{id}/`, NOT inside this repo. Operator never
sees pipeline state in `git status`.

---

## 2. Drop a project config in the registry

Path: `~/.toshelabs/projects/{id}.yaml`. The fastest route is to copy
busydad's config and adapt it:

```bash
cp ~/toshelabs-pipeline/pipeline.config.yaml ~/.toshelabs/projects/myapp.yaml
# edit: name, project_dir, project_profile.test_commands, plan_critic.load_bearing_files,
# steps[].write_zones.allow
```

Or copy the placeholder template at `~/.toshelabs/projects/_template.yaml`
(present after PIPE-003 shipped) and fill it in.

### Project-specific fields you'll edit

Everything else is generic — these are the few that vary per project.

| Field | What to put |
|---|---|
| `name` | Project id, matches the filename without extension. |
| `project_dir` | Absolute path to the project repo (e.g. `/home/toshe/myapp`). |
| `project_profile.tech_stack_hints` | One paragraph describing the stack so the planner uses idioms. |
| `project_profile.test_commands.unit` | The unit-test command, cwd, and stats regex for parsing pass/fail counts. |
| `project_profile.test_commands.analyzer` | The lint/typecheck command + its "clean" success marker. |
| `project_profile.test_commands.extras` | Any additional test phases (e.g. backend integration tests). |
| `plan_critic.load_bearing_files` | Globs of files where a bug breaks the app for most/all users — cold-start paths, auth, security rules, schema migrations, locale resolution, sync engines. The plan critic runs whenever a planner touches one. |
| `steps[].write_zones.allow` | Per-step allowed write paths. `plan`/`tests_red`/`implement` get code dirs + test dirs; `docs_update` gets `docs/**` + `state/build-log/**`; `plan_critic`/`tests_green`/`review`/`root_cause` get `[]` (read-only). |

### Schema overrides (optional)

If your project uses status/priority/type values that aren't in the v1
default enum, declare them in `ticket_schema.overrides`:

```yaml
ticket_schema:
  mode: warn        # start in warn for any new project; flip to strict
                    # once the backlog is clean
  accepts_schema_versions: [1]
  overrides:
    status:
      add: [v2]            # busydad adds 'v2' for the long-tail roadmap
    priority:
      add: [P4]            # busydad adds 'P4'
    type:
      add: [chore, docs, manual]
```

The default v1 enum is documented in `~/toshelabs-pipeline/TICKET-SCHEMA.md`.
Most projects won't need overrides.

---

## 3. Project's `CLAUDE.md` — the MCP authoring instruction

Add the following section to the project's `CLAUDE.md` so future LLM
sessions in that repo know to author tickets through the pipeline:

```markdown
## Backlog tickets (TosheLabs Pipeline)

This project is wired into the TosheLabs Pipeline at `~/toshelabs-pipeline/`.
All development work (features, bugs, refactors) is executed via that
pipeline. Backlog and ticket authoring go through it.

**Authoring tickets — preferred path: MCP.** The pipeline runs an MCP
server at `http://localhost:3847/mcp` (POST, JSON-RPC 2.0). Use it for
all ticket CRUD instead of editing files directly:
- Call `get_schema('myapp')` at session start to learn this project's
  effective schema (default v1 + any project-specific enum overrides).
  Don't mirror overrides into this file — fetch them live so they can't
  drift.
- `create_ticket('myapp', {...})` — validates server-side; rejects
  non-conformant payloads with field-level violations.
- `update_ticket('myapp', id, patch)` — shallow merge + revalidate.
- `archive_ticket('myapp', id)` — moves to `state/backlog-archive.json`,
  stamps `archived_at`, sets `status: done`.
- Other tools: `list_projects()`, `list_tickets('myapp', status?)`,
  `get_ticket('myapp', id)`. The MCP server is hosted in the pipeline
  process on port 3847 (same port as the dashboard, not a separate
  process).

**Fallback: direct edit of `state/backlog.json`.** Works when the pipeline
server is offline. The ticket must conform to schema v1 at
`~/toshelabs-pipeline/TICKET-SCHEMA.md` (machine schema:
`~/toshelabs-pipeline/schemas/ticket.v1.schema.json`). Required fields:
`id`, `schema_version: 1`, `title` (10–200 chars), `status`, `priority`,
`type`, `complexity`, `description` (≥50 chars). Same validation runs
whether you take the MCP path or the direct-edit path — both go through
the same code.

**Status is a closed enum**: **`requested | in_progress | blocked | done | monitor`**
(plus any project-specific overrides — fetch via `get_schema`). Do NOT
invent new statuses (no `fixed`, `closed`, `COMPLETE`, `subsumed`,
`deferred`, `reported`, `confirmed`, etc.). Use the field set instead:
a `done` ticket can carry `resolution: fixed|decided|moot|wont_fix`,
`subsumed_by: TICKET-ID`, `decision_note: ...`. A "deferred" ticket is
`requested` with `priority: P3` and an optional `defer_until` date.
Free-form prose belongs in `description`, never in `status`.

The pipeline runs in **strict** mode for projects with clean backlogs.
Non-conformant tickets are rejected with a sidecar at
`~/toshelabs-pipeline/projects/myapp/pipeline-state/{id}.rejected.json`
listing the violations.

## Repository discipline

Three categories, one rule each. **Do not put anything outside these
directories.**

- **Code** — `app/`, `backend/`, `scripts/`, etc. Always committed.
- **Source-of-truth docs** — `docs/`. Always committed.
- **Operational state** — `state/`. **Gitignored**. Backlog files,
  audit reports, build-log, scratch.
- **Secrets** — `secrets/`. Gitignored.

The pipeline writes worker output to `~/toshelabs-pipeline/projects/myapp/`,
NOT into this repo. Per-ticket pipeline state, build logs, and worktree
all live there.
```

Replace `myapp` with your project id throughout.

---

## 4. Restart the pipeline server

```bash
cd ~/toshelabs-pipeline && ./start.sh restart
```

Open `http://localhost:3847` — the project picker in the header should
now show `myapp` alongside any existing projects. Click ⚙ next to the
picker to verify the config loaded as expected (paths, schema mode,
plan_critic globs, per-step write zones).

---

## 5. Verify end-to-end

From any Claude Code session running in the new project's directory, or
from anywhere with `curl`:

```bash
curl -s -X POST http://localhost:3847/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_schema","arguments":{"project":"myapp"}}}'
```

Should return JSON-RPC with the resolved schema, including any project-
specific overrides you declared.

Then create a smoke-test ticket via MCP, verify it appears in the
dashboard backlog under your project, archive it. Round-trip clean
means the project is fully onboarded.

---

## What's automatic vs operator-managed

**Automatic** (just works once config is in place):
- Schema validation on every ticket read/write
- Plan critic gate decision (per `load_bearing_files` + complexity arm)
- Per-step write-zone violation detection
- Multi-project switching from the dashboard
- MCP tool surface for any Claude Code session

**Operator-managed** (you do these by hand):
- Editing the YAML config when changing settings outside the toggle whitelist
  (`ticket_schema.mode`, `plan_critic.enabled`, `steps[].write_zones.mode`
  are toggleable from the dashboard ⚙; everything else is YAML)
- Migrating an existing backlog to schema v1 (`scripts/migrate-tickets.js`,
  see TICKET-SCHEMA.md "Versioning" section)
- Cherry-picking pipeline-produced commits onto the project's master if
  the cherry-pick failed `DIRTY` (see `pipeline/pending-merge-{ticket}` tags)
- Restoring `state/closed-testers.txt` or other gitignored state files
  from git history if they were tracked pre-reorg

---

## Common pitfalls

- **Project_dir is wrong** → pipeline can't find the backlog file. Fix
  the absolute path in the YAML config.
- **`state/` not in `.gitignore`** → operational state pollutes git
  history. Fix gitignore + run `git rm -r --cached state/` once.
- **Test commands wrong** → `tests_green` step shows 0 tests ran or
  hangs. Verify the cmd works manually from the cwd before plumbing
  it through the pipeline.
- **`plan_critic.load_bearing_files` empty** → critic never fires on
  the load-bearing arm. Skipping is fine for trivial-class tickets,
  but you lose the L10N-1-class catch on framework-belief escapes.
  Populate with at least the cold-start paths + auth + security rules.
- **Direct file edits to `state/backlog.json` in strict mode** → if a
  hand-written ticket fails validation it gets sidecar'd as rejected,
  not loaded. Either author through MCP (recommended) or run the
  validator manually before committing the edit.

---

## Adding more than one project

The pipeline supports any number of projects under
`~/.toshelabs/projects/`. Switching the active project from the dashboard
picker (or via `--project {id}` CLI flag at startup) reroutes all
top-level routes and worker spawns to that project's config.

Cross-project parallel runs are supported architecturally (each project
has its own `code_lock`, worktree, and pipeline-state directory) but the
dashboard runs one project at a time per active selection. Switching is
refused with a 409 if a pipeline run is in flight.

Intra-project parallel ticket execution is **out of scope** (per PIPE-003
operator decision 2026-05-04) — master is a shared mutation point and
the rate-limit cap is shared.
