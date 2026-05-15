import { spawnClaude } from './runner.js';

// Normalize a challenge's findings into a stable set of issue signatures so
// we can detect the loop re-raising the SAME structural problem every round
// (non-convergence) instead of burning the full round budget on it.
function parseFindingSignatures(text) {
  if (!text) return [];
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return [...new Set(
      arr
        .map((f) => (f && typeof f.issue === 'string' ? f.issue : ''))
        .filter(Boolean)
        .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80))
    )];
  } catch {
    return [];
  }
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
}) {
  const maxRounds = config.think_loop.max_rounds;
  const maxDiscards = config.think_loop.max_discards;

  let bestResult = initialResult;
  let discards = 0;
  let rounds = 0;
  let blocked = false;
  let blockedReason = '';
  const history = [];
  const issueFirstSeenRound = new Map(); // signature -> round first seen

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

If you find problems, output ONLY a JSON array of findings:
[{"file": "path", "line": N, "issue": "one sentence", "fix": "one sentence"}]

If no problems found, output exactly: NO_IMPROVEMENT

If the output cannot be fixed by editing code or the plan because it depends on something that does not exist or contradicts itself — a missing/wrong credential or key, an unprovisioned external service, or a ticket scope that requires something not available — do NOT emit findings. Output exactly one line:
BLOCKED: <one sentence — what is missing and why iterating cannot fix it>

No prose. No explanations. No complete rewrites. Just the findings array, or NO_IMPROVEMENT, or one BLOCKED: line.`;

    let challengeResult;
    try {
      let chIn = 0, chOut = 0, chTools = 0;
      const chStart = Date.now();
      const response = await spawnClaude({
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
      compareResponse = await spawnClaude({
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
      bestResult = challengeResult;
      history.push({ round: rounds, outcome: 'improved', reason });
      emitter?.emit('think_round_end', {
        ticket: ticket.id,
        step: stepName,
        round: rounds,
        outcome: 'improved',
        reason,
        discards,
      });
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
  }

  if (blocked) {
    emitter?.emit('think_blocked', {
      ticket: ticket.id,
      step: stepName,
      rounds,
      discards,
      reason: blockedReason,
      history,
    });
  } else {
    emitter?.emit('think_converged', {
      ticket: ticket.id,
      step: stepName,
      rounds,
      discards,
      improvements: history.filter((h) => h.outcome === 'improved').length,
      history,
    });
  }

  return { result: bestResult, rounds, discards, history, blocked, blockedReason };
}
