import { readFile } from 'fs/promises';
import { spawnClaude } from './runner.js';

// Normalize a challenge's findings into a stable set of issue signatures so
// we can detect the loop re-raising the SAME structural problem every round
// (non-convergence) instead of burning the full round budget on it.
function parseFindings(text) {
  if (!text) return [];
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

function parseFindingSignatures(text) {
  return [...new Set(
    parseFindings(text)
      .map((f) => (typeof f.issue === 'string' ? f.issue : ''))
      .filter(Boolean)
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80))
  )];
}

// PIPE-024: a round is "blocking" if ANY finding is explicitly high/blocking
// severity, OR a finding carries no recognised severity at all (unknown =
// treat as blocking — never cap on ambiguity). The loop only caps early
// when the challenger explicitly graded EVERY finding non-blocking.
const BLOCKING_SEV = /^(high|blocking|critical|severe|major|p0|p1)$/i;
const NONBLOCKING_SEV = /^(low|minor|nit|nitpick|cosmetic|trivial|info|style|non.?blocking|p3|p4)$/i;
function roundHasBlockingFindings(text) {
  const fs = parseFindings(text);
  if (fs.length === 0) return false; // no findings → not a blocking round
  for (const f of fs) {
    const sev = String(f.severity || f.sev || '').trim();
    if (BLOCKING_SEV.test(sev)) return true;
    if (!NONBLOCKING_SEV.test(sev)) return true; // unknown/absent = blocking
  }
  return false;
}

/**
 * Self-challenge protocol — mechanically enforced by the orchestrator.
 *
 * 1. DO call produces initial result
 * 2. CHALLENGE call critiques it (separate CLI invocation)
 * 3. COMPARE: is the new version better?
 *    - Yes → replace best, round++
 *    - No → discard++
 * 4. 3 discards OR 10 rounds → converged
 *
 * Token-burn guards (added 2026-05-15):
 *  A. Infeasibility verdict — the challenger may answer `BLOCKED: <reason>`
 *     for hard blockers it cannot fix by iterating (missing credential,
 *     unprovisioned external service, self-contradictory ticket scope).
 *     The loop stops immediately and the caller marks the ticket blocked
 *     → human, instead of looping then shipping a doomed plan.
 *  B. Non-convergence detection — if the challenger re-raises the same
 *     issue across rounds, or keeps "winning" the compare with fresh
 *     findings every round without ever discarding, the disagreement is
 *     structural (iteration won't fix it). Stop and escalate rather than
 *     run the full round budget.
 */
