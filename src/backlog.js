import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { validateAndPartition, DEFAULT_SCHEMA_V1 } from './ticket-schema.js';

/**
 * Load and filter tickets from backlog.json.
 *
 * Applies ticket-schema validation per `config.ticket_schema` (mode: off |
 * warn | strict). Rejected tickets get sidecar files at
 * `pipeline-state/{id}.rejected.json` and are emitted on `config._emitter`
 * as `ticket_rejected` events. In `strict` mode they're excluded from the
 * returned list; in `warn` mode they pass through with violations recorded.
 *
 * Default mode is `off` — backwards compatible with project configs that
 * predate the schema. Opt in via `ticket_schema.mode: warn|strict`.
 */
export async function loadBacklog(config) {
  const raw = await readFile(config._resolved.backlog, 'utf-8');
  const data = JSON.parse(raw);
  const tickets = data.tickets || [];

  const schemaCfg = config.ticket_schema || {};
  const mode = schemaCfg.mode || 'off';
  if (mode === 'off') return tickets;

  const acceptedVersions = schemaCfg.accepts_schema_versions || [1];
  const overrides = schemaCfg.overrides || {};
  const requireAcceptanceCriteria = schemaCfg.require_acceptance_criteria === true;
  const sidecarPathFor = (id) => resolve(config._resolved.pipelineDir, `${id}.rejected.json`);

  const { accepted, rejected } = await validateAndPartition(tickets, {
    schema: DEFAULT_SCHEMA_V1,
    overrides,
    mode,
    sidecarPathFor,
    acceptedVersions,
    requireAcceptanceCriteria,
  });

  if (rejected.length > 0) {
    const summary = rejected.map((r) => `${r.id} (${r.violations.length} violation${r.violations.length === 1 ? '' : 's'})`).join(', ');
    console.warn(`[schema:${mode}] ${rejected.length} ticket${rejected.length === 1 ? '' : 's'} failed validation: ${summary}`);
    if (config._emitter) {
      for (const r of rejected) {
        config._emitter.emit('ticket_rejected', {
          timestamp: r.timestamp,
          ticket: r.id,
          mode,
          violations: r.violations,
        });
      }
    }
  }

  return accepted;
}

/**
 * Get actionable tickets sorted by priority
 */
export function filterAndSort(tickets, config, ticketId = null) {
  if (ticketId) {
    const match = tickets.find((t) => t.id === ticketId);
    return match ? [match] : [];
  }

  const { include_status = [], exclude_status = [], exclude_type = [], priority_order, type_order } =
    config.ticket_filter;

  const actionable = tickets.filter((t) => {
    // Type-level exclusion: keeps human-only work (e.g. type=manual — Play
    // console submission, marketing uploads) out of the agent's actionable
    // queue so the pipeline never spends tokens attempting what it can't finish.
    if (exclude_type.includes(t.type)) return false;
    if (exclude_status.includes(t.status)) return false;
    if (include_status.length > 0 && !include_status.includes(t.status))
      return false;
    return true;
  });

  // Tickets with explicit `order` come first (ascending), then auto-sort by priority/type
  actionable.sort((a, b) => {
    const oa = a.order != null ? a.order : Infinity;
    const ob = b.order != null ? b.order : Infinity;
    if (oa !== ob) return oa - ob;

    // Both have no explicit order — fall back to priority + type sort
    const pa = priority_order.indexOf(a.priority || 'P3');
    const pb = priority_order.indexOf(b.priority || 'P3');
    if (pa !== pb) return pa - pb;

    const isBugA = (a.type || '').includes('bug') ? 0 : 1;
    const isBugB = (b.type || '').includes('bug') ? 0 : 1;
    if (isBugA !== isBugB) return isBugA - isBugB;

    const ta = type_order.indexOf(a.type || 'feature');
    const tb = type_order.indexOf(b.type || 'feature');
    return ta - tb;
  });

  return actionable;
}

/**
 * Move a ticket from backlog to archive. When the ticket is a bug
 * (type='bug' or id starts with 'BUG-'), also append a compact record
 * to closed-bugs.json so the closed-bug ledger stays in sync.
 *
 * opts.landedCommit — optional sha to record on the archived ticket.
 *   Useful when the ticket was landed via manual squash-merge rescue
 *   rather than the pipeline's own success path, so future audits can
 *   still trace the code change.
 *
 * Returns the archived ticket, or null when the id isn't in backlog.
 */
