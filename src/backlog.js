import { readFile, writeFile } from 'fs/promises';

/**
 * Load and filter tickets from backlog.json
 */
export async function loadBacklog(config) {
  const raw = await readFile(config._resolved.backlog, 'utf-8');
  const data = JSON.parse(raw);
  return data.tickets || [];
}

/**
 * Get actionable tickets sorted by priority
 */
export function filterAndSort(tickets, config, ticketId = null) {
  if (ticketId) {
    const match = tickets.find((t) => t.id === ticketId);
    return match ? [match] : [];
  }

  const { include_status = [], exclude_status = [], priority_order, type_order } =
    config.ticket_filter;

  const actionable = tickets.filter((t) => {
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
  const archiveRaw = await readFile(config._resolved.archive, 'utf-8');
  const archive = JSON.parse(archiveRaw);
  archive.tickets = (archive.tickets || []).filter((t) => t.id !== ticketId);
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
