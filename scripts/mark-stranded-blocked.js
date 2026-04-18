#!/usr/bin/env node
// Mark tickets stuck in `status: in_progress` as blocked/failed so they
// stop being re-queued as crashed on every pipeline restart.
//
// Usage:
//   node scripts/mark-stranded-blocked.js [--config path] [--stale-hours N] [--dry-run]
//
// Default: tickets untouched for >2h are candidates.
// --dry-run prints what would change without writing.

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const configIdx = args.indexOf('--config');
const configPath = configIdx >= 0 ? args[configIdx + 1] : 'pipeline.config.yaml';
const staleIdx = args.indexOf('--stale-hours');
const staleHours = staleIdx >= 0 ? parseFloat(args[staleIdx + 1]) : 2;

const cfg = parseYaml(await readFile(configPath, 'utf-8'));
const pipelineDir = resolve(cfg.project_dir, cfg.pipeline_dir);

const files = (await readdir(pipelineDir)).filter((f) => f.endsWith('.json'));
const now = Date.now();
let changed = 0;

for (const f of files) {
  const path = resolve(pipelineDir, f);
  let s;
  try { s = JSON.parse(await readFile(path, 'utf-8')); } catch { continue; }
  if (s.status !== 'in_progress') continue;

  const mtime = (await stat(path)).mtime.getTime();
  const ageHours = (now - mtime) / 3600000;
  if (ageHours < staleHours) {
    console.log(`  skip  ${s.ticket}  (only ${ageHours.toFixed(1)}h old)`);
    continue;
  }

  // Find the step that wedged the ticket
  const stuck = Object.entries(s.steps || {}).find(
    ([, st]) => st.status !== 'done' && st.status !== 'not_applicable'
  );
  const stuckName = stuck ? stuck[0] : 'unknown';
  const stuckStatus = stuck ? stuck[1].status : 'unknown';

  // Pick ticket status: failed for step crashes/failures, blocked for pending (never ran)
  const newStatus = ['failed', 'crashed'].includes(stuckStatus) ? 'failed' : 'blocked';

  console.log(`  mark  ${s.ticket.padEnd(8)} ${stuckName}[${stuckStatus}]  →  status: ${newStatus}  (${ageHours.toFixed(1)}h old)`);

  if (!dry) {
    s.status = newStatus;
    s.blocked_step = stuckName;
    s.blocked_reason = `cleanup: stranded at ${stuckName}=${stuckStatus} for ${ageHours.toFixed(1)}h`;
    s.blocked_at = new Date().toISOString();
    await writeFile(path, JSON.stringify(s, null, 2));
    changed++;
  }
}

console.log(`\n${dry ? '[dry-run] ' : ''}Changed ${changed} file(s).`);
if (dry) console.log('Re-run without --dry-run to apply.');
