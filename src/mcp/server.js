/**
 * PIPE-006: MCP server — frontend interface for tickets + schema.
 *
 * Files-as-backend (option A from the schema-publishing discussion):
 * storage stays in per-project YAML/JSON files; MCP just provides a
 * uniform tool surface so any Claude session can:
 *   - discover loaded projects (list_projects)
 *   - fetch the live schema for a project including its overrides
 *     (get_schema)
 *   - read the project's backlog (list_tickets, get_ticket)
 *   - author conformant tickets (create_ticket, update_ticket,
 *     archive_ticket) — server-side validation via the same
 *     src/ticket-schema.js the HTTP path uses
 *
 * Runs in the same Node process as the HTTP server. Mounted on POST /mcp
 * via StreamableHTTPServerTransport — same projects map, same emitter,
 * single source of truth.
 *
 * No authentication — local single-operator tool. If transport ever
 * grows beyond loopback, AuthN/Z becomes a real concern.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { DEFAULT_SCHEMA_V1, applyOverrides, validateTicket, checkDoneTransition } from '../ticket-schema.js';

/**
 * Build an McpServer wired to the live projects map. Caller is responsible
 * for mounting the returned transport on an HTTP route.
 *
 * params:
 *   projects   — Map<projectId, config>
 *   getActiveId() — returns the currently-active project id (used as
 *                   default when a tool call omits the project arg)
 *   emitter    — EventEmitter, so MCP-driven mutations show up in the
 *                pipeline event stream the same as HTTP-driven ones
 */
