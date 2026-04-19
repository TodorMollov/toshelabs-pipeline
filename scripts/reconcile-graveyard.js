#!/usr/bin/env node
// Reconcile the pre-Phase-3 graveyard: uncommitted files left in the
// project tree by past pipeline runs. Maps dirty files to tickets using
// each ticket's pipelineState.steps.*.files_changed, then creates one
// commit per ticket (skipping `in_progress` tickets — their files belong
// to live work). Files claimed by no completed ticket go to a separate
// "unattributed" commit that the user reviews.
//
// Usage:
//   node scripts/reconcile-graveyard.js [--config path] [--dry-run]
//                                       [--include-in-progress]
//                                       [--unattributed=commit|skip|list]
//
// Default is dry-run. Pass --commit to actually write commits.
//
// Design guard-rails (why this is safe to run):
//   - Stages only the files attributed to the ticket being committed.
//     Never `git add -A`.
//   - Files touched by multiple completed tickets → conflict; script
//     prints the conflict and skips unless user chooses one.
//   - `in_progress` tickets are skipped by default (their files belong
//     to a live pipeline run; committing them would race the pipeline).

import { readFile, readdir } from 'fs/promises';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';

const args = process.argv.slice(2);
const opts = {
  config: 'pipeline.config.yaml',
  commit: args.includes('--commit'),
  dryRun: !args.includes('--commit'),
  includeInProgress: args.includes('--include-in-progress'),
  unattributed: 'list', // 'commit' | 'skip' | 'list'
  // META-001 Phase 2: by default the reconciler only attributes files to
  // tickets that are FULLY complete (status=done + every sub-step terminal-OK).
  // Blocked/failed tickets are excluded; their files stay dirty until the
  // pipeline re-runs them to completion. Pass --allow-partial to override
  // (emergency-only: it re-enables the legacy behaviour that caused
  // commits like 4d7811a and 8d657bf to land partial/misattributed work).
  allowPartial: args.includes('--allow-partial'),
  unattributedCap: 10, // files — above this, refuse to create a mega-commit without --allow-partial
};
const configIdx = args.indexOf('--config');
if (configIdx >= 0) opts.config = args[configIdx + 1];
const unatIdx = args.findIndex((a) => a.startsWith('--unattributed'));
if (unatIdx >= 0) {
  const v = args[unatIdx].includes('=') ? args[unatIdx].split('=')[1] : args[unatIdx + 1];
  if (['commit', 'skip', 'list'].includes(v)) opts.unattributed = v;
}

const cfg = parseYaml(await readFile(opts.config, 'utf-8'));
const projectDir = cfg.project_dir;
const pipelineDir = resolve(projectDir, cfg.pipeline_dir);

// --- Load all pipeline state JSONs ---

const pipelineFiles = (await readdir(pipelineDir)).filter((f) => f.endsWith('.json'));
const tickets = [];
for (const f of pipelineFiles) {
  try {
    let raw = await readFile(resolve(pipelineDir, f), 'utf-8');
    // Same sanitizer as pipeline.js — LLMs sometimes emit JS in JSON
    raw = raw.replace(/:\s*(\d+)\s*\+\s*(\d+)/g, (_, a, b) => ': ' + (parseInt(a) + parseInt(b)));
    const state = JSON.parse(raw);
    tickets.push(state);
  } catch (err) {
    console.warn(`[skip] ${f}: ${err.message}`);
  }
}

// --- Build file → ticket-candidates map ---

// Reuse the pipeline.js logic: union of files_changed across all steps,
// exclude memory/pipeline/ (bookkeeping, not ticket output).
function collectDeclaredFiles(state) {
  const out = new Set();
  for (const step of Object.values(state.steps || {})) {
    if (!step || typeof step !== 'object') continue;
    for (const fc of (step.files_changed || [])) {
      const p = typeof fc === 'object' ? fc.path : fc;
      if (!p || typeof p !== 'string') continue;
      if (p.startsWith('memory/pipeline/')) continue;
      out.add(p);
    }
  }
  return out;
}