export async function archiveTicket(ticketId, config, opts = {}) {
  // Read backlog
  const backlogRaw = await readFile(config._resolved.backlog, 'utf-8');
  const backlog = JSON.parse(backlogRaw);

  const idx = backlog.tickets.findIndex((t) => t.id === ticketId);
  if (idx === -1) return null;

  const ticket = backlog.tickets.splice(idx, 1)[0];
  ticket.status = 'done';
  const nowIso = new Date().toISOString();
  ticket.completed = nowIso.split('T')[0];
  ticket.completed_at = nowIso;
  if (opts.landedCommit) ticket.landed_commit = opts.landedCommit;

  // Write updated backlog
  backlog.updated_at = nowIso.split('T')[0];
  await writeFile(config._resolved.backlog, JSON.stringify(backlog, null, 2));

  // Append to archive. Dedupe by id so repeated archive calls don't
  // create duplicate archive entries — matches the behaviour of the
  // manual rescue script.
  let archive = { tickets: [] };
  try {
    archive = JSON.parse(await readFile(config._resolved.archive, 'utf-8'));
    if (!Array.isArray(archive.tickets)) archive.tickets = [];
  } catch { /* missing/invalid — start fresh, matches closed-bugs handling below */ }
  archive.tickets = archive.tickets.filter((t) => t.id !== ticketId);
  archive.tickets.push(ticket);
  await writeFile(config._resolved.archive, JSON.stringify(archive, null, 2));

  // Bug? Also append to the closed-bugs ledger. The ledger is a
  // separate file in config (closed_bugs_file) — skip gracefully when
  // the config or the file doesn't exist.
  const isBug = ticket.type === 'bug' || /^BUG-/.test(ticket.id || '');
  if (isBug) {
    try {
      const cbPath = config._resolved.closedBugs;
      if (cbPath) {
        let cb = { tickets: [] };
        try {
          cb = JSON.parse(await readFile(cbPath, 'utf-8'));
          if (!Array.isArray(cb.tickets)) cb.tickets = [];
        } catch { /* missing/invalid — start fresh */ }
        cb.tickets = cb.tickets.filter((t) => t.id !== ticketId);
        cb.tickets.push({
          id: ticket.id,
          title: ticket.title || '',
          fixed_at: nowIso,
          commit: opts.landedCommit || null,
        });
        await writeFile(cbPath, JSON.stringify(cb, null, 2));
      }
    } catch (err) {
      // Archive already succeeded — don't surface the ledger failure.
      console.warn(`[archive] ${ticketId}: closed-bugs update failed — ${err.message}`);
    }
  }

  // 2026-04-28: backlog files are gitignored at the project level — no
  // git interaction needed. archiveTicket just persists the JSON; the
  // file lives on local disk only. The previous "atomic commit" path
  // existed to keep tracked files in sync with the orchestrator's
  // expectations of a clean tree; with the files untracked, every git
  // refusal class (DIRTY_TREE, reset wiping operator edits) is moot.

  return ticket;
}

/**
 * PIPE-021 bounded cherry-pick retry: park a ticket the pipeline cannot land
 * after N attempts so it stops re-queuing and burning tokens forever. Sets
 * status (use one in the project's exclude_status, e.g. 'manual') + a
 * machine-readable blocked reason. Idempotent; no-op if ticket absent.
 */
export async function setBacklogTicketStatus(ticketId, config, status, reason) {
  const raw = await readFile(config._resolved.backlog, 'utf-8');
  const backlog = JSON.parse(raw);
  const t = (backlog.tickets || []).find((x) => x.id === ticketId);
  if (!t) return null;
  t.status = status;
  if (reason) t.blocked_reason = reason;
  t.blocked_at = new Date().toISOString();
  backlog.updated_at = new Date().toISOString().split('T')[0];
  await writeFile(config._resolved.backlog, JSON.stringify(backlog, null, 2));
  return t;
}

/**
 * Move a ticket up or down in execution order.
 * Assigns explicit `order` values to all actionable tickets, then swaps the target.
 */
export async function reorderTicket(ticketId, direction, config) {
  const raw = await readFile(config._resolved.backlog, 'utf-8');
  const data = JSON.parse(raw);
  const tickets = data.tickets || [];

  // Get sorted actionable list to determine current positions
  const actionable = filterAndSort(tickets, config);
  const idx = actionable.findIndex((t) => t.id === ticketId);
  if (idx === -1) return null;

  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= actionable.length) return null;

  // Assign order values to all actionable tickets based on current sort
  actionable.forEach((t, i) => {
    const src = tickets.find((s) => s.id === t.id);
    if (src) src.order = i;
  });

  // Swap the two
  const srcTicket = tickets.find((t) => t.id === actionable[idx].id);
  const swpTicket = tickets.find((t) => t.id === actionable[swapIdx].id);
  const tmp = srcTicket.order;
  srcTicket.order = swpTicket.order;
  swpTicket.order = tmp;

  data.updated_at = new Date().toISOString().split('T')[0];
  await writeFile(config._resolved.backlog, JSON.stringify(data, null, 2));

  // Return new sorted list
  return filterAndSort(tickets, config);
}

/**
 * Reload backlog (for refresh button)
 */
export async function reloadBacklog(config) {
  return loadBacklog(config);
}