export function createMcpServer({ projects, getActiveId, emitter }) {
  const mcp = new McpServer({
    name: 'toshelabs-pipeline',
    version: '0.1.0',
  });

  // Resolve project ref (id or null → active). Returns the config object
  // or throws a tool-style error (caught + reformatted by the tool wrapper).
  function resolveProject(projectArg) {
    const id = projectArg || getActiveId();
    if (!id) throw new Error('no project specified and no active project set');
    if (!projects.has(id)) {
      throw new Error(`project "${id}" not found. Loaded: ${[...projects.keys()].join(', ') || '(none)'}`);
    }
    return { id, cfg: projects.get(id) };
  }

  function effectiveSchema(cfg) {
    return applyOverrides(DEFAULT_SCHEMA_V1, cfg?.ticket_schema?.overrides || {});
  }

  function requiresCriteria(cfg) {
    return cfg?.ticket_schema?.require_acceptance_criteria === true;
  }

  // Tool wrapper: standard error-to-content shape so the MCP client sees
  // a structured failure instead of a transport-level exception.
  function toolResult(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
  function toolError(message, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
  }

  // ─── list_projects ────────────────────────────────────────────────
  mcp.registerTool('list_projects', {
    description: 'List all projects loaded by the pipeline. Returns id, name, project_dir, and whether the project is currently active (the active project is the default for tool calls that omit the `project` arg).',
    inputSchema: {},
  }, async () => {
    try {
      const activeId = getActiveId();
      const list = [...projects.entries()].map(([id, cfg]) => ({
        id,
        name: cfg.name || id,
        project_dir: cfg.project_dir,
        active: id === activeId,
      }));
      return toolResult({ active: activeId, projects: list });
    } catch (err) {
      return toolError(err.message);
    }
  });

  // ─── get_schema ───────────────────────────────────────────────────
  mcp.registerTool('get_schema', {
    description: 'Return the resolved ticket schema for a project (default v1 schema with the project\'s overrides applied). Use this at the start of a session before authoring any ticket — it tells you exactly which status / priority / type / complexity values are valid for THIS project (e.g. busydad allows status="v2", priority="P4", type=chore|docs|manual which other projects don\'t).',
    inputSchema: {
      project: z.string().optional().describe('Project id (omit to use the active project).'),
    },
  }, async ({ project }) => {
    try {
      const { id, cfg } = resolveProject(project);
      const schema = effectiveSchema(cfg);
      // Strip non-serialisable bits (regex objects in field defs)
      const serialisable = JSON.parse(JSON.stringify(schema, (k, v) => v instanceof RegExp ? v.toString() : v));
      return toolResult({
        project: id,
        schema_version: 1,
        schema: serialisable,
        accepts_schema_versions: cfg.ticket_schema?.accepts_schema_versions || [1],
        mode: cfg.ticket_schema?.mode || 'off',
      });
    } catch (err) {
      return toolError(err.message);
    }
  });

  // ─── list_tickets ─────────────────────────────────────────────────
  mcp.registerTool('list_tickets', {
    description: 'List tickets in a project\'s backlog. Optional status filter. Tickets are returned exactly as they appear on disk — including pipeline-managed fields like archived_at and landed_commit if present.',
    inputSchema: {
      project: z.string().optional().describe('Project id (omit to use the active project).'),
      status: z.string().optional().describe('Filter to tickets with this exact status (e.g. "requested", "monitor", "done"). Omit to return all.'),
    },
  }, async ({ project, status }) => {
    try {
      const { id, cfg } = resolveProject(project);
      const backlogPath = cfg._resolved?.backlog;
      if (!backlogPath || !existsSync(backlogPath)) {
        return toolResult({ project: id, tickets: [], note: `backlog file not found at ${backlogPath}` });
      }
      const raw = await readFile(backlogPath, 'utf-8');
      const data = JSON.parse(raw);
      let tickets = data.tickets || [];
      if (status) tickets = tickets.filter((t) => t.status === status);
      return toolResult({ project: id, total: tickets.length, tickets });
    } catch (err) {
      return toolError(err.message);
    }
  });

  // ─── get_ticket ───────────────────────────────────────────────────
  mcp.registerTool('get_ticket', {
    description: 'Fetch a single ticket from a project\'s backlog by id. Returns null if not found (use list_tickets to discover ids).',
    inputSchema: {
      project: z.string().optional(),
      id: z.string().describe('Ticket id (e.g. "BUG-261", "T-359", "PIPE-001").'),
    },
  }, async ({ project, id: ticketId }) => {
    try {
      const { id, cfg } = resolveProject(project);
      const backlogPath = cfg._resolved?.backlog;
      if (!existsSync(backlogPath)) return toolResult({ project: id, ticket: null });
      const raw = await readFile(backlogPath, 'utf-8');
      const data = JSON.parse(raw);
      const ticket = (data.tickets || []).find((t) => t.id === ticketId);
      return toolResult({ project: id, ticket: ticket || null });
    } catch (err) {
      return toolError(err.message);
    }
  });

  // ─── create_ticket ────────────────────────────────────────────────
  mcp.registerTool('create_ticket', {
    description: 'Create a new ticket in a project\'s backlog. Validates against the project\'s effective schema BEFORE writing — non-conformant tickets are rejected with field-level violations. Use get_schema first to know what values are valid for THIS project. Returns the persisted ticket on success, or an error with violations on failure (no partial writes).',
    inputSchema: {
      project: z.string().optional(),
      ticket: z.record(z.any()).describe('Full ticket object. Required fields per schema v1: id, schema_version (must equal 1), title (10-200 chars), status, priority, type, complexity, description (>=50 chars). Optional: area, source, reported, user_impact, acceptance_criteria, decisions, fix_plan, files_likely_affected, out_of_scope, blocked_by, tags, defer_until, subsumed_by, resolution, decision_note, order. See get_schema for project-specific enum overrides.'),
    },
  }, async ({ project, ticket }) => {
    try {
      const { id, cfg } = resolveProject(project);
      const schema = effectiveSchema(cfg);
      const validation = validateTicket(ticket, schema);
      if (!validation.ok) {
        return toolError('ticket failed schema validation', { project: id, violations: validation.violations });
      }
      const backlogPath = cfg._resolved?.backlog;
      if (!backlogPath) return toolError(`project ${id} has no backlog path resolved`);
      // Ensure parent dir exists; the backlog file may not yet
      mkdirSync(dirname(backlogPath), { recursive: true });
      let data = { schema: 'backlog-v1', updated_at: new Date().toISOString().slice(0, 10), tickets: [] };
      if (existsSync(backlogPath)) {
        try { data = JSON.parse(await readFile(backlogPath, 'utf-8')); } catch (err) {
          return toolError(`existing backlog at ${backlogPath} is unparseable: ${err.message}`);
        }
      }
      if ((data.tickets || []).some((t) => t.id === ticket.id)) {
        return toolError(`ticket "${ticket.id}" already exists in ${id}. Use update_ticket to modify.`);
      }
      data.tickets = data.tickets || [];
      data.tickets.push(ticket);
      data.updated_at = new Date().toISOString().slice(0, 10);
      await writeFile(backlogPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      emitter?.emit('mcp_ticket_created', { project: id, ticketId: ticket.id });
      return toolResult({ project: id, ticket });
    } catch (err) {
      return toolError(err.message);
    }
  });

  // ─── update_ticket ────────────────────────────────────────────────
  mcp.registerTool('update_ticket', {
    description: 'Apply a shallow merge patch to an existing ticket. The merged ticket is re-validated; if it would become non-conformant the patch is rejected and nothing is written. Use this for status transitions (requested → in_progress → done), priority changes, adding fix_plan steps, etc. For id renames or full rewrites, archive + create_ticket is cleaner.',
    inputSchema: {
      project: z.string().optional(),
      id: z.string().describe('Ticket id to patch.'),
      patch: z.record(z.any()).describe('Partial ticket — fields to merge. e.g. {"status":"done", "resolution":"fixed"}.'),
    },
  }, async ({ project, id: ticketId, patch }) => {
    try {
      const { id, cfg } = resolveProject(project);
      const backlogPath = cfg._resolved?.backlog;
      if (!existsSync(backlogPath)) return toolError(`project ${id} has no backlog file at ${backlogPath}`);
      const data = JSON.parse(await readFile(backlogPath, 'utf-8'));
      const idx = (data.tickets || []).findIndex((t) => t.id === ticketId);
      if (idx < 0) return toolError(`ticket ${ticketId} not found in ${id}`);
      const merged = { ...data.tickets[idx], ...patch };
      const validation = validateTicket(merged, effectiveSchema(cfg));
      if (!validation.ok) {
        return toolError('patched ticket would fail schema validation', { project: id, violations: validation.violations });
      }
      // Done-transition gate: can't mark a behavioural ticket done without
      // acceptance criteria (criteria-before-code).
      if (requiresCriteria(cfg) && merged.status === 'done') {
        const gate = checkDoneTransition(merged);
        if (!gate.ok) {
          return toolError('cannot mark ticket done without acceptance_criteria', { project: id, violations: [gate.violation] });
        }
      }
      data.tickets[idx] = merged;
      data.updated_at = new Date().toISOString().slice(0, 10);
      await writeFile(backlogPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      emitter?.emit('mcp_ticket_updated', { project: id, ticketId, fields: Object.keys(patch) });
      return toolResult({ project: id, ticket: merged });
    } catch (err) {
      return toolError(err.message);
    }
  });

  // ─── archive_ticket ───────────────────────────────────────────────
  mcp.registerTool('archive_ticket', {
    description: 'Move a ticket from the active backlog to the archive file. Sets status=done if not already, stamps archived_at. Idempotent: archiving an already-archived ticket is a no-op.',
    inputSchema: {
      project: z.string().optional(),
      id: z.string(),
    },
  }, async ({ project, id: ticketId }) => {
    try {
      const { id, cfg } = resolveProject(project);
      const backlogPath = cfg._resolved?.backlog;
      const archivePath = cfg._resolved?.archive;
      if (!backlogPath || !archivePath) return toolError(`project ${id} has no backlog/archive paths resolved`);
      if (!existsSync(backlogPath)) return toolError(`backlog file not found at ${backlogPath}`);
      const data = JSON.parse(await readFile(backlogPath, 'utf-8'));
      const idx = (data.tickets || []).findIndex((t) => t.id === ticketId);
      if (idx < 0) return toolError(`ticket ${ticketId} not found in ${id} backlog (already archived?)`);
      // Done-transition gate: archiving sets status=done, so the same
      // criteria-before-code rule applies.
      if (requiresCriteria(cfg)) {
        const gate = checkDoneTransition(data.tickets[idx]);
        if (!gate.ok) {
          return toolError('cannot archive (mark done) a ticket without acceptance_criteria', { project: id, violations: [gate.violation] });
        }
      }
      const ticket = { ...data.tickets[idx], status: 'done', archived_at: new Date().toISOString().slice(0, 10) };
      data.tickets.splice(idx, 1);
      data.updated_at = new Date().toISOString().slice(0, 10);

      // Append to archive (create if missing)
      mkdirSync(dirname(archivePath), { recursive: true });
      let archive = { schema: 'backlog-archive-v1', tickets: [] };
      if (existsSync(archivePath)) {
        try { archive = JSON.parse(await readFile(archivePath, 'utf-8')); } catch { /* start fresh */ }
      }
      archive.tickets = [ticket, ...(archive.tickets || [])];

      await writeFile(backlogPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      await writeFile(archivePath, JSON.stringify(archive, null, 2) + '\n', 'utf-8');
      emitter?.emit('mcp_ticket_archived', { project: id, ticketId });
      return toolResult({ project: id, ticket });
    } catch (err) {
      return toolError(err.message);
    }
  });

  return mcp;
}

/**
 * Mount the MCP server on an Express app. Per the SDK's stateless pattern:
 * each POST creates a fresh McpServer + transport pair, processes the
 * single request, then tears them down on the response close. Reusing a
 * single transport across requests is the *stateful* pattern (requires
 * sessionIdGenerator + session-id headers) and breaks here. GET/DELETE
 * return 405 (no server-initiated messages in stateless mode).
 *
 * Caller passes a `serverFactory()` that builds a fresh McpServer with
 * tools wired to the live state — same projects map, same emitter — so
 * the per-request server cost is just object construction + tool
 * registration (~ms), not config reload.
 */
export async function mountMcpOnExpress(app, serverFactory, route = '/mcp') {
  app.post(route, async (req, res) => {
    let server, transport;
    try {
      server = serverFactory();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        try { transport?.close?.(); } catch {}
        try { server?.close?.(); } catch {}
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[mcp] POST ${route} handler error:`, err.stack || err.message);
      try { transport?.close?.(); } catch {}
      try { server?.close?.(); } catch {}
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: null });
      }
    }
  });
  app.get(route, (req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless mode — POST only).' }, id: null });
  });
  app.delete(route, (req, res) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });
}