// META-001 Phase 2: a ticket is "fully complete" only if its top-level status
// is 'done' AND every sub-step reached a terminal-OK state AND no blocked_at
// is set. The previous behaviour treated 'blocked' tickets as eligible for
// commit attribution, which — combined with pipeline.js:644 silently
// overwriting blocked→done — produced the 4d7811a/8d657bf bad commits.
const TERMINAL_OK = new Set(['done', 'not_applicable', 'skipped']);
function isFullyComplete(state) {
  if (state.status !== 'done') return false;
  if (state.blocked_at) return false;
  for (const step of Object.values(state.steps || {})) {
    if (!step || !TERMINAL_OK.has(step.status)) return false;
  }
  return true;
}
function describeIncomplete(state) {
  if (state.blocked_at) return `blocked_at=${state.blocked_at} step=${state.blocked_step || '?'}`;
  if (state.status !== 'done') return `status=${state.status}`;
  const bad = Object.entries(state.steps || {})
    .filter(([, s]) => !s || !TERMINAL_OK.has(s.status))
    .map(([n, s]) => `${n}=${s?.status ?? 'missing'}`)
    .join(', ');
  return bad || 'unknown';
}

const fileOwners = new Map(); // path → [{ id, title, status, completed_at, fullyComplete, incompleteReason }]
for (const t of tickets) {
  const files = collectDeclaredFiles(t);
  for (const p of files) {
    const entry = {
      id: t.ticket,
      title: t.title || '',
      status: t.status,
      completed_at: t.completed_at || null,
      fullyComplete: isFullyComplete(t),
      incompleteReason: isFullyComplete(t) ? null : describeIncomplete(t),
    };
    if (!fileOwners.has(p)) fileOwners.set(p, []);
    fileOwners.get(p).push(entry);
  }
}

// --- Git porcelain: what's actually dirty right now ---

const porcelain = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' });
const dirty = new Map(); // path → status code
for (const line of porcelain.split('\n')) {
  if (!line) continue;
  const code = line.slice(0, 2).trim();
  const path = line.slice(3).trim();
  if (path) dirty.set(path, code || 'M');
}

// --- Attribute dirty files to tickets ---

// Preference when multiple tickets claim the same file:
//   1. done > blocked > in_progress > failed
//   2. ties broken by most-recent completed_at
const STATUS_RANK = { done: 0, blocked: 1, in_progress: 2, failed: 3 };
function pickOwner(candidates) {
  return candidates.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.completed_at || '').localeCompare(a.completed_at || '');
  })[0];
}

const byTicket = new Map(); // ticketId → { ticket, files[], conflicts[] }
const unattributed = [];
const skippedInProgress = []; // files owned only by in_progress tickets
const skippedPartial = []; // META-001 Phase 2: files owned only by incomplete/blocked tickets

for (const [path, code] of dirty) {
  const candidates = fileOwners.get(path) || [];
  if (candidates.length === 0) {
    unattributed.push({ path, code });
    continue;
  }
  // META-001 Phase 2: default is fullyComplete-only. --allow-partial re-enables
  // the legacy pool that accepted blocked tickets.
  const eligiblePool = opts.allowPartial
    ? candidates.filter((c) => c.status === 'done' || c.status === 'blocked')
    : candidates.filter((c) => c.fullyComplete);
  const pool = eligiblePool.length > 0 ? eligiblePool
    : (opts.includeInProgress ? candidates : []);
  if (pool.length === 0) {
    // Split skipped reasons so operators can see WHY a file was left dirty.
    const partialOwners = candidates.filter((c) => !c.fullyComplete && c.status !== 'in_progress');
    if (partialOwners.length > 0 && !opts.allowPartial) {
      skippedPartial.push({
        path,
        code,
        owners: partialOwners.map((c) => `${c.id}(${c.incompleteReason})`),
      });
    } else {
      skippedInProgress.push({ path, code, owners: candidates.map((c) => `${c.id}(${c.status})`) });
    }
    continue;
  }
  const winner = pickOwner(pool);
  const conflict = pool.length > 1 ? pool.filter((c) => c.id !== winner.id).map((c) => c.id) : [];
  if (!byTicket.has(winner.id)) {
    byTicket.set(winner.id, { ticket: winner, files: [], conflicts: [] });
  }
  const bucket = byTicket.get(winner.id);
  bucket.files.push({ path, code });
  if (conflict.length) bucket.conflicts.push({ path, otherTickets: conflict });
}

