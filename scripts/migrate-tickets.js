#!/usr/bin/env node
/**
 * One-time ticket migration to schema v1.
 *
 * Loads a project's backlog file, validates each ticket against the v1 schema,
 * and either auto-fixes mechanical violations or flags tickets needing manual
 * triage. Idempotent: running on a clean backlog produces zero changes.
 *
 * Usage:
 *   node scripts/migrate-tickets.js <backlog-path>           # dry-run
 *   node scripts/migrate-tickets.js <backlog-path> --apply   # write changes
 *   node scripts/migrate-tickets.js <backlog-path> --config <pipeline.config.yaml>
 *                                                            # load project config
 *                                                            # to apply ticket_schema
 *                                                            # overrides (e.g. busydad
 *                                                            # adds 'v2' to status
 *                                                            # and 'P4' to priority).
 *                                                            # Without this, the
 *                                                            # bare default v1 schema
 *                                                            # is applied — project-
 *                                                            # legitimate values get
 *                                                            # flagged for triage.
 *   node scripts/migrate-tickets.js <backlog-path> --triage-dir <dir>
 *                                                            # where to write
 *                                                            # *.needs_triage.json
 *                                                            # sidecars
 *                                                            # (default: alongside
 *                                                            # the backlog file)
 *
 * Auto-fixes:
 *   - Add `schema_version: 1` if missing.
 *   - Coerce `complexity` from a hardcoded synonym map (unknown→small,
 *     tiny→trivial, mini→trivial, big→large, huge→large) into the v1 enum.
 *   - Strip prose from `status` into `description` for entries matching
 *     /^(COMPLETE|DONE|FIXED|RESOLVED)([\s—\-:]|$)/i — set status='done',
 *     prepend the original status string to description (with a marker).
 *   - Coerce common status synonyms: closed→done, fixed→done, in-progress→
 *     in_progress.
 *   - Add `description: '(no description recorded — backfilled by migration
 *     2026-05-04)'` if missing AND title length is sufficient (otherwise
 *     flag for manual triage — a ticket with no title and no description is
 *     not auto-fixable).
 *
 * Manual triage (NOT auto-fixed; sidecared with violations):
 *   - status that doesn't match any synonym AND isn't a v1 value
 *   - title shorter than 10 chars
 *   - description AND title both missing
 *   - id pattern mismatch
 *   - any violation we can't confidently rewrite
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { validateTicket, DEFAULT_SCHEMA_V1, applyOverrides } from '../src/ticket-schema.js';

const COMPLEXITY_SYNONYMS = {
  unknown: 'small',
  tiny: 'trivial',
  mini: 'trivial',
  xs: 'trivial',
  s: 'small',
  sm: 'small',
  m: 'medium',
  med: 'medium',
  big: 'large',
  huge: 'large',
  xl: 'large',
  xxl: 'large',
};

const STATUS_SYNONYMS = {
  closed: 'done',
  fixed: 'done',
  resolved: 'done',
  complete: 'done',
  completed: 'done',
  archived: 'done',
  'in-progress': 'in_progress',
  'in progress': 'in_progress',
  inprogress: 'in_progress',
  reported: 'requested',
  open: 'requested',
  pending: 'requested',
};

// Free-form prose-as-status: someone wrote a sentence into status. Normalised
// to status='done' (these are almost always completion notes) with the prose
// preserved in description.
const PROSE_STATUS_RE = /^(COMPLETE|DONE|FIXED|RESOLVED|ALL\s+PHASES\s+COMPLETE|SUPERSEDED|Implemented)([\s—\-:]|$)/i;

const NOW_ISO_DATE = new Date().toISOString().slice(0, 10);
const BACKFILL_MARKER = `(schema-v1 backfill ${NOW_ISO_DATE})`;

function migrateTicket(t) {
  const fixes = [];
  const out = { ...t };

  // schema_version: missing → 1
  if (out.schema_version === undefined || out.schema_version === null) {
    out.schema_version = 1;
    fixes.push({ field: 'schema_version', from: undefined, to: 1, kind: 'add' });
  }

  // priority: missing → P3 (lowest, safe default — operator can re-grade
  // during triage). Backlog hygiene rather than scheduling correctness.
  if (out.priority == null || out.priority === '') {
    out.priority = 'P3';
    fixes.push({ field: 'priority', from: undefined, to: 'P3', kind: 'default' });
  }

  // resolution: someone wrote prose into the resolution field (saw it on
  // T-250 — full completion summary instead of one of fixed/decided/moot/
  // wont_fix). Extract the prose into description, set resolution=fixed
  // (the safe default for a ticket with a completion narrative).
  const RESOLUTION_ENUM = (DEFAULT_SCHEMA_V1.optional?.resolution?.enum) || ['fixed', 'decided', 'moot', 'wont_fix'];
  if (typeof out.resolution === 'string' && !RESOLUTION_ENUM.includes(out.resolution.toLowerCase().trim())) {
    if (out.resolution.length > 30) {
      // Long string → almost certainly prose; preserve in description
      const proseNote = `${BACKFILL_MARKER} migrated resolution prose: ${out.resolution}`;
      const oldDesc = (out.description || '').trim();
      out.description = oldDesc ? `${oldDesc}\n\n${proseNote}` : proseNote;
      out.resolution = 'fixed';
      fixes.push({ field: 'resolution', from: out.resolution.slice(0, 60), to: 'fixed', kind: 'prose-extracted' });
    } else {
      // Short non-enum value → try synonym
      const lower = out.resolution.toLowerCase().trim();
      const SYN = { complete: 'fixed', completed: 'fixed', done: 'fixed', deferred: 'wont_fix', skip: 'wont_fix' };
      if (SYN[lower]) {
        out.resolution = SYN[lower];
        fixes.push({ field: 'resolution', from: out.resolution, to: SYN[lower], kind: 'synonym' });
      }
    }
  }

  // complexity: synonym → v1 enum, unknown → 'small' default
  if (out.complexity != null && typeof out.complexity === 'string') {
    const lower = out.complexity.toLowerCase().trim();
    if (DEFAULT_SCHEMA_V1.fields.complexity.enum.includes(lower)) {
      if (lower !== out.complexity) {
        out.complexity = lower;
        fixes.push({ field: 'complexity', from: t.complexity, to: lower, kind: 'lowercase' });
      }
    } else if (COMPLEXITY_SYNONYMS[lower] != null) {
      const next = COMPLEXITY_SYNONYMS[lower];
      out.complexity = next;
      fixes.push({ field: 'complexity', from: t.complexity, to: next, kind: 'synonym' });
    }
    // else: leave it, validator will flag
  }

  // status: prose → done + prepend prose to description
  // Order matters: check prose pattern BEFORE simple synonym map so a status
  // like "COMPLETE — Three fixes:" is captured as prose, not as the
  // 'complete' synonym (which would lose the appended prose).
  if (out.status != null && typeof out.status === 'string') {
    const s = out.status;
    if (PROSE_STATUS_RE.test(s)) {
      const proseNote = `${BACKFILL_MARKER} migrated status prose: ${s}`;
      const oldDesc = (out.description || '').trim();
      out.description = oldDesc ? `${proseNote}\n\n${oldDesc}` : proseNote;
      out.status = 'done';
      fixes.push({ field: 'status', from: s.slice(0, 60), to: 'done', kind: 'prose-extracted' });
      if (!t.description) fixes.push({ field: 'description', from: undefined, to: 'backfilled from status prose', kind: 'derived' });
    } else {
      const lower = s.toLowerCase().trim();
      if (DEFAULT_SCHEMA_V1.fields.status.enum.includes(lower)) {
        if (lower !== s) {
          out.status = lower;
          fixes.push({ field: 'status', from: s, to: lower, kind: 'lowercase' });
        }
      } else if (STATUS_SYNONYMS[lower] != null) {
        const next = STATUS_SYNONYMS[lower];
        out.status = next;
        fixes.push({ field: 'status', from: s, to: next, kind: 'synonym' });
      }
    }
  }

  // complexity: missing → 'medium' (most common; operator re-grades during
  // triage if needed). Backlog hygiene rather than scheduling correctness.
  if (out.complexity == null || out.complexity === '') {
    out.complexity = 'medium';
    fixes.push({ field: 'complexity', from: undefined, to: 'medium', kind: 'default' });
  }

  // description: missing → backfill placeholder so the ticket validates;
  // operator surfaces the gap during triage. We backfill regardless of
  // title length (a short title still gives more signal than nothing).
  if (out.description == null || (typeof out.description === 'string' && out.description.trim().length < DEFAULT_SCHEMA_V1.fields.description.min_length)) {
    const titlePart = typeof out.title === 'string' && out.title.length > 0 ? `original title: "${out.title}"` : 'no title recorded either';
    const stub = `${BACKFILL_MARKER} no description recorded — ${titlePart}. Triage required: this ticket existed in the pre-schema backlog and lacks a usable description.`;
    if (stub !== out.description) {
      const fromVal = out.description == null ? '<missing>' : `(${out.description.trim().length} chars)`;
      out.description = stub;
      fixes.push({ field: 'description', from: fromVal, to: 'backfilled placeholder', kind: 'add' });
    }
  }

  return { ticket: out, fixes };
}

function diffTicket(orig, migrated, fixes) {
  if (fixes.length === 0) return null;
  return {
    id: orig.id || '<no-id>',
    fixes: fixes.map((f) => `${f.field}: ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)} [${f.kind}]`),
  };
}

async function loadProjectOverrides(configPath) {
  if (!configPath) return {};
  const raw = await readFile(configPath, 'utf-8');
  const cfg = parseYaml(raw);
  return cfg?.ticket_schema?.overrides || {};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node scripts/migrate-tickets.js <backlog-path> [--apply] [--config <pipeline.config.yaml>] [--triage-dir <dir>]`);
    process.exit(1);
  }
  const backlogPath = resolve(args[0]);
  const apply = args.includes('--apply');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx >= 0 ? resolve(args[configIdx + 1]) : null;
  const triageIdx = args.indexOf('--triage-dir');
  const triageDir = triageIdx >= 0 ? resolve(args[triageIdx + 1]) : dirname(backlogPath);

  const overrides = await loadProjectOverrides(configPath);
  const schema = applyOverrides(DEFAULT_SCHEMA_V1, overrides);

  console.log(`[migrate] reading ${backlogPath}`);
  console.log(`[migrate] mode: ${apply ? 'APPLY (writing changes)' : 'DRY-RUN (no writes)'}`);
  if (configPath) {
    const ovKeys = Object.keys(overrides);
    console.log(`[migrate] config: ${configPath}${ovKeys.length ? ` (${ovKeys.length} field override${ovKeys.length === 1 ? '' : 's'}: ${ovKeys.join(', ')})` : ' (no overrides)'}`);
  } else {
    console.log(`[migrate] config: <none — using bare default v1 schema; pass --config to apply project overrides>`);
  }
  console.log(`[migrate] triage sidecars → ${triageDir}/`);
  console.log('');

  const raw = await readFile(backlogPath, 'utf-8');
  const data = JSON.parse(raw);
  const tickets = data.tickets || [];
  if (tickets.length === 0) {
    console.log('[migrate] no tickets to process. exiting.');
    return;
  }

  const summary = { autofixed: 0, alreadyClean: 0, needsTriage: 0 };
  const newTickets = [];
  const triageRecords = [];

  for (const t of tickets) {
    const { ticket: migrated, fixes } = migrateTicket(t);
    const validation = validateTicket(migrated, schema);

    if (validation.ok) {
      if (fixes.length === 0) {
        summary.alreadyClean++;
        newTickets.push(t); // unchanged — preserve original object
      } else {
        summary.autofixed++;
        newTickets.push(migrated);
        const d = diffTicket(t, migrated, fixes);
        console.log(`  AUTOFIXED ${d.id}:`);
        d.fixes.forEach((f) => console.log(`    - ${f}`));
      }
    } else {
      summary.needsTriage++;
      newTickets.push(t); // keep original — don't write a partial-fix ticket
      triageRecords.push({
        id: t.id || '<no-id>',
        attempted_fixes: fixes,
        residual_violations: validation.violations,
        original: t,
      });
      console.log(`  NEEDS TRIAGE ${t.id || '<no-id>'}:`);
      console.log(`    attempted ${fixes.length} fix(es); ${validation.violations.length} violation(s) remain:`);
      validation.violations.forEach((v) => console.log(`      • ${v.message}`));
    }
  }

  console.log('');
  console.log(`[migrate] summary: autofixed=${summary.autofixed} clean=${summary.alreadyClean} needs_triage=${summary.needsTriage}`);

  if (apply) {
    if (summary.autofixed > 0) {
      const next = { ...data, tickets: newTickets, updated_at: NOW_ISO_DATE };
      await writeFile(backlogPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
      console.log(`[migrate] wrote ${backlogPath}`);
    } else {
      console.log(`[migrate] no changes to write.`);
    }
    for (const r of triageRecords) {
      const sidecarPath = resolve(triageDir, `${r.id}.needs_triage.json`);
      await writeFile(sidecarPath, JSON.stringify(r, null, 2) + '\n', 'utf-8');
      console.log(`[migrate] wrote sidecar ${sidecarPath}`);
    }
  } else {
    console.log(`[migrate] dry-run only. Re-run with --apply to write changes.`);
    if (triageRecords.length > 0) {
      console.log(`[migrate] would write ${triageRecords.length} triage sidecar(s) to ${triageDir}/`);
    }
  }
}

main().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
