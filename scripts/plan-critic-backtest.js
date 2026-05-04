#!/usr/bin/env node
/**
 * PIPE-001 Phase 1 — backtest harness.
 *
 * Runs the plan_critic prompt against historical plan JSONs from the
 * pipeline-state archive and measures whether the critic catches known
 * escapes. Validates the prompt design BEFORE the plan_critic phase is
 * wired into a live pipeline run.
 *
 * Acceptance bar (per PIPE-001 acceptance_criteria):
 *   - L10N-1's plan must produce a finding whose claim_under_test
 *     quotes the AppLocalizations languageCode sentence AND whose
 *     concrete_falsifier is a non-en languageCode (e.g. bg_BG, de_DE).
 *   - Catch rate on the three real bug plans must be ≥ 2/3.
 *   - False-positive rate on the two control plans must be < 3 findings.
 *
 * Usage:
 *   node scripts/plan-critic-backtest.js --bug-plan <path> --bug-plan <path> ...
 *                                         --control-plan <path> --control-plan <path>
 *                                         [--prompt prompts/plan_critic.md]
 *                                         [--model opus]
 *                                         [--max-seconds 90]
 *                                         [--out backtest-report.json]
 *
 * Each plan path should be a pipeline-state JSON (the same shape the
 * pipeline writes to projects/{name}/pipeline-state/{id}.json), or a flat
 * JSON with at least { ticket: {...}, plan: {...} } keys.
 *
 * Each plan is replayed through the critic in isolation: a fresh Claude
 * session, the prompt template loaded from disk and rendered with the
 * plan as PIPELINE_STATE, output captured + parsed + scored.
 *
 * Output: a JSON report with per-plan findings + aggregate catch/false-
 * positive rates, plus a one-line PASS/FAIL summary against the
 * acceptance bar.
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function parseArgs(argv) {
  const out = { bugPlans: [], controlPlans: [], prompt: 'prompts/plan_critic.md', model: 'opus', maxSeconds: 90, outFile: 'backtest-report.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bug-plan') out.bugPlans.push(argv[++i]);
    else if (a === '--control-plan') out.controlPlans.push(argv[++i]);
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--max-seconds') out.maxSeconds = parseInt(argv[++i], 10);
    else if (a === '--out') out.outFile = argv[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
  }
  return out;
}

function printUsage() {
  console.log(`
PIPE-001 backtest harness — validates plan_critic prompt against archived plans.

  --bug-plan <path>      A historical plan KNOWN to have shipped a bug. Repeat
                         the flag for each plan (typical N=3, e.g. L10N-1,
                         BUG-261, BUG-262 from busydad pipeline-state).
  --control-plan <path>  A historical plan that shipped fine. Repeat for each
                         (typical N=2). Used to measure false-positive rate.
  --prompt <path>        plan_critic prompt template (default
                         prompts/plan_critic.md).
  --model <id>           Claude model id (default opus).
  --max-seconds <n>      Per-plan wall-clock budget (default 90s, matches
                         the plan_critic step's runtime cap).
  --out <path>           Where to write the JSON report (default
                         backtest-report.json).

Acceptance bar (per PIPE-001):
  - L10N-1: finding quoting the AppLocalizations languageCode sentence
    AND falsifier is a non-en languageCode.
  - Bug catch rate >= 2/3.
  - Control false-positive rate < 3 findings each.
`);
}

function renderPrompt(template, ctx) {
  return template
    .replace(/\{\{ticket_id\}\}/g, ctx.ticket?.id || '<unknown>')
    .replace(/\{\{ticket_title\}\}/g, ctx.ticket?.title || '<unknown>')
    .replace(/\{\{ticket_json\}\}/g, JSON.stringify(ctx.ticket || {}, null, 2))
    .replace(/\{\{pipeline_state\}\}/g, JSON.stringify(ctx.plan || {}, null, 2))
    .replace(/\{\{worker_output\}\}/g, ctx.workerOutputPath);
}

async function loadPlanFile(path) {
  const raw = await readFile(path, 'utf-8');
  const data = JSON.parse(raw);
  // Pipeline-state shape: { ticket, steps: { plan: {...}, ... } }
  // Or flat shape: { ticket, plan }
  const ticket = data.ticket || { id: data.id || '<unknown>', title: data.title || '<unknown>' };
  const plan = data.steps?.plan || data.plan || data;
  return { path, ticket, plan };
}

function scoreFinding(finding) {
  // Reject malformed findings (missing required fields)
  if (!finding.claim_under_test || !finding.concrete_falsifier || !finding.proposed_test) return null;
  if (typeof finding.claim_under_test !== 'string' || typeof finding.concrete_falsifier !== 'string' || typeof finding.proposed_test !== 'string') return null;
  // Reject vague-falsifier patterns (categories, not specifics)
  const VAGUE = /\b(edge cases?|race conditions?|various inputs?|some|many|several|consider whether|might break|could fail)\b/i;
  if (VAGUE.test(finding.concrete_falsifier)) return null;
  return finding;
}

function isL10nFinding(finding) {
  if (!finding) return false;
  const claim = finding.claim_under_test.toLowerCase();
  const falsifier = finding.concrete_falsifier.toLowerCase();
  const claimMatches = claim.includes('applocalizations') && (claim.includes('languagecode') || claim.includes('issupported') || claim.includes('en_gb') || claim.includes('locale'));
  const falsifierMatches = /\b(bg_bg|de_de|fr_fr|es_es|it_it|nl_nl|pl_pl|sv_se|cs_cz|hu_hu|sk_sk|ro_ro)\b/i.test(falsifier) || /\bnon-en\b/i.test(falsifier);
  return claimMatches && falsifierMatches;
}

function spawnCritic({ promptText, model, maxSeconds }) {
  return new Promise((resolve, reject) => {
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const args = [
      '-p',
      '--model', model,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '25',
      '--allowedTools', 'Read,Grep,Glob,WebFetch',
      '--disable-slash-commands',
      '--permission-mode', 'bypassPermissions',
    ];
    const proc = spawn(claudeBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.write(promptText);
    proc.stdin.end();

    let workerOutput = '';
    let stdoutChunks = '';
    let stderrChunks = '';
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    }, maxSeconds * 1000);

    proc.stdout.on('data', (chunk) => {
      stdoutChunks += chunk.toString();
      // The worker writes the actual JSON output to a file path in the
      // prompt; we can't intercept Write tool calls here without parsing
      // stream-json. Instead we look for a Write event in the stream.
      const lines = stdoutChunks.split('\n');
      stdoutChunks = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const c of ev.message.content) {
              if (c.type === 'tool_use' && c.name === 'Write' && c.input?.file_path && c.input?.content) {
                workerOutput = c.input.content;
              }
            }
          }
        } catch { /* not valid JSON line — skip */ }
      }
    });
    proc.stderr.on('data', (chunk) => { stderrChunks += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (timedOut) {
        return resolve({ workerOutput, timedOut: true, exitCode: code });
      }
      resolve({ workerOutput, timedOut: false, exitCode: code, stderr: stderrChunks });
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

function parseFindings(workerOutput) {
  if (!workerOutput) return { findings: [], parseError: 'no worker output captured' };
  try {
    const obj = JSON.parse(workerOutput);
    return { findings: Array.isArray(obj.findings) ? obj.findings : [], parseError: null };
  } catch (err) {
    return { findings: [], parseError: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bugPlans.length === 0 || args.controlPlans.length === 0) {
    console.error('error: at least one --bug-plan and one --control-plan required');
    printUsage();
    process.exit(1);
  }

  const promptTemplate = await readFile(args.prompt, 'utf-8');
  console.log(`[backtest] prompt: ${args.prompt}`);
  console.log(`[backtest] model: ${args.model}, time-box: ${args.maxSeconds}s`);
  console.log(`[backtest] bug plans: ${args.bugPlans.length}, control plans: ${args.controlPlans.length}`);
  console.log('');

  const results = { bug: [], control: [] };

  async function runOne(planPath, kind) {
    const ctx = await loadPlanFile(planPath);
    ctx.workerOutputPath = `/tmp/backtest-${randomUUID()}.json`;
    const promptText = renderPrompt(promptTemplate, ctx);
    const start = Date.now();
    process.stdout.write(`  [${kind}] ${ctx.ticket.id || planPath} ... `);
    const { workerOutput, timedOut, exitCode } = await spawnCritic({
      promptText, model: args.model, maxSeconds: args.maxSeconds,
    });
    const durationMs = Date.now() - start;
    const { findings: rawFindings, parseError } = parseFindings(workerOutput);
    const findings = rawFindings.map(scoreFinding).filter(Boolean);
    const isL10n = ctx.ticket.id?.toUpperCase().startsWith('L10N') ||
                   ctx.ticket.title?.toLowerCase().includes('l10n');
    const matchesL10n = isL10n && findings.some(isL10nFinding);
    process.stdout.write(`${findings.length} valid finding(s), ${rawFindings.length - findings.length} rejected, ${(durationMs/1000).toFixed(1)}s${timedOut ? ' [TIMEOUT]' : ''}${parseError ? ` [PARSE: ${parseError}]` : ''}\n`);
    return {
      planPath,
      ticketId: ctx.ticket.id,
      kind,
      isL10n,
      matchesL10nAcceptance: matchesL10n,
      findings,
      rawFindingsCount: rawFindings.length,
      validFindingsCount: findings.length,
      durationMs,
      timedOut,
      exitCode,
      parseError,
    };
  }

  console.log('--- BUG PLANS (catch rate target ≥ 2/3) ---');
  for (const p of args.bugPlans) {
    results.bug.push(await runOne(p, 'bug'));
  }
  console.log('');
  console.log('--- CONTROL PLANS (false-positive target < 3 each) ---');
  for (const p of args.controlPlans) {
    results.control.push(await runOne(p, 'control'));
  }
  console.log('');

  const bugsCaught = results.bug.filter((r) => r.validFindingsCount > 0).length;
  const bugCatchRate = bugsCaught / results.bug.length;
  const l10nResult = results.bug.find((r) => r.isL10n);
  const l10nPassed = l10nResult ? l10nResult.matchesL10nAcceptance : null;
  const controlMaxFP = results.control.reduce((m, r) => Math.max(m, r.validFindingsCount), 0);

  const passes = {
    l10n_specific: l10nPassed === true,
    bug_catch_rate_geq_2_3: bugCatchRate >= 2/3,
    control_fp_lt_3: controlMaxFP < 3,
  };
  const allPass = Object.values(passes).every(Boolean);

  console.log('=== ACCEPTANCE BAR ===');
  console.log(`  L10N-1 specific catch:        ${l10nPassed === true ? 'PASS' : (l10nPassed === false ? 'FAIL' : 'N/A (no L10N plan in bug set)')}`);
  console.log(`  Bug catch rate (≥ 2/3):       ${bugsCaught}/${results.bug.length} = ${(bugCatchRate * 100).toFixed(0)}% — ${passes.bug_catch_rate_geq_2_3 ? 'PASS' : 'FAIL'}`);
  console.log(`  Control max FP (< 3):         ${controlMaxFP} — ${passes.control_fp_lt_3 ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(`OVERALL: ${allPass ? 'PASS — prompt is ready to ship' : 'FAIL — iterate on prompt before wiring plan_critic into a live run'}`);

  await writeFile(args.outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    args,
    results,
    summary: { bugsCaught, totalBugs: results.bug.length, bugCatchRate, controlMaxFP, l10nPassed, passes, allPass },
  }, null, 2) + '\n', 'utf-8');
  console.log(`\n[backtest] full report written to ${args.outFile}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('[backtest] fatal:', err);
  process.exit(1);
});
