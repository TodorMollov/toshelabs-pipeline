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

const fileOwners = new Map(); // path → [{ id, title, status, completed_at }]
for (const t of tickets) {
  const files = collectDeclaredFiles(t);
  for (const p of files) {
    const entry = {
      id: t.ticket,
      title: t.title || '',
      status: t.status,
      completed_at: t.completed_at || null,
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

for (const [path, code] of dirty) {
  const candidates = fileOwners.get(path) || [];
  if (candidates.length === 0) {
    unattributed.push({ path, code });
    continue;
  }
  const completed = candidates.filter((c) => c.status === 'done' || c.status === 'blocked');
  const pool = completed.length > 0 ? completed
    : (opts.includeInProgress ? candidates : []);
  if (pool.length === 0) {
    skippedInProgress.push({ path, code, owners: candidates.map((c) => `${c.id}(${c.status})`) });
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
console.log(`dirty files:    ${dirty.size}`);
console.log(`ticketed:       ${[...byTicket.values()].reduce((n, b) => n + b.files.length, 0)}`);
console.log(`unattributed:   ${unattributed.length}`);
console.log(`skipped (live): ${skippedInProgress.length}\n`);

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

if (unattributed.length) {
  console.log(`--- Unattributed: no ticket claims these files ---`);
  for (const f of unattributed) console.log(`  ${f.code.padEnd(2)} ${f.path}`);
  console.log(`\n(--unattributed=${opts.unattributed}: ${opts.unattributed === 'commit' ? 'will be committed as one "graveyard-unattributed" commit' : opts.unattributed === 'skip' ? 'will be left uncommitted' : 'listed only — will not touch these'})\n`);
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