export async function thinkLoop({
  initialResult,
  stepName,
  challengeQuestion,
  config,
  ticket,
  emitter,
  // PIPE-018: where the step's real output artifact lives, so an
  // accepted critique is APPLIED to it rather than discarded.
  //   { kind: 'json', artifactPath } → rewrite that JSON file in place
  //   { kind: 'code' }               → edit source in the working dir
  //   { kind: 'none' } (default)     → legacy: bestResult = findings text,
  //                                    nothing is applied (e.g. review step)
  reviseTarget = { kind: 'none' },
  // PIPE-024: ticket risk. When not 'high', the loop stops after a round
  // whose findings are all explicitly non-blocking — no point spending
  // another full challenge/revise cycle on cosmetic issues. High-risk
  // tickets always run the full round budget.
  risk = 'medium',
  // DI seam for tests — defaults to the real CLI spawn. Production callers
  // never pass this; the regression suite injects a deterministic fake.
  spawn = spawnClaude,
}) {
  const maxRounds = config.think_loop.max_rounds;
  const maxDiscards = config.think_loop.max_discards;
  const riskCapEnabled = String(risk || '').toLowerCase() !== 'high';

  let bestResult = initialResult;
  let discards = 0;
  let rounds = 0;
  let blocked = false;
  let blockedReason = '';
  let revised = false;
  const history = [];
  const issueFirstSeenRound = new Map(); // signature -> round first seen
  // Instrumentation: token cost of the loop itself, broken out by phase,
  // so the report can show what the think-loop actually spent (it was
  // previously invisible — only the per-call [usage] log line existed).
  const tokens = {
    challengeIn: 0, challengeOut: 0,
    compareIn: 0, compareOut: 0,
    reviseIn: 0, reviseOut: 0,
  };

  while (rounds < maxRounds && discards < maxDiscards) {
    rounds++;

    emitter?.emit('think_round_start', {
      ticket: ticket.id,
      step: stepName,
      round: rounds,
      discards,
    });

    // CHALLENGE: ask Claude to critique the current best
    const challengePrompt = `Challenge the "${stepName}" output for ticket ${ticket.id}: "${ticket.title}".

${challengeQuestion}

Read the actual files in the working directory to verify the implementation. Do NOT rewrite code — only report issues.

If you find problems, output ONLY a JSON array of findings. Grade each
finding's severity honestly — "high" for a correctness/security/data bug or
a missing requirement; "low" for cosmetic/style/naming/nitpick:
[{"file": "path", "line": N, "issue": "one sentence", "fix": "one sentence", "severity": "high|low"}]

If no problems found, output exactly: NO_IMPROVEMENT

If the output cannot be fixed by editing code or the plan because it depends on something that does not exist or contradicts itself — a missing/wrong credential or key, an unprovisioned external service, or a ticket scope that requires something not available — do NOT emit findings. Output exactly one line:
BLOCKED: <one sentence — what is missing and why iterating cannot fix it>

No prose. No explanations. No complete rewrites. Just the findings array, or NO_IMPROVEMENT, or one BLOCKED: line.`;

    let challengeResult;
    try {
      let chIn = 0, chOut = 0, chTools = 0;
      const chStart = Date.now();
      const response = await spawn({
        prompt: challengePrompt,
        model: config.session.model,
        tools: ['Read', 'Grep', 'Glob'],
        maxTurns: 10,
        workingDir: config.project_dir,
        sessionId: null,
        bare: true,
        onData: (event) => {
          const usage = event.message?.usage || event.usage;
          if (usage?.input_tokens) chIn = usage.input_tokens;
          if (usage?.output_tokens) chOut += usage.output_tokens;
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') chTools++;
          emitter?.emit('claude_event', {
            ticket: ticket.id,
            step: stepName,
            phase: 'think_challenge',
            round: rounds,
            event,
          });
        },
      });
      challengeResult = response.result;
      tokens.challengeIn += chIn;
      tokens.challengeOut += chOut;
      const chSecs = Math.round((Date.now() - chStart) / 1000);
      console.log(`[usage] ${ticket.id}/${stepName} (think-challenge-${rounds}) | ${config.session.model} | ${chSecs}s | ${chIn.toLocaleString()} in / ${chOut.toLocaleString()} out | ${chTools} tools`);
      emitter?.emit('step_attempt_done', { ticket: ticket.id, step: `${stepName}_think_challenge`, round: rounds, model: config.session.model, inputTokens: chIn, outputTokens: chOut, toolCalls: chTools });
    } catch (err) {
      if (err.rateLimited) throw err; // let pipeline handle rate limits
      emitter?.emit('think_error', {
        ticket: ticket.id,
        step: stepName,
        round: rounds,
        error: err.message,
      });
      break;
    }

    // A. Infeasibility verdict — hard blocker iteration cannot fix.
    const blockedMatch = challengeResult.match(/^\s*BLOCKED:\s*(.+)$/im);
    if (blockedMatch) {
      blocked = true;
      blockedReason = blockedMatch[1].trim().slice(0, 300);
      history.push({ round: rounds, outcome: 'blocked', reason: blockedReason });
      emitter?.emit('think_round_end', {
        ticket: ticket.id, step: stepName, round: rounds,
        outcome: 'blocked', reason: blockedReason, discards,
      });
      break;
    }

    // B. Non-convergence — same issue re-raised in a later round means the
    // disagreement is structural; iterating burns tokens without resolving.
    const sigs = parseFindingSignatures(challengeResult);
    const repeated = sigs.find(
      (s) => issueFirstSeenRound.has(s) && issueFirstSeenRound.get(s) !== rounds
    );
    if (repeated) {
      blocked = true;
      blockedReason = `non-convergence: challenger re-raised the same issue across rounds — "${repeated}"`;
      history.push({ round: rounds, outcome: 'nonconvergence', reason: blockedReason });
      emitter?.emit('think_round_end', {
        ticket: ticket.id, step: stepName, round: rounds,
        outcome: 'nonconvergence', reason: blockedReason, discards,
      });
      break;
    }
    for (const s of sigs) {
      if (!issueFirstSeenRound.has(s)) issueFirstSeenRound.set(s, rounds);
    }

    // Check if the challenger found no improvement
    if (
      challengeResult.includes('NO_IMPROVEMENT') ||
      challengeResult.trim().length < 20
    ) {
      discards++;
      history.push({ round: rounds, outcome: 'discarded', reason: 'no improvement found' });
      emitter?.emit('think_round_end', {
        ticket: ticket.id,
        step: stepName,
        round: rounds,
        outcome: 'discarded',
        reason: 'no improvement found',
        discards,
      });
      continue;
    }

    // COMPARE: ask Claude if the new version is actually better
    const comparePrompt = `Compare these two versions of the "${stepName}" output for ticket ${ticket.id}.

VERSION A (current best):
---
${typeof bestResult === 'string' ? bestResult : JSON.stringify(bestResult, null, 2)}
---

VERSION B (challenger):
---
${challengeResult}
---

Is VERSION B genuinely better than VERSION A? Consider: correctness, simplicity, completeness, edge case coverage.

Respond with EXACTLY one of:
BETTER: <one-line reason>
WORSE: <one-line reason>

Do not hedge. Pick one.`;

    let compareResponse;
    try {
      let cmpIn = 0, cmpOut = 0;
      const cmpStart = Date.now();
      compareResponse = await spawn({
        prompt: comparePrompt,
        model: 'haiku',
        tools: [],
        maxTurns: 1,
        bare: true,
        workingDir: config.project_dir,
        onData: (event) => {
          const usage = event.message?.usage || event.usage;
          if (usage?.input_tokens) cmpIn = usage.input_tokens;
          if (usage?.output_tokens) cmpOut += usage.output_tokens;
          emitter?.emit('claude_event', {
            ticket: ticket.id,
            step: stepName,
            phase: 'think_compare',
            round: rounds,
            event,
          });
        },
      });
      tokens.compareIn += cmpIn;
      tokens.compareOut += cmpOut;
      const cmpSecs = Math.round((Date.now() - cmpStart) / 1000);
      console.log(`[usage] ${ticket.id}/${stepName} (think-compare-${rounds}) | haiku | ${cmpSecs}s | ${cmpIn.toLocaleString()} in / ${cmpOut.toLocaleString()} out`);
      emitter?.emit('step_attempt_done', { ticket: ticket.id, step: `${stepName}_think_compare`, round: rounds, model: 'haiku', inputTokens: cmpIn, outputTokens: cmpOut });
    } catch (err) {
      if (err.rateLimited) throw err; // let pipeline handle rate limits
      emitter?.emit('think_error', {
        ticket: ticket.id,
        step: stepName,
        round: rounds,
        error: err.message,
      });
      break;
    }

    const verdict = compareResponse.result?.trim() || '';
    const isBetter = verdict.toUpperCase().startsWith('BETTER');
    const reason = verdict.replace(/^(BETTER|WORSE)[:\s]*/i, '').trim();

    if (isBetter) {
      // PIPE-018: the critique is genuinely better — but `challengeResult`
      // is the FINDINGS list, not a fixed artifact. Previously we did
      // `bestResult = challengeResult`, so the next step consumed the
      // original (unfixed) plan/code and the critic insight was discarded
      // (predictor T-001: plan_critic's `rm -rf app/` pre-step never
      // reached the executed plan). Now we APPLY the findings to the real
      // artifact so the fix actually lands. kind:'none' keeps the legacy
      // advisory behaviour (e.g. the review step has no consumable artifact).
      if (reviseTarget.kind === 'none') {
        bestResult = challengeResult;
        history.push({ round: rounds, outcome: 'improved', reason });
        emitter?.emit('think_round_end', {
          ticket: ticket.id, step: stepName, round: rounds,
          outcome: 'improved', reason, discards,
        });
      } else {
        const isJson = reviseTarget.kind === 'json';
        const revisePrompt = isJson
          ? `Apply these accepted review findings to the "${stepName}" output artifact for ticket ${ticket.id}.

The artifact is the JSON file at: ${reviseTarget.artifactPath}

FINDINGS TO INCORPORATE:
${challengeResult}

Read that JSON file, then OVERWRITE it (Write tool) with valid JSON that keeps EXACTLY the same top-level fields/schema but incorporates every fix above. Change only what the findings require. Do not add commentary, do not wrap in markdown — the file must remain machine-parseable JSON.`
          : `Apply these accepted review findings to the implementation for ticket ${ticket.id} by editing the actual source files in the working directory.

FINDINGS TO INCORPORATE:
${challengeResult}

Make the minimal edits the findings prescribe (Read/Edit/Write). Do NOT run tests — the pipeline re-runs them. Do not rewrite unrelated code.`;

        let reviseResult;
        try {
          let rvIn = 0, rvOut = 0, rvTools = 0;
          reviseResult = await spawn({
            prompt: revisePrompt,
            model: config.session.model,
            tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
            maxTurns: 15,
            workingDir: config.project_dir,
            sessionId: null,
            bare: true,
            onData: (event) => {
              const usage = event.message?.usage || event.usage;
              if (usage?.input_tokens) rvIn = usage.input_tokens;
              if (usage?.output_tokens) rvOut += usage.output_tokens;
              if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') rvTools++;
              emitter?.emit('claude_event', {
                ticket: ticket.id, step: stepName, phase: 'think_revise',
                round: rounds, event,
              });
            },
          });
          tokens.reviseIn += rvIn;
          tokens.reviseOut += rvOut;
          console.log(`[usage] ${ticket.id}/${stepName} (think-revise-${rounds}) | ${config.session.model} | ${rvIn.toLocaleString()} in / ${rvOut.toLocaleString()} out | ${rvTools} tools`);
          emitter?.emit('step_attempt_done', { ticket: ticket.id, step: `${stepName}_think_revise`, round: rounds, model: config.session.model, inputTokens: rvIn, outputTokens: rvOut, toolCalls: rvTools });
        } catch (err) {
          if (err.rateLimited) throw err;
          emitter?.emit('think_error', { ticket: ticket.id, step: stepName, round: rounds, error: `revise failed: ${err.message}` });
          break;
        }

        // bestResult must reflect the REVISED artifact so the next round's
        // challenge critiques the fixed version (and the non-convergence
        // detector correctly flags a fix that didn't take).
        if (isJson) {
          try {
            bestResult = await readFile(reviseTarget.artifactPath, 'utf-8');
          } catch {
            bestResult = reviseResult?.result || challengeResult;
          }
        } else {
          bestResult = '(implementation revised in working directory per findings)';
        }
        revised = true;
        history.push({ round: rounds, outcome: 'improved', reason, applied: true });
        emitter?.emit('think_round_end', {
          ticket: ticket.id, step: stepName, round: rounds,
          outcome: 'improved', reason, discards, applied: true,
        });
      }
    } else {
      discards++;
      history.push({ round: rounds, outcome: 'discarded', reason });
      emitter?.emit('think_round_end', {
        ticket: ticket.id,
        step: stepName,
        round: rounds,
        outcome: 'discarded',
        reason,
        discards,
      });
    }

    // PIPE-024: this round produced findings (we got past the
    // NO_IMPROVEMENT/blocked/nonconvergence guards above). If risk is not
    // high and every finding was explicitly graded non-blocking, another
    // full challenge+revise cycle isn't worth the latency — converge now.
    // A blocking finding (or any unknown severity) keeps the loop running,
    // so correctness is never sacrificed.
    if (riskCapEnabled && parseFindings(challengeResult).length > 0
        && !roundHasBlockingFindings(challengeResult)) {
      history.push({ round: rounds, outcome: 'risk_capped', reason: 'round only non-blocking findings; risk != high' });
      emitter?.emit('think_round_end', {
        ticket: ticket.id, step: stepName, round: rounds,
        outcome: 'risk_capped', reason: 'only non-blocking findings (risk-capped)', discards,
      });
      break;
    }
  }

  const improvements = history.filter((h) => h.outcome === 'improved').length;
  if (blocked) {
    emitter?.emit('think_blocked', {
      ticket: ticket.id,
      step: stepName,
      rounds,
      discards,
      reason: blockedReason,
      history,
      tokens,
      revised,
    });
  } else {
    emitter?.emit('think_converged', {
      ticket: ticket.id,
      step: stepName,
      rounds,
      discards,
      improvements,
      revised,
      tokens,
      history,
    });
  }

  return {
    result: bestResult,
    rounds, discards, improvements, history,
    blocked, blockedReason,
    revised,
    reviseKind: reviseTarget.kind,
    tokens,
  };
}
