/**
 * T-053: Review-phase gate helpers.
 *
 * Two long-standing defects made the REVIEW phase a no-op:
 *   1. docs/code_validation.md (the project rubric) was never given to the
 *      reviewer, so its 100+ rules and grep detectors were never applied.
 *   2. A review that failed to produce a valid review.json was silently
 *      replaced with `{ findings: [], verdict: 'clean' }` and shipped.
 *
 * These helpers are pure + injectable so they can be unit-tested without a
 * live pipeline run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load the project's review rubric (docs/code_validation.md) from the
 * worktree so it can be injected into the reviewer prompt. Returns the file
 * contents, or a clear sentinel string when the project has no rubric — the
 * prompt must still render either way (never throw).
 */
export function loadCodeValidationRubric(worktree) {
  if (!worktree) return '(no worktree path provided — review rubric unavailable)';
  const p = resolve(worktree, 'docs/code_validation.md');
  if (!existsSync(p)) {
    return '(no docs/code_validation.md in this project — apply general review judgement)';
  }
  try {
    return readFileSync(p, 'utf-8');
  } catch (err) {
    return `(failed to read docs/code_validation.md: ${err.message})`;
  }
}

/**
 * Decide whether the review phase blocks the ticket from proceeding to
 * apply/commit/merge.
 *
 * - A review that could not be validated (missing/malformed review.json)
 *   MUST block — shipping it as "clean" was the silent-pass bug.
 * - A `blocked` verdict blocks (operator intervention required).
 * - `clean` / `findings` proceed (worker-apply fixes findings downstream).
 *
 * Returns { block: boolean, reason: string|null }.
 */
export function decideReviewGate(reviewVerify) {
  if (!reviewVerify || reviewVerify.status !== 'match') {
    const why = reviewVerify?.reason || 'missing or malformed review.json';
    return { block: true, reason: `review could not be validated (${why}) — refusing to ship unreviewed code` };
  }
  const verdict = reviewVerify.payload?.verdict;
  if (verdict === 'blocked') {
    return { block: true, reason: 'reviewer verdict=blocked — operator intervention required' };
  }
  return { block: false, reason: null };
}
