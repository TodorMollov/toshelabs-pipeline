// Phase 5 policy helpers — separated from pipeline.js so they can be
// unit-tested without standing up the full orchestrator.
//
// pickAttemptModel encodes the "initial attempt uses the step's configured
// model; heal attempts climb a capability ladder" rule. decideRestart
// encodes the "when a step's heals are exhausted, walk back one step and
// try again, up to max_restarts times" rule. Neither has side effects.

const FALLBACK_MODEL = 'opus';

/**
 * Choose the Claude model for a given attempt of a pipeline step.
 *
 * Attempt 1 (initial run): honours `stepConfig.model` when set; otherwise
 * falls back to `ladder[0]`. This preserves explicit per-step model
 * pins (e.g. plan always on opus) for the initial attempt.
 *
 * Attempts 2+: walks the ladder. Beyond the ladder's length, clamps to
 * the last (top-capability) entry. Rationale: the escalation's job is
 * to climb capability, not to cycle or crash when we run out of rungs.
 *
 * Empty ladder + no stepConfig.model: returns FALLBACK_MODEL so we
 * never return `undefined`.
 */
export function pickAttemptModel(stepConfig, attempt, ladder) {
  const laddered = Array.isArray(ladder) ? ladder : [];
  if (attempt <= 1) {
    if (stepConfig?.model) return stepConfig.model;
    return laddered[0] ?? FALLBACK_MODEL;
  }
  if (laddered.length === 0) return FALLBACK_MODEL;
  // attempt=2 → ladder[1], attempt=3 → ladder[2], clamped.
  const index = Math.min(attempt - 1, laddered.length - 1);
  return laddered[index];
}

/**
 * Decide whether to restart from step N-1 after step N has exhausted
 * its heal budget.
 *
 * Refuses when:
 *   - currentStepIndex is 0 (plan) — no N-1 exists.
 *   - restartCount already equals maxRestarts (budget spent).
 *   - maxRestarts is 0 (feature flag off).
 *
 * Otherwise returns shouldRestart=true along with newStepIndex
 * (currentStepIndex - 1) and nextRestartCount (restartCount + 1).
 *
 * Callers: processTicket catches the heal-exhaustion throw, calls
 * this to decide whether to mutate its loop counter and re-enter.
 */
export function decideRestart({
  currentStepIndex,
  restartCount,
  maxRestarts,
}) {
  if (maxRestarts <= 0) {
    return {
      shouldRestart: false,
      reason: 'max_restarts is 0 — restart disabled',
    };
  }
  if (currentStepIndex <= 0) {
    return {
      shouldRestart: false,
      reason: 'current step is plan (index 0) — no prior step to walk back to',
    };
  }
  if (restartCount >= maxRestarts) {
    return {
      shouldRestart: false,
      reason: `restartCount ${restartCount} >= max_restarts ${maxRestarts} — budget exhausted`,
    };
  }
  return {
    shouldRestart: true,
    newStepIndex: currentStepIndex - 1,
    nextRestartCount: restartCount + 1,
  };
}
