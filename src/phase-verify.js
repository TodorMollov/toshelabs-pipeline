// Phase verification for the soft pipeline.
//
// Three pure functions that the soft dispatcher calls at every phase
// boundary and on restart. All file IO; no LLM, no network.
//
// The contract:
//   - Phase output is canonical only after the checkpoint file exists AND
//     parses against schema AND worktree state matches the checkpoint's
//     declared output.
//   - On restart, the orchestrator walks phases in order, calls
//     verifyCheckpoint on each, and resumes from the first phase that
//     isn't `match`.
//   - Markers from worker stdout (`<<<PHASE: X_done>>>`) are advisory
//     only — never trusted without a corresponding verified checkpoint.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';

// Phases the soft worker runs, in order. Conditional phases are still
// listed — verifyCheckpoint returns `not_applicable` for them when the
// condition doesn't hold (e.g. root_cause for non-bug tickets).
export const SOFT_PHASE_ORDER = [
  'plan',
  'tests_red',
  'implement',
  'tests_green',
  'docs_update',          // conditional: type == feature
  // ── review boundary — separate spawn ──
  'review',
  // ── apply-feedback boundary — separate spawn ──
  'apply_review_feedback',
  'root_cause',           // conditional: type == bug
  // ── commit handled by orchestrator, not a worker phase ──
];

/**
 * Verify a single phase checkpoint against worktree state.
 *
 * @param {object} args
 * @param {string} args.ticketDir   absolute path to worker-output/{ticket}/
 * @param {string} args.phase       one of SOFT_PHASE_ORDER
 * @param {string} args.worktree    absolute path to the worktree (for git ops)
 * @param {object} args.ticket      the ticket object (type, files_to_change, etc.)
 * @returns {{status: 'match'|'missing'|'divergence'|'not_applicable', reason?: string, payload?: object}}
 */
export function verifyCheckpoint({ ticketDir, phase, worktree, ticket }) {
  const checkpointPath = resolve(ticketDir, `${phase}.json`);

  // Phase not applicable to this ticket — skip cleanly.
  if (!appliesToTicket(phase, ticket)) {
    return { status: 'not_applicable', reason: `phase ${phase} does not apply to ticket type ${ticket?.type || 'unknown'}` };
  }

  // No checkpoint = phase hasn't run yet (or partial write got rolled back).
  if (!existsSync(checkpointPath)) {
    return { status: 'missing', reason: `no ${phase}.json at ${checkpointPath}` };
  }

  // Parse + schema sanity. Reject zero-byte / partial / malformed.
  let payload;
  try {
    const raw = readFileSync(checkpointPath, 'utf-8');
    if (!raw.trim()) {
      return { status: 'missing', reason: `${phase}.json is empty (likely partial write)` };
    }
    payload = JSON.parse(raw);
  } catch (err) {
    return { status: 'missing', reason: `${phase}.json unparseable: ${err.message}` };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'missing', reason: `${phase}.json is not an object` };
  }

  // Phase-specific consistency check against the worktree.
  const consistency = checkWorktreeMatchesCheckpoint(phase, payload, worktree, ticket);
  if (consistency.status !== 'match') return consistency;

  return { status: 'match', payload };
}

/**
 * Determine where to resume the worker on a restart. Walks phases in order,
 * stops at the first phase that isn't `match` (excluding `not_applicable`,
 * which is skipped past).
 *
 * @returns {{ resumeFrom: string|null, completed: string[], divergences: object[] }}
 *   resumeFrom: phase name, or null if the whole worker block is complete
 *   completed: phases that verified as match (or not_applicable)
 *   divergences: phases that have a checkpoint but disagree with worktree —
 *     these require operator review, not auto-resume
 */
