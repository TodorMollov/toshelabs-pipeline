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
 * Move a ticket from backlog to archive
 */
export async function archiveTicket(ticketId, config) {
  // Read backlog
  const backlogRaw = await readFile(config._resolved.backlog, 'utf-8');
  const backlog = JSON.parse(backlogRaw);

  const idx = backlog.tickets.findIndex((t) => t.id === ticketId);
  if (idx === -1) return;

  const ticket = backlog.tickets.splice(idx, 1)[0];
  ticket.status = 'done';
  ticket.completed = new Date().toISOString().split('T')[0];

  // Write updated backlog
  backlog.updated_at = new Date().toISOString().split('T')[0];
  await writeFile(config._resolved.backlog, JSON.stringify(backlog, null, 2));

  // Append to archive
  const archiveRaw = await readFile(config._resolved.archive, 'utf-8');
  const archive = JSON.parse(archiveRaw);
  archive.tickets.push(ticket);
  await writeFile(
    config._resolved.archive,
    JSON.stringify(archive, null, 2)
  );
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
