/**
 * Ticket schema validator.
 *
 * The schema is the contract at the pipeline boundary. Producers (operator,
 * LLMs, scripts) are responsible for emitting conformant tickets; the
 * pipeline accepts or rejects with a per-field reason — it does NOT silently
 * coerce, "best-guess", or auto-fix.
 *
 * Three operating modes (per-project, declared in pipeline.config.yaml):
 *
 *   off    — validator does not run; every ticket is accepted as-is. Default
 *            for backwards compatibility with existing project configs that
 *            predate the schema.
 *   warn   — validator runs; violations are logged + sidecar'd + emitted as
 *            events, but tickets are still accepted into the actionable
 *            queue. Use during migration to discover what's broken without
 *            halting the pipeline.
 *   strict — violations cause the ticket to be rejected from the actionable
 *            queue. Sidecar + event still emitted. The ticket stays in
 *            backlog.json so the operator can edit and re-run.
 *
 * Default schema is version 1 (the contract documented in TICKET-SCHEMA.md).
 * Projects can override individual enums via config (extend or replace).
 */

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

// Default schema (v1). Documented in TICKET-SCHEMA.md.
export const DEFAULT_SCHEMA_V1 = {
  required: ['id', 'schema_version', 'title', 'status', 'priority', 'type', 'complexity', 'description'],
  fields: {
    id: { type: 'string', pattern: /^[A-Z][A-Z0-9]*-\d+[A-Z]?$/ },
    schema_version: { type: 'integer', enum: [1] },
    title: { type: 'string', min_length: 10, max_length: 200 },
    status: { type: 'string', enum: ['requested', 'in_progress', 'blocked', 'done', 'monitor'] },
    priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
    type: { type: 'string', enum: ['bug', 'feature', 'enhancement', 'refactor', 'test', 'performance', 'ux', 'ops'] },
    complexity: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
    description: { type: 'string', min_length: 50 },
  },
  // Optional fields are recognised but not enforced. Listed here so the
  // validator can type-check them when present without flagging unknown-field
  // for legitimate optional content.
  optional: {
    area: { type: 'string' },
    source: { type: 'string' },
    reported: { type: 'string' },
    user_impact: { type: 'string' },
    acceptance_criteria: { type: 'array' },
    decisions: { type: 'array' },
    fix_plan: { type: 'array' },
    files_likely_affected: { type: 'array' },
    out_of_scope: { type: 'array' },
    blocked_by: { type: 'array' },
    tags: { type: 'array' },
    defer_until: { type: 'string' },
    subsumed_by: { type: 'string' },
    resolution: { type: 'string', enum: ['fixed', 'decided', 'moot', 'wont_fix'] },
    decision_note: { type: 'string' },
    order: { type: 'number' },
  },
  // Pipeline-managed fields — present in tickets the pipeline has touched.
  // Recognised so they don't trip the unknown-field check.
  pipeline_managed: ['archived_at', 'landed_commit', 'merge_status', 'pipeline_state_ref'],
};

/**
 * Apply project overrides to the default schema. Returns a new schema object;
 * does not mutate the input.
 *
 *   overrides:
 *     status:     { add: [extra] }       // extends enum
 *     type:       { replace: [a, b, c] } // replaces enum entirely
 *     complexity: { replace: [xs, s, m, l, xl] }
 */
export function applyOverrides(schema, overrides = {}) {
  if (!overrides || Object.keys(overrides).length === 0) return schema;
  const next = { ...schema, fields: { ...schema.fields } };
  for (const [field, op] of Object.entries(overrides)) {
    const cur = next.fields[field];
    if (!cur || !cur.enum) continue; // can only override enum fields
    let newEnum = cur.enum;
    if (Array.isArray(op.replace)) newEnum = op.replace;
    if (Array.isArray(op.add)) newEnum = [...new Set([...newEnum, ...op.add])];
    next.fields[field] = { ...cur, enum: newEnum };
  }
  return next;
}

/**
 * Validate a single ticket against a schema. Returns { ok, violations } where
 * violations is an array of { field, rule, expected, got, message }.
 */
export function validateTicket(ticket, schema = DEFAULT_SCHEMA_V1) {
  const violations = [];

  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
    return { ok: false, violations: [{ field: '<root>', rule: 'shape', message: 'ticket must be a non-array object' }] };
  }

  // Required fields
  for (const f of schema.required) {
    if (ticket[f] === undefined || ticket[f] === null || ticket[f] === '') {
      violations.push({ field: f, rule: 'required', message: `missing required field "${f}"` });
    }
  }

  // Per-field validation (covers required + optional that are present)
  const allFields = { ...schema.fields, ...(schema.optional || {}) };
  for (const [field, def] of Object.entries(allFields)) {
    const v = ticket[field];
    if (v === undefined || v === null) continue; // optional, not present, fine
    violations.push(...checkField(field, v, def));
  }

  return { ok: violations.length === 0, violations };
}