// --- Plan output ---

const ticketOrder = [...byTicket.keys()].sort((a, b) => {
  const ta = byTicket.get(a).ticket;
  const tb = byTicket.get(b).ticket;
  const ra = STATUS_RANK[ta.status] ?? 9;
  const rb = STATUS_RANK[tb.status] ?? 9;
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
});

console.log(`\n=== Graveyard reconciliation plan ===`);
console.log(`project_dir:    ${projectDir}`);
console.log(`mode:           ${opts.allowPartial ? 'ALLOW-PARTIAL (legacy, unsafe)' : 'strict (fully-complete tickets only)'}`);
console.log(`dirty files:    ${dirty.size}`);
console.log(`ticketed:       ${[...byTicket.values()].reduce((n, b) => n + b.files.length, 0)}`);
console.log(`unattributed:   ${unattributed.length}`);
console.log(`skipped (live): ${skippedInProgress.length}`);
console.log(`skipped (partial/blocked): ${skippedPartial.length}\n`);

for (const id of ticketOrder) {
  const b = byTicket.get(id);
  console.log(`[${b.ticket.status}] ${id} — ${b.ticket.title}`);
  console.log(`  ${b.files.length} files`);
  for (const f of b.files) console.log(`    ${f.code.padEnd(2)} ${f.path}`);
  if (b.conflicts.length) {
    console.log(`  ⚠ conflicts (other tickets also claimed these):`);
    for (const c of b.conflicts) console.log(`     - ${c.path} also claimed by ${c.otherTickets.join(', ')}`);
  }
  console.log();
}

if (skippedInProgress.length) {
  console.log(`--- Skipped: owned only by in_progress tickets (pass --include-in-progress to commit anyway) ---`);
  for (const f of skippedInProgress) console.log(`  ${f.code.padEnd(2)} ${f.path}  [${f.owners.join(', ')}]`);
  console.log();
}

if (skippedPartial.length) {
  console.log(`--- Skipped: owned only by PARTIAL/BLOCKED tickets (META-001 Phase 2 gate) ---`);
  console.log(`These tickets did not complete every sub-step. Committing their files`);
  console.log(`would ship partial/unreviewed work under a 'done' label. Re-run the`);
  console.log(`pipeline on the ticket until it completes, or pass --allow-partial to`);
  console.log(`bypass (legacy behaviour — unsafe).\n`);
  for (const f of skippedPartial) console.log(`  ${f.code.padEnd(2)} ${f.path}  [${f.owners.join(', ')}]`);
  console.log();
}

