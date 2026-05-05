# Working on the pipeline itself

The TosheLabs Pipeline operates on **other projects** (busydad, pension-ai, etc.) — it does not run against itself. Pipeline bugs and features are worked on by **operator + Claude Code** interactive sessions, the same way every PIPE-* ticket through PIPE-011 has been built.

This file is the explicit pattern, written so a fresh Claude session (with no context from earlier work) can read it and understand the workflow without re-discovering it from the commit log.

---

## Why the pipeline doesn't run against itself

Tempting idea, deliberate non-goal. The pipeline runs by spawning Claude CLI subprocesses; if the pipeline were modifying its own source while interpreting it, you have two failure modes that get expensive fast:

1. **Source-vs-running drift**: a step modifies `src/pipeline.js` while a different step's worker is reading it. The orchestrator and the worker disagree about what the pipeline IS, and the next step picks up half of yesterday's behaviour and half of today's.
2. **Worktree mitigation isn't enough**: the existing per-ticket worktree pattern would, in principle, isolate the modifications. But the pipeline binary itself has to be RUNNING from somewhere — and that "somewhere" is the source you'd be modifying. Any path that resolves to `~/toshelabs-pipeline/src/...` becomes load-bearing in a way that makes mistakes catastrophic.

The cost of an interactive operator-driven flow is small: pipeline tickets ship at human pace. The cost of a corrupted pipeline mid-self-modification is much higher.

So: **operator-driven, interactive, always.**

---

## Where pipeline tickets live

`~/toshelabs-pipeline/backlog/backlog.json` — the pipeline's own backlog, conformant to schema v1 (same schema as any other project). Every PIPE-* ticket is filed here. It's git-tracked in the pipeline repo so the history of what was decided + shipped + still-pending is durable.

Today (2026-05-05) this file is read/written by hand. It's NOT exposed via the MCP server's `create_ticket` tool — that's a future extension (call it "PIPE-MCP-self-expose" if you want to file it).

---

## How pipeline work happens

A typical session looks like this:

1. **Operator** (you) opens a Claude Code session in `~/toshelabs-pipeline/`.
2. **Claude** reads `backlog/backlog.json` to see what's pending.
3. **Operator** picks a ticket or describes new work; **Claude** files a new ticket if needed.
4. **They iterate**: Claude proposes implementation, makes edits to `src/`, restarts the server (`./start.sh restart`), smoke-tests, commits, pushes.
5. **Ticket gets marked done** in the backlog with `landed_commit` + `shipped_at` + `shipped_note`.

That's it. There's no automation, no dispatcher, no agent watching the backlog. The "queue" is "whatever you want to work on next."

---

## Schema applies here too

Pipeline tickets must conform to schema v1 — `~/toshelabs-pipeline/TICKET-SCHEMA.md` is authoritative. Required fields, closed status enum, etc. The same validator that runs on busydad's `state/backlog.json` would run on the pipeline's own backlog if the pipeline ever loaded it as a project. (It currently doesn't — the pipeline backlog is hand-edited via the python-snippet pattern visible in recent commits.)

If you violate the schema authoring a PIPE ticket, no validator will yell at you — but the next operator will, when they read it.

---

## The shape of a good PIPE ticket

Look at PIPE-001 (`f3f4db8`) or PIPE-008 (`55be660`) for examples. The common shape:

- **Source** — what concrete event/observation made you file this. Often "operator audit" or "code review of {sha} surfaced..."
- **Description** — one paragraph of what changes.
- **Acceptance criteria** — GIVEN/WHEN/THEN format. These are how a future Claude session knows it's done.
- **Decisions** — the non-obvious calls + rationale. So a future implementer doesn't re-litigate.
- **Out of scope** — what NOT to bundle. Often more useful than the in-scope list.
- **Fix plan** — a numbered checklist a future implementer can walk down.

Tickets that skip these tend to get re-discussed at implementation time, which wastes a session.

---

## Restart-after-edit etiquette

The pipeline server caches projects + config in memory. Any change to `src/server.js`, `src/pipeline.js`, `src/config.js`, etc. requires a server restart to take effect. Use `./start.sh restart` (post-`9fc9dc8` it's SIGTERM-then-poll-1s-then-SIGKILL — fast and decisive).

A few specific things DON'T require restart:
- Project YAML edits to `~/.toshelabs/projects/*.yaml` — pick up via `POST /api/projects/refresh` (or the dashboard ↻ button next to the picker).
- Active project's config edits — the existing `watchFile` polling on `pipeline.config.yaml` calls `reloadConfig` automatically.
- Backlog edits — `POST /api/backlog/refresh` re-reads.

Everything else: restart.

---

## What about the running pipelines?

If a project's pipeline is RUNNING when you need to restart the server: `POST /api/projects/{id}/stop` (or `POST /api/stop` for the active one). This always SIGTERMs the active step's Claude subprocess (PIPE-009: stop is decisive, no soft-stop semantic). The orchestrator's crash recovery resumes the in-flight ticket on the next `/api/run/all`.

If you don't stop first, `start.sh restart` will SIGTERM-then-SIGKILL the whole node process, including any active Pipelines — those tickets land in `in_progress` state and get resumed on next run too. Either path is non-destructive.

---

## Pushing

Commit + push pipeline changes to `origin/main` whenever you're done with a ticket. The repo is on GitHub at `TodorMollov/toshelabs-pipeline`. Operator manages git auth.

Don't push half-finished work. Each PIPE-* ticket should land as a self-contained commit (or 2-3 if scope demands), with the commit message tied back to the ticket id and acceptance criteria.

---

## What's missing from this workflow (future work)

- **Schema validator on the pipeline's own backlog.** Today's hand-edits could land non-conformant tickets and nothing would catch it.
- **MCP `create_ticket` exposure for pipeline-self.** Once that lands, any Claude session in any project could file PIPE-* tickets via the MCP tool, instead of hand-editing JSON.
- **Pre-commit hook on `src/` changes** that reminds you to bump the `_last_session_note` in the backlog if a PIPE ticket got marked done.

None of these are blockers; they'd just polish the experience.

---

## Quick reference — the commands you'll use

```bash
# After editing source:
./start.sh restart

# After editing a project YAML in ~/.toshelabs/projects/:
curl -s -X POST http://localhost:3847/api/projects/refresh

# Reading the backlog (or use the dashboard's MCP get-schema for the active project):
cat ~/toshelabs-pipeline/backlog/backlog.json | python3 -m json.tool | less

# Marking a ticket done — substitute id + sha:
python3 -c "
import json
p='/home/toshe/toshelabs-pipeline/backlog/backlog.json'
d=json.load(open(p))
for t in d['tickets']:
    if t['id']=='PIPE-XXX':
        t['status']='done'; t['landed_commit']='<sha>'; t['shipped_at']='<YYYY-MM-DD>'
        t['shipped_note']='<one-line summary of what shipped>'
json.dump(d, open(p,'w'), indent=2); open(p,'a').write('\n')
"
```

---

That's the workflow. Operator + Claude, interactive, schema-conformant, commit-and-push per ticket. No dispatcher, no autonomy.