export function determineResumePoint({ ticketDir, worktree, ticket, phases = SOFT_PHASE_ORDER }) {
  const completed = [];
  const divergences = [];
  for (const phase of phases) {
    const result = verifyCheckpoint({ ticketDir, phase, worktree, ticket });
    if (result.status === 'match' || result.status === 'not_applicable') {
      completed.push(phase);
      continue;
    }
    if (result.status === 'divergence') {
      divergences.push({ phase, reason: result.reason });
      // Don't resume past a divergence — operator must resolve.
      return { resumeFrom: null, completed, divergences, requiresOperator: true };
    }
    // status === 'missing' → resume here
    return { resumeFrom: phase, completed, divergences };
  }
  return { resumeFrom: null, completed, divergences };
}

/**
 * Build the prompt fragment that tells a resumed worker where to start.
 * Included in the spawn prompt's preamble.
 */
export function buildResumePrompt({ completed, resumeFrom, ticketDir }) {
  if (completed.length === 0) {
    return `Starting fresh on this ticket. Begin with phase: ${resumeFrom}.`;
  }
  const lines = [
    'You are resuming this ticket after a restart. Phases already complete (verified by orchestrator against worktree state):',
    ...completed.map((p) => `  - ${p} (checkpoint: ${ticketDir}/${p}.json)`),
    '',
    `Start from phase: ${resumeFrom}.`,
    '',
    'DO NOT re-emit phase markers for already-complete phases. Read their checkpoints if you need their outputs. Begin with the first marker for your resume phase.',
  ];
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Per-phase consistency checks against the worktree.
//
// Each check answers: "given this checkpoint payload, does the worktree
// actually reflect what the checkpoint claims?" The bar is loose by design —
// we want to catch egregious divergence (file declared in plan was never
// touched, tests claimed to fail but don't exist) without policing every
// detail (line-level diff equivalence would force re-verification on every
// trivial edit).
// ----------------------------------------------------------------------------

function checkWorktreeMatchesCheckpoint(phase, payload, worktree, ticket) {
  switch (phase) {
    case 'plan':
      return checkPlanPhase(payload, worktree);
    case 'tests_red':
      return checkTestsRedPhase(payload, worktree);
    case 'implement':
      return checkImplementPhase(payload, worktree);
    case 'tests_green':
      return checkTestsGreenPhase(payload, worktree);
    case 'docs_update':
      return checkDocsUpdatePhase(payload, worktree);
    case 'review':
      return checkReviewPhase(payload, worktree);
    case 'apply_review_feedback':
      return checkApplyFeedbackPhase(payload, worktree);
    case 'root_cause':
      return checkRootCausePhase(payload);
    default:
      return { status: 'match' };
  }
}

function checkPlanPhase(payload, _worktree) {
  // Plan is pure declaration — no worktree side effects yet. Just sanity.
  if (!Array.isArray(payload.files_to_change) || payload.files_to_change.length === 0) {
    return { status: 'divergence', reason: 'plan.files_to_change is missing or empty' };
  }
  if (!payload.test_strategy || typeof payload.test_strategy !== 'string') {
    return { status: 'divergence', reason: 'plan.test_strategy is missing' };
  }
  return { status: 'match' };
}

function checkTestsRedPhase(payload, worktree) {
  // Two valid shapes:
  //   (a) tests written: payload.tests_added is non-empty, files exist in worktree
  //   (b) no-test: payload.no_test_reason explains why no tests were written
  if (payload.no_test_reason) {
    if (typeof payload.no_test_reason !== 'string' || payload.no_test_reason.length < 10) {
      return { status: 'divergence', reason: 'tests_red claims no-test but no_test_reason is missing/too short' };
    }
    return { status: 'match' };
  }
  const declared = Array.isArray(payload.tests_added) ? payload.tests_added : [];
  if (declared.length === 0) {
    return { status: 'divergence', reason: 'tests_red checkpoint declares zero tests added and no no_test_reason' };
  }
  for (const f of declared) {
    const filePath = typeof f === 'string' ? f : f.path || f.file;
    if (!filePath) continue;
    const abs = resolve(worktree, filePath);
    if (!existsSync(abs)) {
      return { status: 'divergence', reason: `tests_red declared test file ${filePath} but it does not exist in worktree` };
    }
  }
  return { status: 'match' };
}

function checkImplementPhase(payload, worktree) {
  // Worker must have touched declared files. We can't easily verify "changed
  // these files since baseline" without git diff; use existence as the cheap
  // check. The git-diff verification belongs in tests_green's full-suite run.
  const declared = Array.isArray(payload.files_changed) ? payload.files_changed : [];
  if (declared.length === 0) {
    // Escape hatch: a legitimate no-source-change ticket (e.g. BUG-1017, where
    // the fix was already shipped by a prior ticket and the only deliverable
    // was a test added during tests_red). The worker must justify the no-op
    // by populating files_skipped with reasoned entries — otherwise an empty
    // files_changed is still a contract violation.
    const skipped = Array.isArray(payload.files_skipped) ? payload.files_skipped : [];
    const allSkippedReasoned = skipped.length > 0 && skipped.every((f) => {
      const reason = typeof f === 'object' && f ? f.reason : null;
      return typeof reason === 'string' && reason.length >= 20;
    });
    if (allSkippedReasoned) return { status: 'match' };
    return { status: 'divergence', reason: 'implement checkpoint declares zero files_changed' };
  }
  for (const f of declared) {
    const path = typeof f === 'string' ? f : f.path || f.file;
    if (!path) continue;
    if (!existsSync(resolve(worktree, path))) {
      return { status: 'divergence', reason: `implement declared changed file ${path} but it does not exist in worktree` };
    }
  }
  return { status: 'match' };
}

function checkTestsGreenPhase(payload, _worktree) {
  // Analyzer/tsc errors are deterministic and branch-independent for the
  // worker's own code — these stay hard gates regardless of suite state.
  if (typeof payload.analyzer_errors === 'number' && payload.analyzer_errors > 0) {
    return { status: 'divergence', reason: `tests_green reports ${payload.analyzer_errors} analyzer errors` };
  }
  if (typeof payload.tsc_errors === 'number' && payload.tsc_errors > 0) {
    return { status: 'divergence', reason: `tests_green reports ${payload.tsc_errors} tsc errors` };
  }

  // Convergence means "this ticket introduced no failing tests", NOT "the full
  // suite is green". A worktree branch legitimately carries pre-existing reds
  // unrelated to the ticket (e.g. BUG-1007 backend baseline, branch-only
  // privacy-content reds). Gating on full-suite all_pass false-fails honest
  // workers that touched none of those files (see BUG-1011 / BUG-1013).
  if (payload.all_pass === true) {
    // Sanity: a true all_pass must not contradict a flat failing count UNLESS
    // every red is itemised as pre-existing baseline (same evidence shape the
    // all_pass=false branch accepts below). BUG-1011 hit this: the worker
    // truthfully reported `unit_tests.failed=1` (the pre-existing BUG-1007
    // m007 red) alongside `all_pass:true` ("green relative to my changes")
    // and was rejected as self-contradicting — wasting a full ticket run.
    const unit = payload.unit_tests || {};
    if (typeof unit.failed === 'number' && unit.failed > 0) {
      // PIPE-029: every current red must be itemised as pre-existing — a single
      // documented red must NOT excuse N actual reds. redsFullyAccounted requires
      // the documented baseline to COVER unit.failed.
      if (redsFullyAccounted(payload, unit.failed)) return { status: 'match' };
      const documented = collectPreexisting(payload).length;
      return {
        status: 'divergence',
        reason: `tests_green claims all_pass but unit_tests.failed=${unit.failed} with only ${documented} red(s) itemised as pre-existing — list every red in top-level preexisting_failures (or fix the regressions)`,
      };
    }
    return { status: 'match' };
  }

  // all_pass=false is acceptable ONLY when the worker explicitly accounts for
  // every red as pre-existing baseline (zero regressions introduced) AND
  // documents which tests are pre-existing. Both field spellings are accepted
  // (regression_introduced / introduced_failures); the documented list is
  // required as evidence so a bare all_pass=false cannot slip through.
  const unitFalse = payload.unit_tests || {};
  if (redsFullyAccounted(payload, typeof unitFalse.failed === 'number' ? unitFalse.failed : null)) {
    return { status: 'match' };
  }
  return {
    status: 'divergence',
    reason: `tests_green has all_pass=${payload.all_pass} without zero-regression + documented-baseline accounting; phase did not converge`,
  };
}

// Collect the worker's documented pre-existing-failure baseline. Canonical field
// is the top-level `preexisting_failures` array; a `full_suite.preexisting_failures`
// nest is accepted defensively. Workers are instructed to emit the top-level field
// (prompts/worker.md tests_green contract).
function collectPreexisting(payload) {
  const out = [];
  const push = (v) => {
    if (Array.isArray(v)) for (const x of v) if (x != null) out.push(typeof x === 'string' ? x : JSON.stringify(x));
  };
  push(payload.preexisting_failures);
  if (payload.full_suite) push(payload.full_suite.preexisting_failures);
  return [...new Set(out)];
}

// True when every currently-failing test is accounted for as a documented
// pre-existing red and the worker did not flag a regression. When `failed` is a
// number the documented list must COVER it (length >= failed) so a token
// single-entry baseline cannot excuse an unbounded number of reds (PIPE-029).
// When `failed` is unknown, fall back to "explicit zero-regression + a non-empty
// documented baseline".
function redsFullyAccounted(payload, failed) {
  if (payload.regression_introduced === true) return false;
  const documented = collectPreexisting(payload).length;
  if (typeof failed === 'number') return documented >= failed;
  const noRegression = payload.regression_introduced === false || payload.introduced_failures === 0;
  return noRegression && documented > 0;
}

function checkDocsUpdatePhase(payload, worktree) {
  // Optional phase — if no files touched, that's fine (worker decided no
  // docs change needed). If declared, the files must exist.
  const declared = Array.isArray(payload.files_changed) ? payload.files_changed : [];
  for (const f of declared) {
    const path = typeof f === 'string' ? f : f.path || f.file;
    if (path && !existsSync(resolve(worktree, path))) {
      return { status: 'divergence', reason: `docs_update declared changed file ${path} but it does not exist in worktree` };
    }
  }
  return { status: 'match' };
}

function checkReviewPhase(payload, _worktree) {
  if (!Array.isArray(payload.findings)) {
    return { status: 'divergence', reason: 'review.json findings is not an array' };
  }
  if (!['clean', 'findings', 'blocked'].includes(payload.verdict)) {
    return { status: 'divergence', reason: `review.verdict must be clean|findings|blocked, got: ${payload.verdict}` };
  }
  return { status: 'match' };
}

function checkApplyFeedbackPhase(payload, _worktree) {
  // Each finding in review.json should have been processed (status !== pending).
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const pending = findings.filter((f) => !f.status || f.status === 'pending');
  if (pending.length > 0) {
    return { status: 'divergence', reason: `apply_review_feedback left ${pending.length} findings in pending state: ${pending.map(f => f.id).join(', ')}` };
  }
  return { status: 'match' };
}

function checkRootCausePhase(payload) {
  if (!payload.why || !payload.why_not_caught) {
    return { status: 'divergence', reason: 'root_cause.json missing required fields (why, why_not_caught)' };
  }
  // new_rule is optional — sometimes the answer genuinely is "no new rule"
  // (one-off environmental issue). Worker should still articulate the case
  // in why_not_caught explicitly.
  return { status: 'match' };
}

// ----------------------------------------------------------------------------
// Phase applicability rules
// ----------------------------------------------------------------------------

function appliesToTicket(phase, ticket) {
  if (!ticket) return true; // can't decide — assume applies
  if (phase === 'docs_update') {
    return ticket.type === 'feature';
  }
  if (phase === 'root_cause') {
    return ticket.type === 'bug';
  }
  return true;
}

// ----------------------------------------------------------------------------
// Helper: git-status check used by the dispatcher around phase verification.
// Returns the list of modified files (tracked + untracked) in the worktree.
// ----------------------------------------------------------------------------

export function listWorktreeChanges(worktree) {
  try {
    const out = execSync('git status --porcelain', { cwd: worktree, encoding: 'utf-8' });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3)); // strip the 2-char status + space
  } catch {
    return [];
  }
}
