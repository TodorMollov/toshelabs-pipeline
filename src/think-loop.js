import { spawnClaude } from './runner.js';

/**
 * Self-challenge protocol — mechanically enforced by the orchestrator.
 *
 * 1. DO call produces initial result
 * 2. CHALLENGE call critiques it (separate CLI invocation)
 * 3. COMPARE: is the new version better?
 *    - Yes → replace best, round++
 *    - No → discard++
 * 4. 3 discards OR 10 rounds → converged
 */
export async function thinkLoop({
  initialResult,
  stepName,
  challengeQuestion,
  config,
  sessionId,
  ticket,
  emitter,
}) {
  const maxRounds = config.think_loop.max_rounds;
  const maxDiscards = config.think_loop.max_discards;

  let bestResult = initialResult;
  let discards = 0;
  let rounds = 0;
  const history = [];

  while (rounds < maxRounds && discards < maxDiscards) {
    rounds++;

    emitter?.emit('think_round_start', {
      ticket: ticket.id,
      step: stepName,
      round: rounds,
      discards,
    });

    // CHALLENGE: ask Claude to critique the current best
    const challengePrompt = `You are reviewing the output of the "${stepName}" step for ticket ${ticket.id}: "${ticket.title}".

Here is the current best result:
---
${typeof bestResult === 'string' ? bestResult : JSON.stringify(bestResult, null, 2)}
---

Challenge this result. ${challengeQuestion}

Try to find something deeper, simpler, or more complete. If you find an improvement, output the COMPLETE improved version. If you cannot improve it, say "NO_IMPROVEMENT" and explain why.

Important: Do not add unnecessary complexity. Do not suggest abstractions that would only have one caller. Simple and correct beats clever.`;

    let challengeResult;
    try {
      const response = await spawnClaude({
        prompt: challengePrompt,
        model: config.session.model,
        tools: ['Read', 'Grep', 'Glob'],
        maxTurns: 10,
        systemPromptFile: config._resolved.validationRules,
        workingDir: config.project_dir,
        sessionId,
        bare: true,
        onData: (event) => {
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
      // Update sessionId if returned
      if (response.sessionId) sessionId = response.sessionId;
    } catch (err) {
      // If challenge call fails, stop the loop — don't crash the pipeline
      emitter?.emit('think_error', {
        ticket: ticket.id,
        step: stepName,
        round: rounds,
        error: err.message,
      });
      break;
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
      compareResponse = await spawnClaude({
        prompt: comparePrompt,
        model: config.session.model,
        tools: [],
        maxTurns: 1,
        bare: true,
        workingDir: config.project_dir,
        onData: (event) => {
          emitter?.emit('claude_event', {
            ticket: ticket.id,
            step: stepName,
            phase: 'think_compare',
            round: rounds,
            event,
          });
        },
      });
    } catch (err) {
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

  emitter?.emit('think_converged', {
    ticket: ticket.id,
    step: stepName,
    rounds,
    discards,
    improvements: history.filter((h) => h.outcome === 'improved').length,
    history,
  });

  return { result: bestResult, rounds, discards, history, sessionId };
}
