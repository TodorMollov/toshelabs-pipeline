#!/usr/bin/env node
/**
 * Static plan checker — deterministic, no LLM.
 *
 * Reads a plan.json (worker-output/{ticket}/plan.json shape) and applies the
 * thresholds from project_ticket_size_kpi memory:
 *
 *   files_to_change   ≥10 reject  / ≥7  flag
 *   production files  ≥6  reject  / ≥4  flag    (non-test, non-doc)
 *   layers crossed    ≥4  reject  / ≥3  flag    (app/lib, backend/, rules, docs, etc.)
 *   edge_cases        ≥6  reject  / ≥4  flag
 *   title heuristic   "harden" | "correction" | multi-clause "+" → flag
 *
 * Verdict: pass | flag | reject. Exit code 0/1/2 respectively.
 *
 * Usage:
 *   node scripts/plan-static-check.js <path-to-plan.json> [--title "..."]
 *   node scripts/plan-static-check.js --backtest   (runs on all archived plans)
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

// ----------------------------------------------------------------------------
// Thresholds — tuned against the historical distribution of 98 archived plans.
// FLAG sits at p75 (top quartile of size); REJECT at p95 (genuinely extreme).
// Empirical percentiles measured 2026-05-20:
//   files:  p50=5  p75=8   p90=13  p95=14  p99=28  max=28
//   prod:   p50=4  p75=6   p90=9   p95=11  p99=25  max=25
//   layers: p50=2  p75=3   p90=4   p95=5   p99=7   max=7
//   edges:  p50=5  p75=5   p90=5   p95=6   p99=8   max=8     ← edges cluster at 5,
// so edges is a weak signal — only fires when genuinely unusual.
//
// T-045 (10 files, 5 prod, 3 layers, 5 edges + "harden" title) trips
// FILES_FLAG + TITLE_FLAG → flagged but not rejected. Historical truth:
// it shipped but was painful, so flag is correct.
// ----------------------------------------------------------------------------

const T = {
  FILES_FLAG: 10,
  FILES_REJECT: 15,
  PROD_FLAG: 7,
  PROD_REJECT: 10,
  LAYERS_FLAG: 4,
  LAYERS_REJECT: 5,
  EDGES_FLAG: 7,
  EDGES_REJECT: 9,
};

const TITLE_PATTERNS = [
  /\bharden\b/i,
  /\bcorrection\b/i,
  /\brefactor.+\band\b.+\band\b/i,        // multi-clause "refactor X and Y and Z"
  /\+.*\+/,                                // "A + B + C" style multi-concern titles
];

// File path → layer mapping. Add per-project hints later if needed; these
// cover the predictor / busydad / pension-ai layouts.
function layerOf(path) {
  if (/^app\/lib\/.*test/.test(path)) return 'app-test';
  if (/^app\/test\//.test(path)) return 'app-test';
  if (/^app\/lib\//.test(path)) {
    if (/\/data\//.test(path)) return 'app-data';
    if (/\/features\//.test(path)) return 'app-ui';
    if (/\/core\//.test(path)) return 'app-core';
    return 'app-other';
  }
  if (/^backend\/functions\/test\//.test(path)) return 'backend-test';
  if (/^backend\/functions\//.test(path)) return 'backend';
  if (/firestore\.rules$/.test(path)) return 'rules';
  if (/^docs\//.test(path) || /\.md$/.test(path)) return 'docs';
  if (/test/.test(path)) return 'test';
  return 'other';
}

function isTest(path) {
  return /test|spec/i.test(path);
}
function isDoc(path) {
  return /^docs\//.test(path) || /\.md$/.test(path);
}

function check(plan, opts = {}) {
  const title = opts.title || plan.title || '';
  const filesToChange = plan.files_to_change || [];
  const edgeCases = plan.edge_cases || [];

  const fileList = filesToChange
    .map((f) => (typeof f === 'string' ? f : f.path || f.file || ''))
    .filter(Boolean);
  const prodFiles = fileList.filter((p) => !isTest(p) && !isDoc(p));
  const layers = new Set(fileList.map(layerOf).filter((l) => l !== 'docs'));

  const checks = [];
  let flag = 0, reject = 0;
  const fire = (id, level, msg) => { checks.push({ id, level, msg }); if (level === 'flag') flag++; if (level === 'reject') reject++; };

  if (fileList.length >= T.FILES_REJECT) {
    fire('FILES', 'reject', `files_to_change=${fileList.length} ≥ ${T.FILES_REJECT}`);
  } else if (fileList.length >= T.FILES_FLAG) {
    fire('FILES', 'flag', `files_to_change=${fileList.length} ≥ ${T.FILES_FLAG}`);
  }

  if (prodFiles.length >= T.PROD_REJECT) {
    fire('PROD', 'reject', `production files=${prodFiles.length} ≥ ${T.PROD_REJECT}`);
  } else if (prodFiles.length >= T.PROD_FLAG) {
    fire('PROD', 'flag', `production files=${prodFiles.length} ≥ ${T.PROD_FLAG}`);
  }

  if (layers.size >= T.LAYERS_REJECT) {
    fire('LAYERS', 'reject', `layers crossed=${layers.size} (${[...layers].join(', ')}) ≥ ${T.LAYERS_REJECT}`);
  } else if (layers.size >= T.LAYERS_FLAG) {
    fire('LAYERS', 'flag', `layers crossed=${layers.size} (${[...layers].join(', ')}) ≥ ${T.LAYERS_FLAG}`);
  }

  if (edgeCases.length >= T.EDGES_REJECT) {
    fire('EDGES', 'reject', `edge_cases=${edgeCases.length} ≥ ${T.EDGES_REJECT}`);
  } else if (edgeCases.length >= T.EDGES_FLAG) {
    fire('EDGES', 'flag', `edge_cases=${edgeCases.length} ≥ ${T.EDGES_FLAG}`);
  }

  for (const pat of TITLE_PATTERNS) {
    if (pat.test(title)) {
      fire('TITLE', 'flag', `title matches /${pat.source}/`);
      break; // one title flag is enough
    }
  }

  const verdict = reject > 0 ? 'reject' : flag > 0 ? 'flag' : 'pass';
  return {
    verdict,
    flag_count: flag,
    reject_count: reject,
    checks,
    metrics: {
      files: fileList.length,
      prod_files: prodFiles.length,
      layers: layers.size,
      layer_set: [...layers],
      edge_cases: edgeCases.length,
      title,
    },
  };
}

// ----------------------------------------------------------------------------
// Backtest: walk all archived plan.json files across projects, run check,
// report verdict distribution + list tickets that would have been rejected.
// ----------------------------------------------------------------------------

function findArchivedPlans() {
  const root = resolve(import.meta.dirname, '..', 'projects');
  const out = [];
  if (!existsSync(root)) return out;
  for (const project of readdirSync(root)) {
    const woDir = join(root, project, 'worker-output');
    if (!existsSync(woDir)) continue;
    for (const ticketDir of readdirSync(woDir)) {
      const planPath = join(woDir, ticketDir, 'plan.json');
      if (existsSync(planPath)) out.push({ project, ticket: ticketDir, planPath });
    }
  }
  return out;
}

function loadTicketTitle(project, ticket) {
  // Look in archive then backlog for the title — plan.json itself sometimes
  // lacks a title field at the top level.
  for (const f of ['backlog-archive.json', 'backlog.json']) {
    const candidates = [
      resolve(import.meta.dirname, '..', '..', project, 'state', f),
      resolve('/home/toshe', project, 'state', f),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        const t = (data.tickets || []).find((x) => x.id === ticket);
        if (t?.title) return t.title;
      } catch {}
    }
  }
  return '';
}

function backtest() {
  const plans = findArchivedPlans();
  console.log(`Backtest: ${plans.length} plans found across projects\n`);

  const dist = { pass: 0, flag: 0, reject: 0 };
  const rejects = [];
  const flags = [];

  for (const { project, ticket, planPath } of plans) {
    let plan;
    try { plan = JSON.parse(readFileSync(planPath, 'utf-8')); } catch { continue; }
    const title = plan.title || loadTicketTitle(project, ticket);
    const result = check(plan, { title });
    dist[result.verdict]++;
    if (result.verdict === 'reject') rejects.push({ project, ticket, title, ...result });
    if (result.verdict === 'flag') flags.push({ project, ticket, title, ...result });
  }

  console.log('Verdict distribution:');
  console.log(`  pass:   ${dist.pass}`);
  console.log(`  flag:   ${dist.flag}`);
  console.log(`  reject: ${dist.reject}`);
  console.log(`  total:  ${plans.length}`);

  if (rejects.length) {
    console.log(`\nREJECTED (${rejects.length}):`);
    for (const r of rejects) {
      console.log(`  ${r.project}/${r.ticket}: ${r.title}`);
      console.log(`    metrics: files=${r.metrics.files} prod=${r.metrics.prod_files} layers=${r.metrics.layers} edges=${r.metrics.edge_cases}`);
      for (const c of r.checks) console.log(`    [${c.level}] ${c.id}: ${c.msg}`);
    }
  }

  if (flags.length) {
    console.log(`\nFLAGGED (${flags.length}):`);
    for (const f of flags) {
      const fired = f.checks.map((c) => `${c.id}:${c.level}`).join(' ');
      console.log(`  ${f.project}/${f.ticket}: ${f.title.slice(0, 70)} — ${fired}`);
    }
  }

  return dist;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv[0] === '--backtest') {
  backtest();
  process.exit(0);
}
if (argv.length === 0) {
  console.error('Usage: node plan-static-check.js <plan.json> [--title "..."] | --backtest');
  process.exit(64);
}

const planPath = argv[0];
const titleIdx = argv.indexOf('--title');
const title = titleIdx >= 0 ? argv[titleIdx + 1] : undefined;
if (!existsSync(planPath)) {
  console.error(`plan file not found: ${planPath}`);
  process.exit(64);
}
const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
const result = check(plan, { title });

console.log(JSON.stringify(result, null, 2));
process.exit(result.verdict === 'pass' ? 0 : result.verdict === 'flag' ? 1 : 2);