if (unattributed.length) {
  console.log(`--- Unattributed: no ticket claims these files ---`);
  for (const f of unattributed) console.log(`  ${f.code.padEnd(2)} ${f.path}`);
  console.log(`\n(--unattributed=${opts.unattributed}: ${opts.unattributed === 'commit' ? 'will be committed as one "graveyard-unattributed" commit' : opts.unattributed === 'skip' ? 'will be left uncommitted' : 'listed only — will not touch these'})`);
  // META-001 Phase 2: cap the unattributed mega-commit to prevent another
  // 56-file, 6117-line dump like 4d7811a. Above the cap, require --allow-partial.
  if (opts.unattributed === 'commit' && unattributed.length > opts.unattributedCap && !opts.allowPartial) {
    console.log(`\n⛔ REFUSING: unattributed bucket (${unattributed.length} files) exceeds cap (${opts.unattributedCap}).`);
    console.log(`   A large unattributed commit means many files aren't tied to any ticket —`);
    console.log(`   meaning no plan, no review, no acceptance criteria. This is how 4d7811a`);
    console.log(`   (56 files, 'Review manually') happened. Resolve by:`);
    console.log(`     (a) tying files to tickets (update pipelineState.steps.*.files_changed), or`);
    console.log(`     (b) reverting/removing files that shouldn't be on disk, or`);
    console.log(`     (c) passing --allow-partial to bypass (documented emergency only).\n`);
    // Downgrade unattributed to 'list' mode for this run.
    opts.unattributed = 'list';
  }
  console.log();
}

if (opts.dryRun) {
  console.log(`=== Dry run — no changes made. Pass --commit to apply. ===`);
  process.exit(0);
}

// --- Apply commits ---

function sh(cmd) {
  return execSync(cmd, { cwd: projectDir, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
}
function q(s) { return JSON.stringify(s); }

let committed = 0;
for (const id of ticketOrder) {
  const b = byTicket.get(id);
  const paths = b.files.map((f) => f.path);
  const quoted = paths.map(q).join(' ');
  const title = (b.ticket.title || '').slice(0, 72);
  const subject = `[${id}] ${title}`.trim();
  const bodyLines = [''];
  bodyLines.push(`Reconciling ${paths.length} file(s) from pre-Phase-3 pipeline run (status at reconcile: ${b.ticket.status}).`);
  if (b.conflicts.length) {
    bodyLines.push('', 'Note: some files were also claimed by:');
    for (const c of b.conflicts) bodyLines.push(`  - ${c.path}: ${c.otherTickets.join(', ')}`);
  }
  bodyLines.push('', '🤖 toshelabs-pipeline (graveyard reconciliation)');
  const message = `${subject}\n${bodyLines.join('\n')}`;

  try {
    sh(`git add -- ${quoted}`);
    const staged = sh('git diff --cached --name-only').trim();
    if (!staged) {
      console.log(`[skip] ${id}: nothing staged (files matched HEAD)`);
      continue;
    }
    const safeMsg = message.replace(/'/g, "'\\''");
    sh(`git commit -m '${safeMsg}' -- ${quoted}`);
    const sha = sh('git rev-parse HEAD').trim().slice(0, 7);
    console.log(`[commit] ${id}: ${sha} (${paths.length} files)`);
    committed++;
  } catch (err) {
    console.error(`[error] ${id}: ${(err.stderr || err.stdout || err.message).toString().slice(-300)}`);
  }
}

if (unattributed.length && opts.unattributed === 'commit') {
  const paths = unattributed.map((f) => f.path);
  const quoted = paths.map(q).join(' ');
  const message = `[graveyard] Unattributed pre-Phase-3 files\n\nReconciling ${paths.length} file(s) that no pipeline ticket claims. Review manually.\n\n🤖 toshelabs-pipeline (graveyard reconciliation)`;
  try {
    sh(`git add -- ${quoted}`);
    const staged = sh('git diff --cached --name-only').trim();
    if (staged) {
      const safeMsg = message.replace(/'/g, "'\\''");
      sh(`git commit -m '${safeMsg}' -- ${quoted}`);
      const sha = sh('git rev-parse HEAD').trim().slice(0, 7);
      console.log(`[commit] unattributed: ${sha} (${paths.length} files)`);
      committed++;
    }
  } catch (err) {
    console.error(`[error] unattributed: ${(err.stderr || err.stdout || err.message).toString().slice(-300)}`);
  }
}

console.log(`\n=== Done. ${committed} commit(s) created. ===`);
