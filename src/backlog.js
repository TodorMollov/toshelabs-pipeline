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

  const { include_status, exclude_status, priority_order, type_order } =
    config.ticket_filter;

  const actionable = tickets.filter((t) => {
    if (exclude_status.includes(t.status)) return false;
    if (include_status.length > 0 && !include_status.includes(t.status))
      return false;
    return true;
  });

  // Sort: P0 bugs first, then P1 bugs, then P1 features, etc.
  actionable.sort((a, b) => {
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
 * Reload backlog (for refresh button)
 */
export async function reloadBacklog(config) {
  return loadBacklog(config);
}