function checkField(field, value, def) {
  const out = [];

  // type check
  if (def.type === 'string' && typeof value !== 'string') {
    out.push({ field, rule: 'type', expected: 'string', got: typeof value, message: `${field}: expected string, got ${typeof value}` });
    return out; // can't continue checking string-shape rules on non-string
  }
  if (def.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
    out.push({ field, rule: 'type', expected: 'integer', got: typeof value, message: `${field}: expected integer, got ${typeof value}` });
    return out;
  }
  if (def.type === 'number' && typeof value !== 'number') {
    out.push({ field, rule: 'type', expected: 'number', got: typeof value, message: `${field}: expected number, got ${typeof value}` });
    return out;
  }
  if (def.type === 'array' && !Array.isArray(value)) {
    out.push({ field, rule: 'type', expected: 'array', got: typeof value, message: `${field}: expected array, got ${typeof value}` });
    return out;
  }

  // enum
  if (def.enum && !def.enum.includes(value)) {
    out.push({
      field,
      rule: 'enum',
      expected: def.enum,
      got: value,
      message: `${field}: "${value}" is not in enum [${def.enum.join(', ')}]`,
    });
  }

  // pattern (strings only)
  if (def.pattern && typeof value === 'string' && !def.pattern.test(value)) {
    out.push({
      field,
      rule: 'pattern',
      expected: def.pattern.toString(),
      got: value,
      message: `${field}: "${value}" does not match ${def.pattern}`,
    });
  }

  // length bounds (strings only)
  if (def.min_length != null && typeof value === 'string' && value.length < def.min_length) {
    out.push({
      field,
      rule: 'min_length',
      expected: def.min_length,
      got: value.length,
      message: `${field}: length ${value.length} < min ${def.min_length}`,
    });
  }
  if (def.max_length != null && typeof value === 'string' && value.length > def.max_length) {
    out.push({
      field,
      rule: 'max_length',
      expected: def.max_length,
      got: value.length,
      message: `${field}: length ${value.length} > max ${def.max_length}`,
    });
  }

  return out;
}

/**
 * Run validation against a list of tickets. Sidecars + emits events for
 * non-conformant ones. Returns { accepted, rejected } — `accepted` is the
 * subset of tickets that should proceed to filterAndSort.
 *
 * In `warn` mode, every ticket is in `accepted` regardless of violations
 * (violations are still recorded). In `strict` mode, only conformant
 * tickets are in `accepted`.
 *
 * Caller is responsible for emitting events via the returned `rejected`
 * array — this module does not import the event emitter to keep it pure
 * (easier to unit-test).
 */
export async function validateAndPartition(tickets, options = {}) {
  const {
    schema = DEFAULT_SCHEMA_V1,
    overrides = {},
    mode = 'off',
    sidecarPathFor = null, // (ticketId) => absolute path
    acceptedVersions = [1],
  } = options;

  const accepted = [];
  const rejected = [];

  if (mode === 'off') {
    return { accepted: tickets, rejected: [] };
  }

  const effectiveSchema = applyOverrides(schema, overrides);

  for (const t of tickets) {
    const result = validateTicket(t, effectiveSchema);
    // Schema-version gate: even if all fields pass, an unsupported
    // version is a hard reject regardless of mode (semantics undefined
    // for mismatched versions).
    let versionFailure = null;
    if (t && t.schema_version != null && !acceptedVersions.includes(t.schema_version)) {
      versionFailure = {
        field: 'schema_version',
        rule: 'accepts_schema_versions',
        expected: acceptedVersions,
        got: t.schema_version,
        message: `schema_version ${t.schema_version} not in accepted [${acceptedVersions.join(', ')}]`,
      };
    }

    const allViolations = versionFailure ? [...result.violations, versionFailure] : result.violations;

    if (allViolations.length === 0) {
      accepted.push(t);
      continue;
    }

    const record = {
      id: t?.id || '<no-id>',
      ticket: t,
      violations: allViolations,
      mode,
      timestamp: new Date().toISOString(),
    };
    rejected.push(record);

    // Sidecar — best-effort, doesn't block validation if write fails
    if (sidecarPathFor && t?.id) {
      try {
        const path = sidecarPathFor(t.id);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(record, null, 2) + '\n', 'utf-8');
      } catch (err) {
        console.warn(`[schema] could not write sidecar for ${t?.id}: ${err.message}`);
      }
    }

    // In warn mode, the ticket still proceeds. Strict means it doesn't.
    if (mode === 'warn') accepted.push(t);
  }

  return { accepted, rejected };
}
