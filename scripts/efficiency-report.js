#!/usr/bin/env node
// Pipeline efficiency KPIs — measures the impact of the 2026-05-19 fix set
// (A covers_plan test-path exclusion, A2 write_zones strict, B risk-routed
// plan_critic, R tests_red native scoped red-run).
//
// Usage:
//   node scripts/efficiency-report.js <projectId> [--freeze]
//
//   --freeze  Write a baseline marker (timestamp) so subsequent runs split
//             tickets into BEFORE (completed_at <= freeze) and AFTER cohorts.
//             Run this ONCE before restarting the pipeline post-fix.
//   (no flag) Print KPIs for BEFORE vs AFTER cohorts + delta.
//
// Everything is derived from the per-ticket report blocks the pipeline
// already writes — no new pipeline instrumentation required beyond the
// `tests_red_verified` event/field added with fix R.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectId = process.argv[2];
const freeze = process.argv.includes('--freeze');
if (!projectId) {
  console.error('usage: node scripts/efficiency-report.js <projectId> [--freeze]');
  process.exit(1);
}

const stateDir = join(HOME, 'projects', projectId, 'pipeline-state');
const markerPath = join(HOME, 'projects', projectId, 'pipeline-state', '.efficiency-baseline.json');

function loadTickets() {
  const dirs = [stateDir, join(stateDir, 'archive')];
  const rows = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json') || !f.startsWith('T-')) continue;
      let j;
      try { j = JSON.parse(readFileSync(join(d, f), 'utf-8')); } catch { continue; }
      if (j.status !== 'done' || !j.report) continue;
      rows.push(j);
    }
  }
  return rows;
}

if (freeze) {
  const ts = new Date().toISOString();
  writeFileSync(markerPath, JSON.stringify({ freeze_at: ts }, null, 2));
  console.log(`[efficiency] baseline frozen at ${ts}`);
  console.log(`[efficiency] tickets completed at/before this are BEFORE; later ones AFTER.`);
  process.exit(0);
}

const freezeAt = existsSync(markerPath)
  ? JSON.parse(readFileSync(markerPath, 'utf-8')).freeze_at
  : null;

function kpis(rows) {
  if (rows.length === 0) return null;
  const stepOf = (j, n) => (j.report.steps || []).find((s) => s.step === n) || {};
  let implReruns = 0, redReruns = 0;
  let redNativeVerified = 0, redScoped = 0;
  const redOutcome = {};
  let criticRan = 0, criticSkipped = 0;
  const criticByRisk = {};
  let dur = 0, out = 0, rework = 0, redOut = 0, redDur = 0;
  for (const j of rows) {
    const impl = stepOf(j, 'implement');
    const red = stepOf(j, 'tests_red');
    const critic = stepOf(j, 'plan_critic');
    const risk = String(j.steps?.plan?.risk || j.report.steps?.find?.(() => false) || 'unset').toLowerCase();
    if ((impl.attempts || 1) > 1) implReruns++;
    if ((red.attempts || 1) > 1) redReruns++;
    const rs = j.steps?.tests_red || {};
    if (rs.tests_red_native_verified) redNativeVerified++;
    const o = rs.outcome || '(none)';
    redOutcome[o] = (redOutcome[o] || 0) + 1;
    if (critic.status === 'skipped' || j.steps?.plan_critic?.status === 'not_applicable') criticSkipped++;
    else if (critic.step) criticRan++;
    criticByRisk[risk] = criticByRisk[risk] || { ran: 0, skipped: 0 };
    if (j.steps?.plan_critic?.status === 'not_applicable') criticByRisk[risk].skipped++;
    else criticByRisk[risk].ran++;
    dur += j.report.totalDurationMs || 0;
    out += j.report.totalOutputTokens || 0;
    rework += j.report.reworkOutputTokens || 0;
    redOut += red.outputTokens || 0;
    redDur += red.durationMs || 0;
  }
  const n = rows.length;
  return {
    n,
    implRerunPct: Math.round((100 * implReruns) / n),
    redRerunPct: Math.round((100 * redReruns) / n),
    redNativePct: Math.round((100 * redNativeVerified) / n),
    redOutcome,
    criticByRisk,
    avgActiveMin: +(dur / n / 60000).toFixed(1),
    avgOutTok: Math.round(out / n),
    reworkPct: out ? Math.round((100 * rework) / out) : 0,
    avgRedOutTok: Math.round(redOut / n),
    avgRedMin: +(redDur / n / 60000).toFixed(1),
  };
}

const all = loadTickets();
let before, after;
if (freezeAt) {
  before = all.filter((j) => (j.report.date || j.completed_at || '') <= freezeAt
    && (j.completed_at || j.report.date || '') <= freezeAt);
  after = all.filter((j) => (j.completed_at || j.report.date || '') > freezeAt);
} else {
  before = all;
  after = [];
}

const b = kpis(before);
const a = kpis(after);

function show(label, k) {
  if (!k) { console.log(`\n${label}: (no tickets)`); return; }
  console.log(`\n${label}  (n=${k.n})`);
  console.log(`  implement false re-run rate : ${k.implRerunPct}%   <- Fix A target (was ~66%)`);
  console.log(`  tests_red re-run rate       : ${k.redRerunPct}%   <- Fix R/C target (was ~25%)`);
  console.log(`  tests_red native-verified   : ${k.redNativePct}%   <- Fix R (LLM no longer runs tests)`);
  console.log(`  tests_red outcomes          : ${JSON.stringify(k.redOutcome)}`);
  console.log(`  plan_critic by plan.risk    : ${JSON.stringify(k.criticByRisk)}   <- Fix B routing`);
  console.log(`  avg active time / ticket    : ${k.avgActiveMin} min`);
  console.log(`  avg output tokens / ticket  : ${k.avgOutTok.toLocaleString()}`);
  console.log(`  rework token ratio          : ${k.reworkPct}%`);
  console.log(`  tests_red avg out tok       : ${k.avgRedOutTok.toLocaleString()}  (should drop sharply — no Bash/suite runs)`);
  console.log(`  tests_red avg active min    : ${k.avgRedMin}`);
}

console.log(`=== Pipeline efficiency: ${projectId} ===`);
console.log(freezeAt ? `baseline frozen at ${freezeAt}` : `NO baseline marker — run with --freeze before restart to split before/after`);
show('BEFORE (pre-fix)', b);
show('AFTER (post-fix)', a);
if (b && a) {
  console.log('\n=== DELTA (after - before) ===');
  console.log(`  implement false re-run : ${a.implRerunPct - b.implRerunPct} pp`);
  console.log(`  avg active time/ticket : ${(a.avgActiveMin - b.avgActiveMin).toFixed(1)} min`);
  console.log(`  avg output tok/ticket  : ${(a.avgOutTok - b.avgOutTok).toLocaleString()}`);
  console.log(`  tests_red avg out tok  : ${(a.avgRedOutTok - b.avgRedOutTok).toLocaleString()}`);
}
