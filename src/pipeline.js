import { readFile, writeFile, mkdir, readdir, copyFile } from 'fs/promises';
import { existsSync, statSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { loadBacklog, filterAndSort, archiveTicket, setBacklogTicketStatus } from './backlog.js';
import { spawnClaude } from './runner.js';
import { thinkLoop } from './think-loop.js';
import { validateStep, isTestPath } from './validator.js';
import { buildPrompt } from './prompts.js';
import { acquireLock, releaseLock } from './lock.js';
import {
  setupTicketBaseline,
  revertToBaseline,
  commitTicketAsOne,
  cleanupBaseline,
  autoCommitPaths,
  CheckpointError,
} from './checkpoint.js';
import {
  ensureWorktree,
  prepareWorktreeForTicket,
  cherryPickToMaster,
} from './worktree.js';
import { pickAttemptModel, decideRestart, shouldHeal } from './retry-policy.js';
import { checkWriteZones, formatViolations, globMatch as globMatchSimple } from './write-zones.js';
import { loadCodeValidationRubric, decideReviewGate } from './review-gate.js';

// Module-scoped set of ticket ids already surfaced as stranded in this
// server process. Without this, every `/api/run/all` re-scans the pipeline
// dir and re-emits pipeline_crashed_detected for the same tickets — 23
// duplicates in a single day's ops log. Cleared on server restart.
const _crashedDetectedThisBoot = new Set();

// PIPE-019: exit code run() uses to ask the start.sh supervisor for a
// clean relaunch (graceful restart-between-tickets). 75 = EX_TEMPFAIL
// ("try again") from sysexits.h — distinct from 0 (normal stop) and 1
// (crash), so the supervisor can tell "relaunch me" from "I'm done".
export const RESTART_EXIT_CODE = 75;

// Per-step worker-output schema (2026-04-27 architectural fix).
// Workers write a flat JSON object to {worker_output_dir}/{ticket}/{step}.json.
// The orchestrator's ingestWorkerOutput accepts ONLY the fields listed here for
// each step. Everything else the worker writes is dropped, including any
// attempt to set state for other pipeline steps. Schema is intentionally
// generous within a step to accommodate prompt evolution; new fields require
// adding here, not silently land.
const STEP_OUTPUT_SCHEMA = {
  plan: [
    'status', 'reason',
    'files_to_change', 'callers_traced', 'edge_cases', 'test_strategy', 'risk',
    'suggested_sub_tickets',
  ],
  tests_red: [
    'status', 'reason',
    'outcome', 'test_files', 'test_names', 'tests_before', 'tests_after',
    'failure_output', 'baseline_failures', 'criteria_to_test_map',
  ],
  implement: [
    'status', 'reason',
    'files_changed', 'files_skipped',
    'review_feedback', 'explicit_fixes', // populated by review→implement loop
  ],
  tests_green: [
    // Orchestrator-only step. The native runTestsGreen body writes test
    // results directly via savePipelineJson; workers never produce
    // tests_green output. Empty schema means ingestWorkerOutput rejects
    // ALL worker writes for this step — no worker can claim all_pass:true
    // without the orchestrator actually running the test suite. (2026-04-27
    // BUG-253 incident: gate-level selfHeal worker wrote `status:"passed",
    // all_pass:true, unit_tests:{passed:2071,failed:0}` and the schema
    // accepted everything.)
  ],
  review: [
    'status', 'reason',
    'checklist_items_checked', 'findings', 'findings_fixed', 'findings_considered',
  ],
  root_cause: [
    'status', 'reason',
    'why_happened', 'why_not_caught', 'proposed_rule',
  ],
  docs_update: [
    'status', 'reason',
    'files_updated',
  ],
};

export class Pipeline {
  constructor(config, opts = {}) {
    this.config = config;
    this.dryRun = opts.dryRun || false;
    this.ticketId = opts.ticketId || null;
    this.pause = opts.pause || false;
    this.emitter = opts.emitter || null;
    this.sessionId = null;
    this.usageTimer = null;
    // Reference to the currently-running Claude subprocess, if any. Set
    // by spawnClaude's onSpawn callback inside runStepWithHealing.
    // `/api/stop?hard=true` uses this to SIGTERM the step immediately
    // instead of waiting for Claude to finish naturally.
    this.activeSubprocess = null;
    // Sticky stop signal (PIPE-014). Set by requestStop() when the
    // operator clicks Stop. Checked at three supervisor checkpoints:
    // top of ticket loop, top of step loop, top of heal-attempt loop.
    // Without this, killing the active subprocess only halted the
    // current attempt — the heal loop retried, or the supervisor
    // marched to the next step / ticket.
    this.stopRequested = false;
    // PIPE-019: graceful restart-between-tickets. Unlike stopRequested
    // this does NOT kill the running subprocess — the current ticket is
    // allowed to finish cleanly. At the next ticket boundary run() exits
    // the process with RESTART_EXIT_CODE; the start.sh supervisor relaunches
    // node (picking up freshly-deployed code) and the queue resumes —
    // already-`done` tickets are skipped via their pipeline-state, so the
    // remaining `requested` tickets continue automatically.
    this.restartRequested = false;
    // Worktree-per-pipeline-run: when enabled, the orchestrator runs
    // each ticket in {pipelineHome}/projects/{name}/worktree rather
    // than in config.project_dir, so the operator can keep editing
    // the primary checkout in parallel. `this.cwd` is what every git
    // / worker / shell call should target. activeWorktree is set at
    // ticket start and cleared at ticket end (in run()).
    this.activeWorktree = null;
    this.worktreeBranch = null;
    this.worktreeEnabled = config.worktree?.enabled !== false;
  }

  // The path the pipeline operates in for a ticket. Defaults to
  // project_dir; switches to the worktree once a ticket starts in
  // worktree mode. All git/shell ops + worker spawn cwds should use
  // this getter rather than `config.project_dir`.
  get cwd() {
    return this.activeWorktree || this.config.project_dir;
  }

  // Shallow-cloned config with project_dir rewritten to the active
  // worktree. Used for buildPrompt so prompt templates that interpolate
  // {{project_dir}} or read referenced files do so against the worktree.
  // Does NOT mutate the shared config object (server.js reads
  // config.project_dir at request time and would surface worktree paths
  // to the dashboard if we mutated in place).
  effectiveConfig() {
    if (!this.activeWorktree) return this.config;
    return { ...this.config, project_dir: this.activeWorktree };
  }

  /**
   * Operator-initiated stop. Sets the sticky flag AND kills the
   * currently-running subprocess. The flag is what actually halts
   * the pipeline — kill alone wasn't enough because the heal loop
   * retried and the supervisor advanced to the next step/ticket
   * (PIPE-014). Safe to call multiple times.
   */
  requestStop() {
    this.stopRequested = true;
    return this.stopActiveSubprocess();
  }

  /**
   * PIPE-019: operator-initiated graceful restart. Sets a sticky flag but
   * deliberately does NOT touch the running subprocess — the in-flight
   * ticket runs to completion (and is cherry-picked) before run() exits
   * the process at the next ticket boundary. Idempotent. Returns the flag
   * so the API can confirm it was armed.
   */
  requestRestartAfterTicket() {
    this.restartRequested = true;
    return this.restartRequested;
  }

  /**
   * Hard-stop: terminate the currently-running Claude subprocess. The
   * spawnClaude promise then rejects; the enclosing step throws and
   * the pipeline winds down through its normal error path. Harmless
   * no-op when no subprocess is active.
   */
  stopActiveSubprocess() {
    const proc = this.activeSubprocess;
    if (!proc || proc.killed) return false;
    try {
      proc.kill('SIGTERM');
      // Hard safety: if SIGTERM doesn't land within 5s, escalate.
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch { /* noop */ }
      }, 5000).unref();
      return true;
    } catch {
      return false;
    }
  }

  emit(event, data) {
    this.emitter?.emit(event, { timestamp: new Date().toISOString(), ...data });
  }

  async run() {
    // Pipeline mode dispatch. `soft` (3-spawn worker/reviewer/apply architecture)
    // is the default; `classic` is the legacy 7-step state machine kept as
    // opt-in for projects that haven't been A/B-validated yet. The soft path
    // is not yet implemented at the dispatcher level — when wired, it will
    // route to a separate run-loop. For now, both modes execute the classic
    // path and the flag is informational only (emitted for UI + telemetry).
    const pipelineMode = this.config.pipeline_mode || 'soft';
    this.emit('pipeline_start', { mode: pipelineMode });
    console.log(`[pipeline] mode=${pipelineMode} — ${pipelineMode === 'soft' ? '3-spawn worker/reviewer/apply dispatch' : 'classic 7-step state machine'}`);

    // Phase 0: Setup
    const lockResult = await acquireLock(
      this.config._resolved.codeLock,
      `pipeline run — ${new Date().toISOString()}`
    );
    if (!lockResult.acquired) {
      this.emit('pipeline_blocked', { holder: lockResult.holder });
      console.error(`Code lock held by: ${lockResult.holder}`);
      return;
    }
    this.emit('lock_acquired', {});

    try {
      // Check for crashed pipelines (resume) — but only when no specific
      // ticket was pinned. An explicit "Run T-X" click should not pull in
      // unrelated stranded tickets ahead of the user's choice.
      const resumed = this.ticketId ? [] : await this.checkCrashedPipelines();

      // PIPE-021: reconcile the archive invariant before processing —
      // surfaces any false-done strands loudly without blocking the queue.
      try { await this.reconcileArchiveInvariant(); } catch (err) {
        console.warn(`[reconcile] skipped: ${err.message}`);
      }

      // Load and filter backlog
      const allTickets = await loadBacklog(this.config);
      const queue = resumed.concat(
        filterAndSort(allTickets, this.config, this.ticketId).filter(
          (t) => !resumed.find((r) => r.id === t.id)
        )
      );

      this.emit('queue_ready', {
        total: queue.length,
        tickets: queue.map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
      });

      if (queue.length === 0) {
        this.emit('pipeline_empty', {});
        console.log('No actionable tickets in backlog.');
        return;
      }

      // 2026-05-20: first-DIRTY halt. If the merge gate refuses to land a
      // ticket because the operator's master is dirty (or any equivalent
      // pre-condition error — DIRTY/CONFLICT/WRONG_BRANCH/NOT_ON_MASTER),
      // every subsequent ticket in this batch will hit the SAME wall —
      // marching on burns hours of worker time producing commits that
      // can't ship and stack up as `pipeline/pending-merge-*` tags. Halt
      // immediately, surface the issue, and let the operator unblock.
      // The just-failed ticket's pipeline-state already records
      // merge.status=pending; on the next run the merge will be retried.
      let mergeBlockedHalt = null;
      // Process tickets one at a time
      for (let i = 0; i < queue.length; i++) {
        if (this.stopRequested) {
          this.emit('pipeline_stop_observed', { remaining: queue.length - i });
          break;
        }
        const queuedTicket = queue[i];
        // Re-read the ticket from backlog.json at ticket start rather than
        // using the snapshot captured at run() entry. Fixes the 2026-04-21
        // gotcha where editing backlog.json mid-run (e.g. adding
        // step_overrides) had no effect until the pipeline was restarted —
        // run() had already cached the stale ticket. Fall back to the
        // queued snapshot if the ticket has since been removed (edge case
        // but avoids a crash).
        let ticket = queuedTicket;
        try {
          const fresh = await loadBacklog(this.config);
          const match = fresh.find((t) => t.id === queuedTicket.id);
          if (match) ticket = match;
        } catch { /* keep queuedTicket */ }

        // PIPE-020: hard dependency-ordering gate. A ticket whose declared
        // depends_on prerequisites have not landed must NOT run — running it
        // produces code whose stated premise has no foundation and merges
        // green, hiding the cascade. Skip + mark blocked with a reason
        // naming the unsatisfied dependency and its status.
        const depCheck = await this.dependenciesSatisfied(ticket);
        if (!depCheck.ok) {
          const reason = `dependency not satisfied: ${depCheck.unsatisfied
            .map((d) => `${d.id} (status=${d.status})`).join(', ')}`;
          this.emit('ticket_blocked_on_dependency', {
            ticket: ticket.id, unsatisfied: depCheck.unsatisfied, reason,
          });
          console.error(`[depends_on] ${ticket.id}: SKIPPED — ${reason}`);
          try {
            const st = await this.loadOrCreatePipelineJson(ticket);
            st.status = 'blocked';
            st.blocked_reason = `[PIPE-020] ${reason}`;
            st.blocked_at = new Date().toISOString();
            await this.savePipelineJson(ticket.id, st);
          } catch { /* best-effort: the event + log already surfaced it */ }
          continue;
        }

        this.emit('ticket_start', { ticket: ticket.id, title: ticket.title, index: i, total: queue.length });

        // Fresh session per ticket
        this.sessionId = null;
        // Worktree-per-pipeline-run: set up an isolated worktree where
        // the ticket runs, leaving the operator's primary checkout free
        // for parallel edits. On any failure to set up, we fall back to
        // running directly in project_dir (legacy behavior).
        let worktreeCtx = null;
        try {
        if (!this.dryRun && this.worktreeEnabled) {
          try {
            const wtDir = this.config._resolved.projectWorktree;
            const wtBranch = this.config._resolved.projectWorktreeBranch;
            const { defaultBranch } = ensureWorktree(this.config.project_dir, wtDir, wtBranch);
            prepareWorktreeForTicket(wtDir, defaultBranch);
            this.activeWorktree = wtDir;
            this.worktreeBranch = wtBranch;
            worktreeCtx = { dir: wtDir, branch: wtBranch, defaultBranch };
            this.emit('worktree_ready', { ticket: ticket.id, worktree: wtDir, branch: wtBranch });
            console.log(`[worktree] ${ticket.id}: ready at ${wtDir} (${wtBranch}, base=${defaultBranch})`);
          } catch (err) {
            this.activeWorktree = null;
            this.worktreeBranch = null;
            this.emit('worktree_setup_failed', { ticket: ticket.id, error: err.message });
            console.error(`[worktree] ${ticket.id}: setup failed (${err.message}), falling back to project_dir`);
          }
        }
        try {
          // Dispatch to soft pipeline (3-spawn) or classic (7-step) based
          // on the project's pipeline_mode flag. Default is soft. Classic
          // remains the proven fallback for projects not yet validated on
          // the soft path.
          const mode = this.config.pipeline_mode || 'soft';
          if (mode === 'soft') {
            await this.processTicketSoft(ticket, worktreeCtx);
          } else {
            await this.processTicket(ticket);
          }
        } catch (err) {
          if (err.rateLimited) throw err; // bubble up — runWithRateLimitRetry handles the wait
          console.error(`[pipeline] ${ticket.id} failed: ${err.message}`);
          // Persist the failure to the ticket state file so it doesn't
          // remain in_progress forever and get re-queued as a "crashed"
          // ticket on the next restart.
          let failedState = null;
          try {
            failedState = await this.loadPipelineJson(ticket.id);
            if (failedState && failedState.status === 'in_progress') {
              if (this.stopRequested) {
                failedState.status = 'blocked';
                failedState.blocked_at = new Date().toISOString();
                failedState.blocked_reason = 'user_stopped_via_api_stop';
              } else if (err.thinkBlocked) {
                // Think-loop infeasibility / non-convergence: a human must
                // resolve the prereq or rescope the ticket — not a crash,
                // and re-running would just re-burn tokens. Mark blocked.
                failedState.status = 'blocked';
                failedState.blocked_at = new Date().toISOString();
                failedState.blocked_step = err.blockedStep || 'plan';
                failedState.blocked_reason = err.blockedReason || err.message;
              } else {
                failedState.status = 'failed';
                failedState.failed_at = new Date().toISOString();
                failedState.failure_reason = err.message;
              }
              await this.savePipelineJson(ticket.id, failedState);
            }
          } catch { /* best-effort */ }
          // Step-level rollback (revertToBaseline) already ran inside
          // runStepWithHealing for any gate-failure path that throws here,
          // so the worktree is already clean. In worktree mode the next
          // ticket's prepareWorktreeForTicket also resets the side branch.
          // Per-ticket branches were removed in the 2026-04-28 refactor;
          // the orchestrator never leaves master in the primary checkout
          // (and the worktree, when enabled, is permanently pinned to its
          // side branch). No checkout-master cleanup needed here.
          if (this.stopRequested) {
            this.emit('ticket_stop_observed', { ticket: ticket.id, error: err.message });
            break;
          }
          this.emit('ticket_failed', { ticket: ticket.id, error: err.message });
          continue;
        }

        this.emit('ticket_done', { ticket: ticket.id });

        // Dry run: only plan step
        if (this.dryRun) continue;

        // Don't archive blocked or failed tickets — they need another pass.
        // Files stay on disk so the next retry can resume without re-writing
        // them; only `done` tickets are archived. (2026-04-26: previously only
        // `blocked` was gated, which meant a crashed-then-recovered ticket
        // whose pipelineState was left at status:'failed' got archived
        // without a squash-merge — visible on master as `archive T-X` with
        // no preceding T-X commit.)
        const finalState = await this.loadPipelineJson(ticket.id);
        if (finalState?.status === 'blocked') {
          this.emit('ticket_blocked_skip_archive', { ticket: ticket.id, step: finalState.blocked_step });
          continue;
        }
        if (finalState?.status === 'failed') {
          this.emit('ticket_failed_skip_archive', { ticket: ticket.id, reason: finalState.failure_reason || 'status=failed' });
          continue;
        }
        if (finalState?.status !== 'done') {
          // Anything else (in_progress, pending, missing) is also not
          // archive-ready. Belt-and-braces — only `done` ships.
          this.emit('ticket_not_archived', { ticket: ticket.id, status: finalState?.status || 'missing' });
          continue;
        }

        // PIPE-020: archive is gated on the ticket *landing on master*, not
        // on merely reaching status:done. The old order archived first and
        // then attempted the cherry-pick; a failed cherry-pick (CONFLICT,
        // DIRTY, WRONG_BRANCH, …) left the ticket archived as `done` with
        // the work stranded behind a pipeline/pending-merge-* tag and never
        // on master. The archive is the ledger the operator trusts, so
        // "done in the archive" MUST mean "shipped to master". This is the
        // same anti-mis-ship stance loadOrCreatePipelineJson takes: a not-
        // landed ticket stays in the backlog and re-runs rather than being
        // recorded as done.
        //
        // Two land paths:
        //   • worktree mode → cherry-pick the side-branch commit onto the
        //     operator's master here; archive only if it lands.
        //   • checkpoint/non-worktree mode → the commit was already made
        //     directly on master earlier in processTicket (no ticket_sha to
        //     cherry-pick), so reaching here already means landed — archive
        //     as before. A worktree ticket that produced no commit also
        //     falls here (nothing to ship).
        if (worktreeCtx && finalState?.checkpoint?.ticket_sha) {
          const sha = finalState.checkpoint.ticket_sha;
          const result = cherryPickToMaster(this.config.project_dir, sha, worktreeCtx.defaultBranch);
          // EMPTY = git found the patch already present on master (identical
          // content landed by another route). The change *is* shipped, so
          // this counts as landed; archiving prevents the un-archived
          // ticket from re-queuing forever to apply a no-op patch.
          const landed = result.ok || result.code === 'EMPTY';
          if (landed) {
            const masterSha = result.headSha || sha;
            this.emit('worktree_merged', { ticket: ticket.id, sha: masterSha, source: sha, empty: !result.ok });
            console.log(`[worktree] ${ticket.id}: ${result.ok
              ? `cherry-picked ${sha.slice(0, 7)} onto ${worktreeCtx.defaultBranch} (${masterSha.slice(0, 7)})`
              : `already present on ${worktreeCtx.defaultBranch} (empty cherry-pick) — treating as landed`}`);
            // Persist merge status so the dashboard / next run can see it.
            finalState.merge = { status: 'merged', at: new Date().toISOString(), source_sha: sha, master_sha: masterSha, empty: !result.ok };
            try { await this.savePipelineJson(ticket.id, finalState); } catch { /* best-effort */ }
            // Landed → safe to archive. Backlog files are gitignored so
            // this is a file-only operation that doesn't touch git history.
            // landedCommit threads the real master sha into the archive and
            // closed-bugs ledger so the audit can verify done == shipped.
            await archiveTicket(ticket.id, this.config, { landedCommit: masterSha });
          } else {
            // NOT landed. Do NOT archive — the ticket stays in the backlog
            // so it re-queues on the next run (loadOrCreatePipelineJson
            // resets the stale done-state) until it lands or the operator
            // resolves the conflict. Anchor the unmerged sha with a tag in
            // the primary repo (worktree shares object storage; the next
            // prepareWorktreeForTicket resets the side branch, which would
            // otherwise leave the commit reachable only via reflog). The
            // tag keeps it permanently resolvable for a manual cherry-pick.
            const tag = `pipeline/pending-merge-${ticket.id}`;
            try {
              execSync(`git tag -f ${tag} ${sha}`, { cwd: this.config.project_dir, encoding: 'utf-8', timeout: 10000 });
            } catch (tagErr) {
              console.error(`[worktree] ${ticket.id}: tag anchor failed — ${tagErr.message?.slice(0, 200)}`);
            }
            this.emit('pipeline_merge_pending', {
              ticket: ticket.id,
              sha,
              code: result.code,
              files: result.files,
              head: result.head,
              branch: worktreeCtx.branch,
              tag,
              archived: false,
              hint: `cd ${this.config.project_dir} && git cherry-pick ${tag}`,
            });
            console.error(`[worktree] ${ticket.id}: merge needs operator (code=${result.code}); NOT archived — will re-queue; commit ${sha.slice(0, 7)} anchored at tag ${tag}`);
            const attempts = (finalState.merge?.non_landing_attempts || 0) + 1;
            finalState.merge = { status: 'pending', at: new Date().toISOString(), source_sha: sha, code: result.code, files: result.files, tag, non_landing_attempts: attempts };
            try { await this.savePipelineJson(ticket.id, finalState); } catch { /* best-effort */ }
            await this.parkIfNonLandingExhausted(ticket, attempts, `cherry-pick keeps failing (code=${result.code}) after %N% attempts; tag ${tag}`);
            // Halt the batch (see comment near the for-loop). Capture context
            // for the surfaced event; the actual break happens after the
            // try/finally for worktree cleanup so we don't leak worktree state.
            mergeBlockedHalt = {
              ticket: ticket.id,
              code: result.code,
              files: result.files || [],
              head: result.head,
              tag,
              hint: `cd ${this.config.project_dir} && git status   # then clean/commit, then re-run`,
            };
          }
        } else {
          // Checkpoint/non-worktree path (or worktree ticket with no
          // checkpoint.ticket_sha). The OLD code archived unconditionally
          // on the assumption "the work, if any, is already on master."
          // That silently failed for T-018 (2026-05-18): its commit was
          // orphaned by the shared-worktree baseline reset + restart, so
          // ticket_sha was absent, this branch ran, and the ticket was
          // recorded `done` while the code never reached master — a
          // false-done (PIPE-021 invariant gap, PIPE-020 class). Gate the
          // archive on a positive landed signal whenever the ticket
          // actually produced code changes; otherwise re-queue rather
          // than mis-ship. Failure bias is recoverable (re-run) not lossy
          // (false done). "done in the archive" MUST mean shipped.
          const changedFiles = (finalState?.steps?.implement?.files_changed || []).length;
          let landed = changedFiles === 0; // no code change → nothing to ship → archivable
          if (!landed) {
            if (finalState?.merge?.status === 'merged') {
              landed = true;
            } else {
              const dir = this.config.project_dir;
              const br = worktreeCtx?.defaultBranch || 'HEAD';
              try {
                const hit = execSync(
                  `git -C "${dir}" log ${br} --grep="\\[${ticket.id}\\]" -1 --format=%H`,
                  { encoding: 'utf-8', timeout: 10000 },
                ).trim();
                landed = hit.length > 0;
              } catch {
                landed = false; // cannot prove it shipped → treat as not landed
              }
            }
          }
          if (landed) {
            await archiveTicket(ticket.id, this.config);
          } else {
            // Do NOT archive — keep the ticket actionable so it re-queues
            // and re-runs instead of being recorded as a false `done`.
            const branchName = worktreeCtx?.defaultBranch || 'master';
            this.emit('pipeline_merge_pending', {
              ticket: ticket.id, archived: false, code: 'NOT_ON_MASTER',
              hint: `ticket ${ticket.id} reached done but no commit on ${branchName}; re-queued (PIPE-021 invariant)`,
            });
            console.error(`[archive-gate] ${ticket.id}: implement changed ${changedFiles} file(s) but no landed commit on ${branchName}; NOT archived — will re-queue (PIPE-021 invariant)`);
            if (finalState) {
              const attempts = (finalState.merge?.non_landing_attempts || 0) + 1;
              finalState.merge = { status: 'pending', at: new Date().toISOString(), code: 'NOT_ON_MASTER', non_landing_attempts: attempts };
              try { await this.savePipelineJson(ticket.id, finalState); } catch { /* best-effort */ }
              await this.parkIfNonLandingExhausted(ticket, attempts, `produced no landed commit on ${branchName} after %N% attempts (NOT_ON_MASTER)`);
            }
            mergeBlockedHalt = {
              ticket: ticket.id,
              code: 'NOT_ON_MASTER',
              hint: `ticket ${ticket.id} reached done but no commit on ${branchName}; inspect worktree and re-run`,
            };
          }
        }

        // Pause between tickets if requested
        if (this.pause && i < queue.length - 1) {
          this.emit('paused', { next: queue[i + 1]?.id });
          // In a real implementation, this would wait for user input via the UI
          console.log(`Paused. Next ticket: ${queue[i + 1]?.id}. Press enter to continue...`);
          await new Promise((resolve) => process.stdin.once('data', resolve));
        }
        } finally {
          // Worktree state must be cleared at end of every iteration,
          // including paths that `continue` (blocked / failed / not
          // done). try/finally enforces this mechanically — a future
          // contributor adding a continue won't accidentally leak.
          this.activeWorktree = null;
          this.worktreeBranch = null;
        }

        // PIPE-019: clean ticket boundary reached. If the operator armed a
        // graceful restart, stop pulling new tickets now — the just-finished
        // ticket is already archived/cherry-picked. The outer finally exits
        // the process so the supervisor relaunches on fresh code.
        if (this.restartRequested) {
          this._restartAfterRun = true;
          this.emit('pipeline_restart_observed', {
            completed: ticket.id,
            remaining: queue.length - i - 1,
          });
          break;
        }

        // First-DIRTY halt. The merge gate above set this flag when the
        // ticket couldn't land on master (dirty tree / conflict / wrong
        // branch / no commit). Every subsequent ticket in the batch would
        // hit the same wall — bail out and surface the precondition to the
        // operator so they can fix master before more work piles up.
        if (mergeBlockedHalt) {
          this.emit('pipeline_halted_merge_blocked', {
            ...mergeBlockedHalt,
            remaining: queue.length - i - 1,
            queued: queue.slice(i + 1).map((t) => t.id),
          });
          console.error(
            `[pipeline] HALTED after ${mergeBlockedHalt.ticket}: merge refused (code=${mergeBlockedHalt.code}). ` +
            `${queue.length - i - 1} ticket(s) skipped to avoid pile-up. ${mergeBlockedHalt.hint}`,
          );
          break;
        }
      }

      // Phase 3-5: Integration tests, docs, build
      this.emit('pipeline_complete', { ticketsProcessed: queue.length });
    } finally {
      await this.releaseLock();
      this.stopUsageMonitor();
      // PIPE-019: lock released + usage monitor stopped → safe to hand
      // control back to the supervisor for a fresh-code relaunch. The
      // queue resumes automatically (done tickets skipped via state).
      if (this._restartAfterRun) {
        this.emit('pipeline_restarting', { exitCode: RESTART_EXIT_CODE });
        // Give the SSE flush a tick so the dashboard sees the event.
        setTimeout(() => process.exit(RESTART_EXIT_CODE), 250);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Soft pipeline dispatcher (3-spawn architecture).
  //
  // Triggered when this.config.pipeline_mode === 'soft'. Branches off
  // run()'s for-loop instead of calling the classic processTicket.
  //
  // Phases (per prompts/worker.md):
  //   Spawn 1 (worker): plan → tests_red → implement → tests_green
  //                     → docs_update (if feature)
  //   Spawn 2 (reviewer): adversarial diff review → review.json
  //   Spawn 3 (worker-apply): apply_review_feedback → root_cause (if bug)
  //
  // Between spawns the orchestrator runs phase verification against
  // checkpoint files and the worktree. Static plan check runs after
  // spawn 1's plan phase completes. After spawn 3 the orchestrator
  // commits + cherry-picks + archives (same machinery as classic).
  // ──────────────────────────────────────────────────────────────────────
  async processTicketSoft(ticket, worktreeCtx) {
    const { verifyCheckpoint, determineResumePoint, buildResumePrompt, SOFT_PHASE_ORDER } = await import('./phase-verify.js');
    const { readFile: rfile, writeFile: wfile, readdir: rdir } = await import('node:fs/promises');
    const { existsSync: exist } = await import('node:fs');
    const path = await import('node:path');

    let pipelineState = await this.loadOrCreatePipelineJson(ticket);
    const ticketStartTime = Date.now();
    // Detect "fresh start" vs "genuine resume". A genuine resume is when the
    // pipeline-state's pipeline_mode is already 'soft' AND status was
    // 'in_progress' AND started_at is recent (within last hour) — i.e. the
    // server restarted mid-soft-run and we're resuming via checkpoints.
    // Anything else (no prior state, classic-mode state, blocked from prior
    // run, ancient started_at) is a FRESH start; stale worker-output from a
    // different pipeline mode would create false divergences in phase
    // verification (see T-029 incident 2026-05-20).
    const priorStartIso = pipelineState.started_at;
    const priorMode = pipelineState.pipeline_mode;
    const priorStatus = pipelineState.status;
    const oneHourMs = 3600 * 1000;
    const isGenuineResume = priorMode === 'soft'
      && priorStatus === 'in_progress'
      && priorStartIso
      && (Date.now() - new Date(priorStartIso).getTime() < oneHourMs);

    const workerOutDir = path.resolve(this.config._resolved.workerOutputDir, ticket.id);

    if (!isGenuineResume) {
      // Move any stale worker-output aside (forensic record) and start fresh.
      const { existsSync: existS2 } = await import('node:fs');
      const fsP = await import('node:fs/promises');
      if (existS2(workerOutDir)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const aside = `${workerOutDir}.stale-${stamp}`;
        try {
          await fsP.rename(workerOutDir, aside);
          this.emit('soft_stale_archived', { ticket: ticket.id, archived_to: aside });
          console.log(`[soft] ${ticket.id}: stale worker-output archived → ${aside}`);
        } catch (err) {
          console.warn(`[soft] ${ticket.id}: stale archive failed (${err.message}) — continuing`);
        }
      }
      // Reset pipeline-state to a clean fresh-start shape.
      pipelineState = {
        ...pipelineState,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        completed_at: null,
        pipeline_mode: 'soft',
        steps: {},
        blocked_reason: undefined,
        blocked_step: undefined,
        blocked_at: undefined,
      };
      console.log(`[soft] ${ticket.id}: fresh start (prior_mode=${priorMode || 'none'}, prior_status=${priorStatus || 'none'})`);
    } else {
      // Genuine resume — keep existing checkpoints and state; just refresh status.
      pipelineState.status = 'in_progress';
      pipelineState.pipeline_mode = 'soft';
      // Strip legacy step keys, keep only soft ones.
      const SOFT_STEP_KEYS = new Set(['worker', 'reviewer', 'worker-apply']);
      const cleanedSteps = {};
      for (const [k, v] of Object.entries(pipelineState.steps || {})) {
        if (SOFT_STEP_KEYS.has(k)) cleanedSteps[k] = v;
      }
      pipelineState.steps = cleanedSteps;
      console.log(`[soft] ${ticket.id}: resuming from in-flight soft run`);
    }
    await this.savePipelineJson(ticket.id, pipelineState);
    await (await import('node:fs/promises')).mkdir(workerOutDir, { recursive: true });

    const worktree = this.cwd; // soft mode runs in the worktree like classic
    const ticketCtx = { id: ticket.id, type: ticket.type, title: ticket.title };

    this.emit('soft_ticket_start', { ticket: ticket.id });
    console.log(`[soft] ${ticket.id}: starting 3-spawn dispatch`);

    // ─────────────── SPAWN 1: worker (plan → tests_green) ───────────────
    const resumeBefore = determineResumePoint({
      ticketDir: workerOutDir, worktree, ticket: ticketCtx,
      phases: ['plan', 'tests_red', 'implement', 'tests_green', 'docs_update'],
    });
    if (resumeBefore.requiresOperator) {
      pipelineState.status = 'blocked';
      pipelineState.blocked_reason = `soft pipeline resume divergence: ${JSON.stringify(resumeBefore.divergences)}`;
      pipelineState.blocked_at = new Date().toISOString();
      await this.savePipelineJson(ticket.id, pipelineState);
      this.emit('soft_resume_halted', { ticket: ticket.id, divergences: resumeBefore.divergences });
      console.error(`[soft] ${ticket.id}: resume requires operator review — divergence in ${resumeBefore.divergences.map(d => d.phase).join(', ')}`);
      return;
    }
    if (resumeBefore.resumeFrom !== null) {
      const workerPrompt = await this._renderPromptTemplate('worker.md', {
        TICKET_ID: ticket.id,
        TICKET_SPEC: JSON.stringify(ticket, null, 2),
        WORKTREE_DIR: worktree,
        WORKER_OUTPUT_DIR: workerOutDir,
        VALIDATION_RULES: this.config._resolved.validationRules || '(none configured)',
        RESUME_INFO: buildResumePrompt({ completed: resumeBefore.completed, resumeFrom: resumeBefore.resumeFrom, ticketDir: workerOutDir }),
      });
      this.emit('soft_spawn_start', { ticket: ticket.id, spawn: 'worker', resumeFrom: resumeBefore.resumeFrom });
      console.log(`[soft] ${ticket.id}: spawn 1 (worker) → resume from ${resumeBefore.resumeFrom}`);
      const result = await this._runSoftSpawn({
        spawnName: 'worker',
        prompt: workerPrompt,
        model: 'opus',
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
        ticket,
        workerOutDir,
        terminalMarker: 'worker_ready_for_review',
      });
      if (result.error) {
        pipelineState.status = 'failed';
        pipelineState.blocked_reason = `worker spawn failed: ${result.error}`;
        await this.savePipelineJson(ticket.id, pipelineState);
        return;
      }
    } else {
      console.log(`[soft] ${ticket.id}: worker phases already complete on disk — skipping spawn 1`);
    }

    // Static plan check (runs once after plan.json exists).
    try {
      const planPath = path.resolve(workerOutDir, 'plan.json');
      if (exist(planPath)) {
        const planRaw = await rfile(planPath, 'utf-8');
        const plan = JSON.parse(planRaw);
        const { execSync } = await import('node:child_process');
        const verdict = JSON.parse(execSync(
          `node ${path.resolve(this.config._resolved.pipelineDir || '.', '..', '..', 'scripts', 'plan-static-check.js')} ${JSON.stringify(planPath)} --title ${JSON.stringify(ticket.title || '')}`,
          { encoding: 'utf-8' },
        ));
        plan.static_check_verdict = { ...verdict, checked_at: new Date().toISOString() };
        await wfile(planPath, JSON.stringify(plan, null, 2));
        this.emit('soft_plan_static_check', { ticket: ticket.id, verdict: verdict.verdict, checks: verdict.checks });
        console.log(`[soft] ${ticket.id}: plan static check → ${verdict.verdict} (${verdict.checks.length} signals)`);
        if (verdict.verdict === 'reject') {
          pipelineState.status = 'blocked';
          pipelineState.blocked_reason = `plan-static-check verdict=reject: ${verdict.checks.filter(c => c.level === 'reject').map(c => c.id + ' ' + c.msg).join(' | ')}`;
          pipelineState.blocked_at = new Date().toISOString();
          await this.savePipelineJson(ticket.id, pipelineState);
          this.emit('soft_plan_rejected', { ticket: ticket.id, checks: verdict.checks });
          console.error(`[soft] ${ticket.id}: PLAN REJECTED — operator review required`);
          return;
        }
      }
    } catch (err) {
      console.warn(`[soft] ${ticket.id}: plan static check skipped — ${err.message}`);
    }

    // Verify all worker phases landed.
    const workerCheck = determineResumePoint({
      ticketDir: workerOutDir, worktree, ticket: ticketCtx,
      phases: ['plan', 'tests_red', 'implement', 'tests_green', 'docs_update'],
    });
    if (workerCheck.resumeFrom !== null || workerCheck.requiresOperator) {
      pipelineState.status = 'failed';
      pipelineState.blocked_reason = `worker did not complete all phases (stuck at ${workerCheck.resumeFrom || 'divergence'})`;
      await this.savePipelineJson(ticket.id, pipelineState);
      this.emit('soft_worker_incomplete', { ticket: ticket.id, ...workerCheck });
      return;
    }
    console.log(`[soft] ${ticket.id}: worker phases verified (${workerCheck.completed.length} done)`);

    // ─────────────── SPAWN 2: reviewer ───────────────
    // Capture the diff for the reviewer.
    const { execSync: exec2 } = await import('node:child_process');
    let diff = '';
    let baselineSha = '';
    try {
      exec2('git add -N .', { cwd: worktree, encoding: 'utf-8' });
      diff = exec2('git diff HEAD', { cwd: worktree, encoding: 'utf-8' });
      exec2('git reset', { cwd: worktree, encoding: 'utf-8' }); // undo intent-to-add
      baselineSha = exec2('git rev-parse HEAD', { cwd: worktree, encoding: 'utf-8' }).trim();
    } catch (err) {
      console.warn(`[soft] ${ticket.id}: diff capture failed — ${err.message}`);
    }

    const reviewerPrompt = await this._renderPromptTemplate('reviewer.md', {
      TICKET_SPEC: JSON.stringify(ticket, null, 2),
      PLAN_JSON: exist(path.resolve(workerOutDir, 'plan.json')) ? await rfile(path.resolve(workerOutDir, 'plan.json'), 'utf-8') : '{}',
      DIFF: diff || '(diff capture failed — work in worktree only)',
      BASELINE_SHA: baselineSha,
      DIFF_CLASSIFICATION: '(classifier not yet wired — treat as code_behavioural)',
      WORKER_OUTPUT_DIR: workerOutDir,
      CODE_VALIDATION: loadCodeValidationRubric(worktree),
    });
    this.emit('soft_spawn_start', { ticket: ticket.id, spawn: 'reviewer' });
    console.log(`[soft] ${ticket.id}: spawn 2 (reviewer)`);
    const reviewResult = await this._runSoftSpawn({
      spawnName: 'reviewer',
      prompt: reviewerPrompt,
      model: 'opus',
      tools: ['Read', 'Grep', 'Glob', 'Write'],
      ticket,
      workerOutDir,
      retryOnce: true, // single retry on malformed/missing review.json
    });

    // T-053: gate on the review. A review that could not be validated, or a
    // 'blocked' verdict, must NOT ship — previously the pipeline synthesised
    // `verdict: clean` here and shipped unreviewed code.
    const reviewVerify = verifyCheckpoint({ ticketDir: workerOutDir, phase: 'review', worktree, ticket: ticketCtx });
    const reviewGate = decideReviewGate(reviewVerify);
    if (reviewGate.block) {
      console.warn(`[soft] ${ticket.id}: review gate BLOCK — ${reviewGate.reason}`);
      pipelineState.status = 'blocked';
      pipelineState.blocked_at = new Date().toISOString();
      pipelineState.blocked_step = 'review';
      pipelineState.blocked_reason = reviewGate.reason;
      await this.savePipelineJson(ticket.id, pipelineState);
      this.emit('soft_review_blocked', { ticket: ticket.id, reason: reviewGate.reason });
      try { cleanupBaseline(ticket.id, this.cwd); } catch {}
      return;
    }
    console.log(`[soft] ${ticket.id}: review verdict=${reviewVerify.payload.verdict}, findings=${reviewVerify.payload.findings.length}`);

    // ─────────────── SPAWN 3: worker-apply ───────────────
    const applyResume = determineResumePoint({
      ticketDir: workerOutDir, worktree, ticket: ticketCtx,
      phases: ['apply_review_feedback', 'root_cause'],
    });
    if (applyResume.resumeFrom !== null) {
      const applyPrompt = await this._renderPromptTemplate('worker-apply.md', {
        TICKET_ID: ticket.id,
        TICKET_SPEC: JSON.stringify(ticket, null, 2),
        WORKTREE_DIR: worktree,
        WORKER_OUTPUT_DIR: workerOutDir,
      });
      this.emit('soft_spawn_start', { ticket: ticket.id, spawn: 'worker-apply' });
      console.log(`[soft] ${ticket.id}: spawn 3 (worker-apply) → resume from ${applyResume.resumeFrom}`);
      const applyResult = await this._runSoftSpawn({
        spawnName: 'worker-apply',
        prompt: applyPrompt,
        model: 'opus',
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
        ticket,
        workerOutDir,
        terminalMarker: 'worker_apply_done',
      });
      if (applyResult.error) {
        pipelineState.status = 'failed';
        pipelineState.blocked_reason = `worker-apply spawn failed: ${applyResult.error}`;
        await this.savePipelineJson(ticket.id, pipelineState);
        return;
      }
    }

    // ─────────────── COMMIT + ARCHIVE ───────────────
    pipelineState.status = 'done';
    pipelineState.completed_at = new Date().toISOString();
    pipelineState.duration_ms = Date.now() - ticketStartTime;
    await this.savePipelineJson(ticket.id, pipelineState);

    // Reuse the classic checkpoint commit machinery — it's idempotent and
    // the soft pipeline ends in the same "uncommitted worktree" state the
    // classic flow does. The commit happens in run()'s post-processTicket
    // logic at the worktree-merge step (line ~415), so we don't commit here.
    // Instead we let processTicket's commit block run by setting pipelineState
    // status correctly and letting the run-loop's commit/cherry-pick handle it.
    //
    // BUT: the classic commit block (line 1541 region) is INSIDE processTicket.
    // For soft mode we replicate the inline commit logic here.
    if (this.config.checkpoints?.enabled) {
      try {
        const ticketSha = commitTicketAsOne(ticket.id, ticket.title || '', this.cwd);
        if (ticketSha) {
          this.emit('ticket_committed', { ticket: ticket.id, sha: ticketSha });
          console.log(`[soft] ${ticket.id}: committed (${ticketSha.slice(0, 7)})`);
          // Cleanup transient tests_green attempt logs only.
          try {
            for (const f of (await rdir(workerOutDir))) {
              if (/^tests_green-.+-attempt\d+\.log$/.test(f)) {
                const { unlinkSync: unlinkS } = await import('node:fs');
                unlinkS(path.resolve(workerOutDir, f));
              }
            }
          } catch (err) {
            console.warn(`[soft] ${ticket.id}: log cleanup failed — ${err.message}`);
          }
          pipelineState.checkpoint = pipelineState.checkpoint || {};
          pipelineState.checkpoint.ticket_sha = ticketSha;
          pipelineState.checkpoint.committed_at = new Date().toISOString();
          await this.savePipelineJson(ticket.id, pipelineState);
        } else {
          pipelineState.status = 'blocked';
          pipelineState.blocked_at = new Date().toISOString();
          pipelineState.blocked_step = 'commit';
          pipelineState.blocked_reason = 'soft pipeline produced no diff — likely worker no-op';
          await this.savePipelineJson(ticket.id, pipelineState);
          this.emit('ticket_committed_empty', { ticket: ticket.id, reason: pipelineState.blocked_reason });
          try { cleanupBaseline(ticket.id, this.cwd); } catch {}
          return;
        }
      } catch (err) {
        console.error(`[soft] ${ticket.id}: commit FAILED — ${err.message}`);
        this.emit('ticket_commit_failed', { ticket: ticket.id, error: err.message });
        return;
      }

      try { cleanupBaseline(ticket.id, this.cwd); } catch (err) {
        console.warn(`[soft] ${ticket.id}: baseline cleanup failed — ${err.message}`);
      }
    }

    this.emit('soft_ticket_done', { ticket: ticket.id, duration_ms: pipelineState.duration_ms });
    console.log(`[soft] ${ticket.id}: complete (${Math.round(pipelineState.duration_ms / 60000)}m)`);
  }

  // Render a prompt template with {{KEY}} substitution.
  async _renderPromptTemplate(templateName, vars) {
    const { readFile: rf } = await import('node:fs/promises');
    const path = await import('node:path');
    const tmplPath = path.resolve(import.meta.dirname || '.', '..', 'prompts', templateName);
    let tmpl = await rf(tmplPath, 'utf-8');
    for (const [k, v] of Object.entries(vars)) {
      tmpl = tmpl.split(`{{${k}}}`).join(typeof v === 'string' ? v : JSON.stringify(v));
    }
    return tmpl;
  }

  // Spawn a Claude session for a soft-pipeline phase. Wraps spawnClaude with
  // phase-marker parsing + per-assistant-turn token accumulation + rate-limit
  // retry + terminal-marker timeout (defends against Claude CLI hang-after-
  // finish — see T-029 incident 2026-05-20).
  //
  // Returns {error|result, wallMs, inputTokens, outputTokens, cachedTokens}.
  async _runSoftSpawn({ spawnName, prompt, model, tools, ticket, workerOutDir, retryOnce = false, terminalMarker = null, terminalGraceMs = 60_000, hardCapMs = null }) {
    const startedAt = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let toolCalls = 0;
    let terminalMarkerSeenAt = null;
    let killTimer = null;
    // Absolute wall-clock cap. Unlike killTimer/killHungChild — which only arms
    // AFTER the terminal marker (catches hang-after-finish) — this fires no
    // matter what, so it catches a spawn that hangs MID-execution and never
    // reaches its marker (T-048: worker blocked in a Bash poll loop for hours).
    // It is the catch-all for improvisations we didn't anticipate. Configurable
    // via soft_spawn_hard_cap_min (default 45 min; longest legit worker ~half).
    const effectiveHardCapMs = hardCapMs
      || ((this.config.soft_spawn_hard_cap_min || 45) * 60_000);
    let hardCapped = false;
    let hardCapTimer = null;
    // The REAL claude child PID, captured from spawnClaude's onSpawn callback
    // (wired below). Both killers target THIS pid and its descendant tree.
    // The old approach — `pgrep -P <node> -f 'claude -p'` — found 0 procs
    // because the claude process is NOT a direct child of the node server,
    // which let T-062's reviewer run ~4h past the hard cap. proc.pid is
    // authoritative; no guessing.
    let knownChildPid = null;

    // Kill the worker process AND its whole descendant tree (so a wedged
    // `find /` or poll loop is not orphaned), leaves-first, with `signal`.
    // Returns the count of processes signalled.
    const killWorkerTree = (signal) => {
      if (!knownChildPid) {
        console.warn(`[soft] ${ticket.id}/${spawnName}: no child pid captured — cannot ${signal} the worker`);
        return 0;
      }
      try {
        const { execSync: ex } = require('node:child_process');
        const childrenOf = new Map();
        for (const line of ex('ps -eo pid=,ppid=', { encoding: 'utf-8' }).trim().split('\n')) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
          childrenOf.get(ppid).push(pid);
        }
        const ordered = [];
        const seen = new Set();
        const visit = (pid) => { if (seen.has(pid)) return; seen.add(pid); for (const c of (childrenOf.get(pid) || [])) visit(c); ordered.push(pid); };
        visit(knownChildPid);
        for (const pid of ordered) { try { process.kill(pid, signal); } catch {} }
        return ordered.length;
      } catch (err) {
        // Last resort: signal just the tracked pid directly.
        try { process.kill(knownChildPid, signal); return 1; } catch { return 0; }
      }
    };

    const killHungChild = () => {
      // The CLI subprocess didn't exit within terminalGraceMs after emitting
      // the terminal marker. Work is done (checkpoints on disk) — SIGTERM the
      // tree so spawnClaude's promise resolves and the dispatcher proceeds.
      const n = killWorkerTree('SIGTERM');
      console.log(`[soft] ${ticket.id}/${spawnName}: terminal marker '${terminalMarker}' seen but CLI didn't exit in ${terminalGraceMs}ms — SIGTERM'd ${n} proc(s)`);
      this.emit('soft_terminal_marker_timeout', { ticket: ticket.id, spawn: spawnName, marker: terminalMarker, killed: n });
    };

    hardCapTimer = setTimeout(() => {
      hardCapped = true;
      const n = killWorkerTree('SIGKILL');
      console.error(`[soft] ${ticket.id}/${spawnName}: HARD CAP ${Math.round(effectiveHardCapMs / 60_000)}min exceeded — SIGKILL'd ${n} proc(s); spawn hung mid-execution`);
      this.emit('soft_spawn_hard_capped', { ticket: ticket.id, spawn: spawnName, capMs: effectiveHardCapMs, killedCount: n });
    }, effectiveHardCapMs);

    const dataHandler = (event) => {
      // Phase markers (advisory; orchestrator verifies state separately).
      // Watch for the spawn's terminal marker — once seen, start a kill
      // timer in case Claude CLI hangs after final assistant message.
      if (event?.text && /<<<PHASE:\s*([a-z_]+)\s*>>>/.test(event.text)) {
        const m = event.text.match(/<<<PHASE:\s*([a-z_]+)\s*>>>/);
        if (m) {
          this.emit('soft_phase_marker', { ticket: ticket.id, spawn: spawnName, marker: m[1], at: new Date().toISOString() });
          if (terminalMarker && m[1] === terminalMarker && !terminalMarkerSeenAt) {
            terminalMarkerSeenAt = Date.now();
            console.log(`[soft] ${ticket.id}/${spawnName}: terminal marker '${terminalMarker}' seen — ${terminalGraceMs}ms grace before forced exit`);
            killTimer = setTimeout(killHungChild, terminalGraceMs);
          }
        }
      }
      // Token accounting: the runner's parsed JSON-stream emits assistant
      // events with usage in event.message.usage. Accumulate across turns.
      const u = event?.message?.usage;
      if (u) {
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cachedTokens += u.cache_read_input_tokens || 0;
      }
      // Tool-use count
      if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type === 'tool_use') toolCalls += 1;
        }
      }
      this.emit('claude_event', { ticket: ticket.id, step: spawnName, event });
    };

    try {
      const result = await this.runWithRateLimitRetry(
        () => spawnClaude({
          prompt, model, tools, maxTurns: 200, workingDir: this.cwd, sessionId: null,
          env: this.config.environment || {},
          onData: dataHandler,
          onSpawn: (proc) => { knownChildPid = proc.pid; },
        }),
        ticket.id,
        spawnName,
      );
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = null; }
      const wallMs = Date.now() - startedAt;
      const metrics = { model, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls, startedAt: new Date(startedAt).toISOString(), terminalMarkerSeenAt: terminalMarkerSeenAt ? new Date(terminalMarkerSeenAt).toISOString() : null };
      this.emit('soft_spawn_done', { ticket: ticket.id, spawn: spawnName, ...metrics });
      // Persist metrics into the ticket's pipeline-state so the dashboard
      // aggregator picks them up. The legacy step keys (plan, tests_red, …)
      // are overwritten by the soft-mode step keys (worker, reviewer,
      // worker_apply). The dashboard iterates Object.values(steps) and
      // sums metrics — soft and classic both contribute to the same totals.
      try {
        const ps = await this.loadPipelineJson(ticket.id);
        if (ps) {
          ps.steps = ps.steps || {};
          ps.steps[spawnName] = {
            status: 'done',
            completed_at: new Date().toISOString(),
            metrics,
          };
          await this.savePipelineJson(ticket.id, ps);
        }
      } catch (err) {
        console.warn(`[soft] ${ticket.id}/${spawnName}: metrics persist failed — ${err.message}`);
      }
      return { result, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls };
    } catch (err) {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = null; }
      // If the terminal marker was seen, the subprocess exit was the
      // expected outcome (we may have SIGTERM'd it ourselves). Treat as
      // success — the work is done, checkpoints are on disk.
      if (terminalMarkerSeenAt) {
        const wallMs = Date.now() - startedAt;
        const metrics = { model, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls, startedAt: new Date(startedAt).toISOString(), terminalMarkerSeenAt: new Date(terminalMarkerSeenAt).toISOString(), exited_via: 'terminal_marker_timeout' };
        this.emit('soft_spawn_done', { ticket: ticket.id, spawn: spawnName, ...metrics });
        try {
          const ps = await this.loadPipelineJson(ticket.id);
          if (ps) {
            ps.steps = ps.steps || {};
            ps.steps[spawnName] = { status: 'done', completed_at: new Date().toISOString(), metrics };
            await this.savePipelineJson(ticket.id, ps);
          }
        } catch {}
        console.log(`[soft] ${ticket.id}/${spawnName}: subprocess exit after terminal marker — treating as success`);
        return { result: null, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls, terminalExit: true };
      }
      // Hard cap fired and no terminal marker was ever seen → genuine hang.
      // Fail loudly (do NOT retry — a hang re-hangs); the dispatcher records
      // blocked_reason and the queue moves on instead of freezing.
      if (hardCapped) {
        const wallMs = Date.now() - startedAt;
        const capMin = Math.round(effectiveHardCapMs / 60_000);
        const metrics = { model, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls, startedAt: new Date(startedAt).toISOString(), hard_capped: true };
        this.emit('soft_spawn_done', { ticket: ticket.id, spawn: spawnName, ...metrics });
        try {
          const ps = await this.loadPipelineJson(ticket.id);
          if (ps) {
            ps.steps = ps.steps || {};
            ps.steps[spawnName] = { status: 'failed', completed_at: new Date().toISOString(), metrics };
            await this.savePipelineJson(ticket.id, ps);
          }
        } catch {}
        return { error: `spawn '${spawnName}' exceeded the ${capMin}min wall-clock cap and was killed — no terminal marker seen, treated as a hang`, wallMs, inputTokens, outputTokens, hardCapped: true };
      }
      if (err.rateLimited) throw err;
      if (retryOnce) {
        console.warn(`[soft] ${ticket.id}/${spawnName}: first attempt failed (${err.message}) — retrying once`);
        try {
          const result = await this.runWithRateLimitRetry(
            () => spawnClaude({
              prompt, model, tools, maxTurns: 200, workingDir: this.cwd, sessionId: null,
              env: this.config.environment || {},
              onData: dataHandler,
            }),
            ticket.id, spawnName + '_retry',
          );
          const wallMs = Date.now() - startedAt;
          const metrics = { model, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls, startedAt: new Date(startedAt).toISOString(), retried: true };
          try {
            const ps = await this.loadPipelineJson(ticket.id);
            if (ps) {
              ps.steps = ps.steps || {};
              ps.steps[spawnName] = { status: 'done', completed_at: new Date().toISOString(), metrics };
              await this.savePipelineJson(ticket.id, ps);
            }
          } catch {}
          return { result, wallMs, inputTokens, outputTokens, cachedTokens, toolCalls };
        } catch (err2) {
          return { error: err2.message, wallMs: Date.now() - startedAt, inputTokens, outputTokens };
        }
      }
      return { error: err.message, wallMs: Date.now() - startedAt, inputTokens, outputTokens };
    }
  }

  async processTicket(ticket) {
    const MAX_BLOCKED_ATTEMPTS = 3;
    const steps = this.config.steps;
    let pipelineState = await this.loadOrCreatePipelineJson(ticket);
    const ticketStartTime = Date.now();

    // F5 (audit 2026-04-26): stamp a per-run UUID so we can tell crash-
    // recovery (steps from a prior run, run_id different) from forgery
    // (claims to be from this run but no orchestrator activity recorded).
    // Saved under runs[].run_id; this run's id is exposed as `currentRunId`.
    const currentRunId = randomUUID();
    pipelineState.runs = pipelineState.runs || [];
    pipelineState.runs.push({
      run_id: currentRunId,
      started_at: new Date().toISOString(),
      ticket: ticket.id,
    });
    pipelineState.current_run_id = currentRunId;

    // Architectural fix 2026-04-27: ensure the per-ticket worker output
    // directory exists. Each step's worker writes a flat JSON object here
    // ({worker_output_dir}/{ticket}/{step}.json) instead of the canonical
    // pipeline state file. Orchestrator's ingestWorkerOutput validates
    // and merges only schema-allowed fields.
    try {
      await mkdir(resolve(this.config._resolved.workerOutputDir, ticket.id), { recursive: true });
    } catch { /* non-fatal — falls back to old behaviour where worker writes nothing */ }
    const stepMetrics = [];
    // Steps whose worker actually ran (or whose orchestrator-driven body
    // executed) in THIS run. Distinct from `pipelineState.steps[X].status`
    // which a misbehaving worker can write directly. Used at squash-merge
    // time to refuse "ship" when a step claims done but never executed.
    const executedThisRun = new Set();

    // Stale-failed reset: if a prior run crashed in post-loop bookkeeping,
    // the catch block set status='failed' on disk. A fresh attempt loaded
    // that state and got stuck routing through preserve-blocked, never
    // entering the success path → no merge. Reset to in_progress so the
    // current run can complete cleanly. Step statuses stay (they correctly
    // reflect prior progress and let the loop skip already-done work).
    if (pipelineState.status === 'failed') {
      console.log(`[stale-failed-reset] ${ticket.id}: clearing status=failed from prior run (failure_reason=${(pipelineState.failure_reason || '').slice(0, 100)}…)`);
      pipelineState.status = 'in_progress';
      pipelineState.failure_reason = null;
      pipelineState.failed_at = null;
      await this.savePipelineJson(ticket.id, pipelineState);
    }

    // Blocked-retry escalation: a ticket that keeps getting blocked on the
    // same step consumes LLM budget forever. After N attempts we escalate
    // to `failed`, which triggers rollback in run()'s catch block so its
    // abandoned files don't poison future tickets.
    if (pipelineState.status === 'blocked') {
      const attempts = (pipelineState.blocked_attempts || 0) + 1;
      if (attempts >= MAX_BLOCKED_ATTEMPTS) {
        pipelineState.status = 'failed';
        pipelineState.blocked_attempts = attempts;
        pipelineState.failed_at = new Date().toISOString();
        pipelineState.failure_reason = `Blocked ${attempts} times — escalated to failed`;
        await this.savePipelineJson(ticket.id, pipelineState);
        this.emit('ticket_blocked_escalated', { ticket: ticket.id, attempts });
        console.log(`[blocked-escalate] ${ticket.id}: ${attempts} attempts — escalating to failed`);
        throw new Error(pipelineState.failure_reason);
      }
      pipelineState.blocked_attempts = attempts;
      pipelineState.status = 'in_progress';
      await this.savePipelineJson(ticket.id, pipelineState);
      console.log(`[blocked-retry] ${ticket.id}: attempt ${attempts}/${MAX_BLOCKED_ATTEMPTS}`);
    }

    // Start usage monitoring
    this.startUsageMonitor();

    // META-001 Phase 3: per-ticket git branch + step snapshots. Opt-in via
    // `checkpoints.enabled: true` in pipeline.config.yaml. When disabled (the
    // default during rollout), the legacy same-branch flow is preserved.
    if (!this.dryRun && this.config.checkpoints?.enabled) {
      // Absorb any pre-existing dirty edits to pipeline-managed ledgers
      // (the human session's "I added a ticket to the backlog" workflow)
      // by committing them on master *before* the ticket branch is created.
      // Without this, DIRTY_TREE refuses and the operator has to commit
      // by hand each time. Code dirties still trigger DIRTY_TREE — those
      // are likely WIP and shouldn't be folded into pipeline history.
      // 2026-04-28: backlog files (backlog.json, backlog-v2.json,
      // backlog-archive.json, closed-bugs.json) and memory/build-log/ are
      // now gitignored in the project — they no longer enter git's view, so
      // there's nothing to absorb. autoCommitPaths is left exported for any
      // future per-project ledger that genuinely lives in git, but the
      // default run path doesn't call it anymore.

      try {
        // PIPE-026: absorb declared pinned context_files (relative to repo
        // root = cwd) so an untracked pinned doc doesn't DIRTY_TREE-freeze
        // the queue. Genuine code WIP still hard-blocks inside setup.
        const absorb = this.config.context_files || [];
        const res = setupTicketBaseline(ticket.id, this.cwd, absorb);
        this.emit('checkpoint_baseline_set', { ticket: ticket.id, baselineTag: res.baselineTag, baselineSha: res.baselineSha });
        console.log(`[checkpoint] ${ticket.id}: baseline ${res.baselineTag} at ${res.baselineSha.slice(0, 7)}`);
      } catch (err) {
        if (err instanceof CheckpointError) {
          // DIRTY_TREE is operator error, not pipeline failure — surface
          // clearly and refuse to start so we don't smash their WIP.
          this.emit('checkpoint_refused', { ticket: ticket.id, reason: err.message });
          console.error(`[checkpoint] ${ticket.id}: REFUSED — ${err.message}`);
          throw err;
        }
        throw err;
      }
    }

    // Capture test-suite baseline before any work on this ticket. Skipped on
    // crash recovery (already captured) and in dry-run (plan only). This is
    // what prevents this ticket from being blamed for red tests left behind
    // by earlier tickets whose implement step never finished.
    if (!this.dryRun) {
      try {
        await this.captureBaseline(ticket, pipelineState);
      } catch (err) {
        console.error(`[baseline] capture failed for ${ticket.id}: ${err.message}. Continuing without baseline — tests_green may flag preexisting failures as new.`);
        this.emit('baseline_capture_failed', { ticket: ticket.id, error: err.message });
      }
    }

    // Phase 5B: ticket-level restart counter. When runStepWithHealing
    // throws (heal exhausted), we may walk `i` back by one step and
    // re-run from the prior step — prior output may have been too weak
    // for the failing step to make progress. Capped at max_restarts.
    let restartCount = 0;
    const restartEnabled = !!this.config.restart?.enabled;
    const maxRestarts = this.config.restart?.max_restarts ?? 1;

    for (let i = 0; i < steps.length; i++) {
      const stepConfig = steps[i];
      // PIPE-014: respect operator Stop between steps. Without this,
      // killing the active subprocess only halted the step in flight —
      // the supervisor then advanced to the next step (T-038: plan
      // killed by Stop, then tests_red and implement still ran).
      if (this.stopRequested) {
        pipelineState.status = 'blocked';
        pipelineState.blocked_at = new Date().toISOString();
        pipelineState.blocked_step = stepConfig.name;
        pipelineState.blocked_reason = 'user_stopped_via_api_stop';
        await this.savePipelineJson(ticket.id, pipelineState);
        this.emit('ticket_stop_observed', { ticket: ticket.id, step: stepConfig.name });
        return;
      }
      // Session sharing: reuse previous session when configured.
      // Groups: tests_red→implement, tests_green→review, root_cause→docs_update
      const prevSessionId = this.sessionId;
      if (!stepConfig.reuse_session) {
        this.sessionId = null;
      }

      // Check step condition (e.g., root_cause only for bugs)
      if (stepConfig.condition) {
        const fieldVal = ticket[stepConfig.condition.field];
        if (fieldVal !== stepConfig.condition.equals &&
            !(stepConfig.condition.equals === 'bug' && fieldVal?.includes('bug'))) {
          pipelineState.steps[stepConfig.name] = { status: 'not_applicable', reason: `condition not met: ${stepConfig.condition.field} !== ${stepConfig.condition.equals}` };
          await this.savePipelineJson(ticket.id, pipelineState);
          this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'condition not met' });
          stepMetrics.push({ step: stepConfig.name, model: '-', durationMs: 0, durationFormatted: '-', inputTokens: 0, outputTokens: 0, toolCalls: 0, filesChanged: 0, gate: '-', status: 'skipped' });
          executedThisRun.add(stepConfig.name);
          this.sessionId = prevSessionId;
          continue;
        }
      }

      // PIPE-001: plan_critic gate (single-arm, per operator decision
      // 2026-05-04). Critic runs when EITHER the ticket is non-trivial
      // complexity OR the plan touches a load-bearing file. Anything
      // smaller AND not load-bearing is skipped — the critic's $0.70/run
      // cost isn't justified for a typo fix in a screen-level widget.
      if (stepConfig.name === 'plan_critic') {
        const enabled = this.config.plan_critic?.enabled !== false;
        const loadBearing = this.config.plan_critic?.load_bearing_files || [];
        const planFiles = (pipelineState.steps?.plan?.files_to_change || [])
          .map((f) => (typeof f === 'string' ? f : f.path))
          .filter(Boolean);
        const matchesLoadBearing = planFiles.some((p) =>
          loadBearing.some((g) => globMatchSimple(g, p))
        );
        // PIPE: critic gating re-keyed from ticket.complexity → plan.risk
        // (2026-05-19). ticket.complexity was NEVER populated (unset on 32/32
        // predictor tickets), so the complexity arm was always falsy and the
        // critic ran on NOTHING — it has been dormant the entire project.
        // Meanwhile `plan.risk` IS graded every ticket (low/medium/high).
        // Policy matches operator intent "depth for big tickets, fast for
        // small ones": critic runs only on HIGH-risk plans (the genuinely
        // hard tickets) or when a load-bearing file is touched. low/medium
        // skip — the critic's Opus + ~3min cost isn't justified for contained
        // changes, and we measured it doesn't prevent implement gate-fails
        // (those were a covers_plan accounting bug, fixed separately).
        const planRisk = String(pipelineState.steps?.plan?.risk || '').toLowerCase();
        const riskArm = planRisk === 'high';
        const shouldRun = enabled && (riskArm || matchesLoadBearing);
        if (!shouldRun) {
          const reason = !enabled
            ? 'plan_critic disabled in config'
            : `plan.risk=${planRisk || 'unset'} (not high) AND no load-bearing file in plan.files_to_change`;
          pipelineState.steps[stepConfig.name] = { status: 'not_applicable', reason };
          await this.savePipelineJson(ticket.id, pipelineState);
          this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason });
          stepMetrics.push({ step: stepConfig.name, model: '-', durationMs: 0, durationFormatted: '-', inputTokens: 0, outputTokens: 0, toolCalls: 0, filesChanged: 0, gate: '-', status: 'skipped' });
          executedThisRun.add(stepConfig.name);
          this.sessionId = prevSessionId;
          continue;
        }
      }

      // Check if step already done (crash recovery)
      const existingStep = pipelineState.steps[stepConfig.name];
      if (existingStep?.status === 'done' || existingStep?.status === 'not_applicable') {
        this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'already done' });
        stepMetrics.push({ step: stepConfig.name, model: '-', durationMs: 0, durationFormatted: '-', inputTokens: 0, outputTokens: 0, toolCalls: 0, filesChanged: 0, gate: '-', status: 'resumed' });
        // Note: NOT added to executedThisRun. The merge guard will verify
        // that any "done" status here is backed by a prior-run step tag —
        // otherwise it's a worker forgery and the merge is refused.
        continue;
      }

      // Reset crashed/blocked steps back to pending for retry
      if (existingStep?.status === 'crashed' || existingStep?.status === 'blocked') {
        this.emit('step_retry', { ticket: ticket.id, step: stepConfig.name, previousStatus: existingStep.status });
        pipelineState.steps[stepConfig.name] = { status: 'pending', retried_at: new Date().toISOString(), previous: existingStep };
        await this.savePipelineJson(ticket.id, pipelineState);
      }

      // Dry run: only plan step
      if (this.dryRun && stepConfig.name !== 'plan') {
        this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'dry run' });
        continue;
      }

      this.emit('step_start', { ticket: ticket.id, step: stepConfig.name });
      const stepStartTime = Date.now();
      // Reset per-step rate-limit wait accumulator so step duration can
      // exclude idle time spent waiting for the 5h usage window to reset.
      this.currentStepWaitMs = 0;
      let stepInputTokens = 0;
      let stepOutputTokens = 0;
      let stepToolCalls = 0;

      // Pre-populate mechanical docs before LLM docs_update step
      if (stepConfig.name === 'docs_update') {
        await this.mechanicalDocsUpdate(ticket, pipelineState);
      }

      // tests_green: run tests + analyzer directly, self-heal if failures
      if (stepConfig.name === 'tests_green') {
        // 3 attempts to give the model-escalation ladder all three rungs:
        // attempt 1 = haiku (cheap), 2 = sonnet (most fixes), 3 = opus (last resort).
        const maxHealAttempts = 3;
        let healAttempt = 0;
        let testsGreenResult;
        // #1 heal regression guard: a heal must not make the tree worse.
        // Track the failure score the heal was asked to fix; on the next
        // run compare against it. heal-1 on T-011 cleared 4 analyzer
        // errors but introduced 10 test failures, then heal-2 had to dig
        // out from that worse state. We now (a) escalate the model the
        // moment a heal regresses and (b) abort honestly after two
        // consecutive regressions rather than burning the remaining
        // attempts on a poisoned tree.
        let prevHealScore = null;
        let healRegressed = false;
        let consecutiveRegressions = 0;
        const failureScore = (a) => (a.new_failures || 0) + (a.new_analyzer_errors || 0)
          + ((a.unit_crashed || a.unit_skipped_compile_errors || (a.unit_ran_nothing && !a.unit_no_tests)) ? 1 : 0);

        while (true) {
          testsGreenResult = await this.runTestsGreen(ticket, pipelineState, healAttempt);
          pipelineState = await this.reloadStepFromDisk(ticket.id, 'tests_green', pipelineState);
          const stepArtifacts = pipelineState.steps.tests_green || {};

          // If tests pass (no new failures AND no new analyzer errors) or
          // we've exhausted heal attempts, proceed to gate.
          //
          // A crashed / "produced no stats" run reports 0 new_failures
          // (nothing was collected), so the failure-count check alone lets a
          // broken suite sail straight to the gate. T-015: `flutter test
          // test/` exited 1 on a test-file compile error, 0 tests collected,
          // gate passed, review+docs ran, then the loop's final all_pass
          // check blocked the ticket — ~6 min wasted. Treat a broken run as
          // needing heal too: heal's compileHint path is built for exactly
          // this. unit_no_tests ("No tests were found") stays benign.
          const runBroken = stepArtifacts.unit_crashed
            || stepArtifacts.unit_skipped_compile_errors
            || (stepArtifacts.unit_ran_nothing && !stepArtifacts.unit_no_tests);
          const needsHeal = runBroken || (stepArtifacts.new_failures > 0) || (stepArtifacts.new_analyzer_errors > 0);

          // #1: compare this run's failure score against the score the
          // previous heal was handed. Strictly worse = that heal
          // regressed the tree.
          const curScore = failureScore(stepArtifacts);
          if (needsHeal && prevHealScore !== null) {
            if (curScore > prevHealScore) {
              healRegressed = true;
              consecutiveRegressions += 1;
              this.emit('tests_green_heal_regressed', { ticket: ticket.id, attempt: healAttempt, before: prevHealScore, after: curScore });
              console.log(`[self-heal] ${ticket.id}/tests_green: heal-${healAttempt} REGRESSED (score ${prevHealScore} → ${curScore}) — escalating model; not building further on the worse tree`);
              if (consecutiveRegressions >= 2) {
                // Two heals in a row made it worse. More attempts on a
                // poisoned tree dig the hole deeper — fail honestly now
                // (processTicket reverts to baseline) instead of burning
                // the last rung.
                this.emit('step_gate_failed', { ticket: ticket.id, step: 'tests_green', failures: [`heal regressed twice (score ${prevHealScore} → ${curScore})`] });
                throw new Error(`Gate failed for ${ticket.id}/tests_green: heal regressed twice (score → ${curScore}); aborting before further damage to the working tree`);
              }
            } else {
              healRegressed = false;
              consecutiveRegressions = 0;
            }
          }

          if (!needsHeal || healAttempt >= maxHealAttempts) {
            const planArtifacts = pipelineState.steps.plan || {};
            const validation = validateStep(stepArtifacts, stepConfig, planArtifacts);

            // Defence in depth: validateStep only checks new_failures==0 &&
            // new_analyzer_errors==0, both of which are 0 for a crashed /
            // ran-nothing suite. all_pass is the authoritative signal — set
            // only by the native runTestsGreen, never by a worker — and
            // already encodes crash, ran-nothing, extra-failures and
            // analyzer state. Without this a broken suite passes the
            // per-step gate and only trips the loop's final consistency
            // check after review+docs have already burned a cycle (T-015).
            if (validation.pass && stepArtifacts.all_pass !== true) {
              const why = stepArtifacts.unit_crashed ? 'test run crashed'
                : stepArtifacts.unit_ran_nothing ? 'test command produced no stats (check cmd/cwd)'
                : stepArtifacts.unit_skipped_compile_errors ? 'tests skipped due to compile errors'
                : (stepArtifacts.new_extra_failures && stepArtifacts.new_extra_failures.length) ? 'new failures outside the changed surface'
                : 'all_pass is not true';
              validation.pass = false;
              validation.failures.push(`tests_green did not actually pass: ${why} (exit ${stepArtifacts.unit_exit_code}, ${stepArtifacts.unit_tests?.passed ?? 0} passed / ${stepArtifacts.unit_tests?.failed ?? 0} failed)`);
            }

            this.emit('step_gate', { ticket: ticket.id, step: 'tests_green', pass: validation.pass, failures: validation.failures });

            if (!validation.pass) {
              // 2026-04-27: gate-level generic selfHeal removed for
              // tests_green. The worker would happily rewrite the worker
              // output file with `all_pass:true` and the orchestrator would
              // accept it without actually re-running tests — exactly what
              // happened on BUG-253 (gate-level heal claimed 2071 passed /
              // 0 failed with 0 tool calls). The in-loop heal above is the
              // only legitimate path for tests_green: it edits source code,
              // then runTestsGreen re-runs the actual suite. If the in-loop
              // heal exhausts its attempts and the gate still fails, that's
              // a real verification failure — fail the ticket honestly.
              this.emit('step_gate_failed', { ticket: ticket.id, step: 'tests_green', failures: validation.failures });
              throw new Error(`Gate failed for ${ticket.id}/tests_green: ${validation.failures.join(', ')}`);
            }
            break;
          }

          // Tests have new failures (or new analyzer errors) — ask Claude to fix
          healAttempt++;
          // Remember the score this heal is being handed, so the next
          // run can tell whether the heal helped or regressed (#1).
          prevHealScore = curScore;
          const newFailedTests = stepArtifacts.new_failed_tests || stepArtifacts.failed_tests || [];
          const newAnalyzerErrCount = stepArtifacts.new_analyzer_errors || 0;
          const compileFirst = stepArtifacts.unit_skipped_compile_errors;
          this.emit('tests_green_heal', { ticket: ticket.id, attempt: healAttempt, newFailures: stepArtifacts.new_failures, newAnalyzerErrors: newAnalyzerErrCount, failedTests: newFailedTests });
          console.log(`[self-heal] ${ticket.id}/tests_green: ${stepArtifacts.new_failures} new test failures, ${newAnalyzerErrCount} new analyzer errors, attempt ${healAttempt}/${maxHealAttempts}`);

          // Detect load/compile errors — these indicate a broken import
          // (usually a missing dependency in pubspec/package.json), not a
          // logic bug. Self-heal needs to treat them differently.
          const loadErrorPattern = /^loading\s+\/|uri_does_not_exist|undefined[_ ]class|undefined[_ ]function|Target of URI doesn't exist/i;
          const loadErrors = newFailedTests.filter((t) => loadErrorPattern.test(t));
          const compileHint = (compileFirst || newAnalyzerErrCount > 0)
            ? `\n\n⚠️  COMPILE ERRORS DETECTED (${newAnalyzerErrCount} new analyzer errors). Unit tests were ${compileFirst ? 'SKIPPED' : 'also run'} because the code doesn't compile cleanly. FIX COMPILE ERRORS FIRST. The analyzer output below lists them. Don't touch test logic until the analyzer is clean.`
            : '';
          const depHint = loadErrors.length > 0
            ? `\n\n⚠️  LOAD ERRORS DETECTED (${loadErrors.length} of ${newFailedTests.length}). When a test fails with "loading <path>" or an "URI doesn't exist / undefined class" message, the test file cannot compile — usually because an imported package is NOT in the project's manifest. DO NOT try to fix the test logic first. FIRST:\n1. Read the failing test file and list every \`package:\` / \`import ... from\` it uses.\n2. Compare against pubspec.yaml / package.json.\n3. If any dependency is missing, add it (for Dart: under dev_dependencies with a compatible version; for Node: npm install / add to package.json).\n4. Then re-examine remaining test failures once compile errors are gone.`
            : '';

          const failingSourceBlock = this.buildFailingTestSourceBlock(newFailedTests);

          const fixPrompt = `You are fixing failing tests for ticket ${ticket.id}: "${ticket.title}".

${newAnalyzerErrCount > 0 ? `NEW ANALYZER ERRORS (${newAnalyzerErrCount} — fix these first):\n${stepArtifacts.analyze_output_summary || '(see full analyzer output in pipeline state)'}\n\n` : ''}FAILING TESTS (${stepArtifacts.new_failures} new failures — preexisting red tests are filtered out):
${newFailedTests.join('\n')}

TEST OUTPUT (last lines):
${stepArtifacts.test_output_summary}${compileHint}${depHint}${failingSourceBlock}

PIPELINE STATE:
${JSON.stringify({ plan: pipelineState.steps.plan, implement: pipelineState.steps.implement, tests_green: pipelineState.steps.tests_green })}

Fix the code so these tests pass. Read the failing test files to understand what they expect, then fix the source code (not the tests — unless the test itself has a bug like a missing mock setup or wrong import).

After fixing, DO NOT run the tests — the pipeline will re-run them automatically.`;

          // Model escalation ladder. Most heal fixes are trivial (missing
          // import, null check, typo) — the cheap rung handles them. But
          // #2: on a large/coupled ticket, or a compile-class failure, the
          // cheap rung regresses (it fixes the symptom it's pointed at and
          // breaks something cross-file — exactly heal-1 on T-011). Start
          // the ladder above the cheap rung in those cases so the first
          // heal already has the depth to reason across files. And if the
          // previous heal regressed (#1), jump straight up another rung.
          const ladder = this.config.restart?.escalation_ladder || ['haiku', 'sonnet', 'opus'];
          const planFiles = (pipelineState.steps.plan?.files_to_change || []).length;
          const coupled = planFiles > 5 || /\b(med|medium|high)\b/i.test(String(pipelineState.steps.plan?.risk || ''));
          const compileClass = newAnalyzerErrCount > 0 || compileFirst;
          const startRung = (coupled || compileClass) ? 1 : 0;
          const rung = Math.min(ladder.length - 1, startRung + (healAttempt - 1) + (healRegressed ? 1 : 0));
          const healModel = ladder[rung] || 'opus';
          try {
            let healIn = 0, healOut = 0, healTools = 0;
            const healStart = Date.now();
            const healResult = await this.runWithRateLimitRetry(
              () => spawnClaude({
                prompt: fixPrompt,
                model: healModel,
                tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
                maxTurns: 20,
                workingDir: this.cwd,
                sessionId: null,
                env: this.config.environment || {},
                onData: (event) => {
                  const usage = event.message?.usage || event.usage;
                  if (usage?.input_tokens) healIn = usage.input_tokens;
                  if (usage?.output_tokens) healOut += usage.output_tokens;
                  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') healTools++;
                  this.emit('claude_event', { ticket: ticket.id, step: 'tests_green_heal', event });
                },
              }),
              ticket.id,
              'tests_green_heal',
            );
            this.updateRateLimitInfo(healResult.rateLimitInfo);
            console.log(`${logPrefix(this.getUsagePercent().percent)} [usage] ${ticket.id}/tests_green (heal-${healAttempt}) | ${healModel} | ${formatDuration(Date.now() - healStart)} | ${healIn.toLocaleString()} in / ${healOut.toLocaleString()} out | ${healTools} tools`);
            this.emit('step_attempt_done', { ticket: ticket.id, step: 'tests_green_heal', attempt: healAttempt, model: healModel, inputTokens: healIn, outputTokens: healOut, toolCalls: healTools });
          } catch (err) {
            if (err.rateLimited) throw err; // let pipeline handle rate limits
            console.error(`[self-heal] Fix attempt failed: ${err.message}`);
            break;
          }
        }

        const wallMs = Date.now() - stepStartTime;
        const waitedMs = this.currentStepWaitMs || 0;
        const durationMs = Math.max(0, wallMs - waitedMs);
        const finalArtifacts = pipelineState.steps.tests_green || {};
        const metric = {
          step: 'tests_green', model: healAttempt > 0 ? 'native+sonnet' : 'native',
          startedAt: new Date(stepStartTime).toISOString(),
          durationMs, durationFormatted: formatDuration(durationMs),
          wallMs, waitedMs,
          inputTokens: 0, outputTokens: 0, toolCalls: 0,
          filesChanged: 0, gate: 'pass', status: finalArtifacts.status || 'done',
          usagePercent: this.getUsagePercent().percent,
        };
        stepMetrics.push(metric);
        if (pipelineState.steps.tests_green && typeof pipelineState.steps.tests_green === 'object') {
          pipelineState.steps.tests_green.metrics = metric;
          try { await this.savePipelineJson(ticket.id, pipelineState); } catch { /* non-fatal */ }
        }
        this.emit('step_done', { ticket: ticket.id, step: 'tests_green', artifacts: finalArtifacts, metrics: metric });
        // tests_green has its own native path that bypasses runStepWithHealing,
        // so add to executedThisRun explicitly here. Otherwise the F2 guard
        // sees tests_green's status:done with no execution proof and blocks
        // the merge — which is exactly what crashed on T-359's first canary
        // run after F1+F2+F3 landed (16:34 today).
        executedThisRun.add('tests_green');
        continue;
      }

      // Per-step aggregators for cache tokens, per-model split, per-tool counts.
      let stepCacheReadTokens = 0;
      let stepCacheCreationTokens = 0;
      const stepTokensByModel = {};
      const stepToolCallsByName = {};
      const stepSessionRotateCountBefore = this.sessionRotateCount || 0;

      // Run step with self-healing: execute → auto-populate → validate → heal → retry
      // Phase 5B: catch heal-exhaustion throws so we can optionally restart
      // from step N-1 instead of bailing the whole ticket.
      let stepResult;
      try {
        stepResult = await this.runStepWithHealing(ticket, stepConfig, pipelineState, stepStartTime, {
        onTokens: (usage) => {
          if (usage.input_tokens) { this.lastInputTokens = usage.input_tokens; stepInputTokens = usage.input_tokens; }
          if (usage.output_tokens) stepOutputTokens += usage.output_tokens;
          if (usage.cache_read_input_tokens) stepCacheReadTokens = usage.cache_read_input_tokens;
          if (usage.cache_creation_input_tokens) stepCacheCreationTokens = usage.cache_creation_input_tokens;
          if (usage.modelUsage && typeof usage.modelUsage === 'object') {
            for (const [model, mu] of Object.entries(usage.modelUsage)) {
              const slot = stepTokensByModel[model] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
              slot.inputTokens = Math.max(slot.inputTokens, mu.inputTokens || 0);
              slot.outputTokens = Math.max(slot.outputTokens, mu.outputTokens || 0);
              slot.cacheReadTokens = Math.max(slot.cacheReadTokens, mu.cacheReadInputTokens || 0);
              slot.cacheCreationTokens = Math.max(slot.cacheCreationTokens, mu.cacheCreationInputTokens || 0);
              stepTokensByModel[model] = slot;
            }
          }
        },
        onToolCall: (name) => {
          stepToolCalls++;
          if (name) stepToolCallsByName[name] = (stepToolCallsByName[name] || 0) + 1;
        },
      });
      } catch (err) {
        // Phase 5B: heal exhausted on this step. Consider walking back to
        // step N-1 and re-running from there — the prior step's output
        // may have been too weak for this step to make progress, and
        // retrying the same step with a better model (Phase 5A) already
        // failed. Capped at max_restarts per ticket.
        if (restartEnabled) {
          const decision = decideRestart({
            currentStepIndex: i,
            restartCount,
            maxRestarts,
          });
          if (decision.shouldRestart) {
            restartCount = decision.nextRestartCount;
            const prevStepName = steps[decision.newStepIndex].name;
            // Reset prior step's recorded status so the loop re-executes it.
            pipelineState.steps[prevStepName] = {
              status: 'pending',
              restart_triggered_at: new Date().toISOString(),
              restart_reason: `downstream step ${stepConfig.name} exhausted heals`,
            };
            // Reset current step's status too — we'll re-enter it after N-1.
            pipelineState.steps[stepConfig.name] = {
              status: 'pending',
              awaiting_restart_from: prevStepName,
            };
            await this.savePipelineJson(ticket.id, pipelineState);

            // When Phase 3 checkpoints are on, rewind the working tree to
            // step N-2's snapshot so the prior step re-runs on the same
            // inputs as originally. Without checkpoints we only reset the
            // pipeline-state layer.
            if (this.config.checkpoints?.enabled) {
              try {
                revertToBaseline(ticket.id, this.cwd, { workerOutputDir: `${this.config._resolved.workerOutputDir}/${ticket.id}` });
                this.emit('checkpoint_reverted_for_restart', { ticket: ticket.id, from: stepConfig.name, to: prevStepName });
              } catch (revertErr) {
                console.warn(`[restart] ${ticket.id}: git revert failed — ${revertErr.message}`);
              }
            }

            this.emit('ticket_restart_triggered', {
              ticket: ticket.id,
              failedStep: stepConfig.name,
              restartFromStep: prevStepName,
              restartCount,
              maxRestarts,
            });
            console.log(`[restart] ${ticket.id}: ${stepConfig.name} exhausted heals — walking back to ${prevStepName} (restart ${restartCount}/${maxRestarts})`);

            i = decision.newStepIndex - 1; // for-loop will ++ back to newStepIndex
            continue;
          } else {
            this.emit('ticket_restart_declined', {
              ticket: ticket.id,
              failedStep: stepConfig.name,
              reason: decision.reason,
              restartCount,
              maxRestarts,
            });
            console.log(`[restart] ${ticket.id}: no restart — ${decision.reason}`);
          }
        }
        throw err; // legacy behaviour — let run() mark ticket blocked
      }
      pipelineState = stepResult.pipelineState;

      // Think loop (if configured for this step) — skip for low-risk tickets
      let thinkLoopResult = null;
      if (stepConfig.think_loop && stepConfig.think_challenge) {
        const risk = pipelineState.steps.plan?.risk;
        if (risk === 'low') {
          this.emit('think_loop_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'low risk' });
        } else {
          this.emit('think_loop_start', { ticket: ticket.id, step: stepConfig.name, risk });

          // PIPE-018: tell think-loop where the step's real output artifact
          // lives so an accepted critique is APPLIED, not discarded.
          //  - plan/root_cause: structured JSON the next step consumes →
          //    rewrite the worker-output {step}.json, then re-ingest below.
          //  - implement/review: the artifact IS the source in the worktree
          //    → the revise call edits it directly (kind:'code').
          //  - others: no consumable artifact → legacy advisory.
          //
          // review was previously kind:'none' (advisory). That made the two
          // PIPE-018 mechanisms fight each other: round 1 finds real code
          // bugs and is judged "better", but with kind:'none' the findings
          // are stored, never applied. Round 2 re-reads the same unchanged
          // source, re-raises the identical finding, and the non-convergence
          // guard blocks the ticket (predictor T-018 global StateProviders,
          // T-025 unused proPackProvider — both blocked this exact way).
          // review's yaml grants Edit/Write, so apply findings to source
          // just like implement.
          let reviseTarget;
          if (stepConfig.name === 'plan' || stepConfig.name === 'root_cause') {
            reviseTarget = {
              kind: 'json',
              artifactPath: resolve(this.config._resolved.workerOutputDir, ticket.id, `${stepConfig.name}.json`),
            };
          } else if (stepConfig.name === 'implement' || stepConfig.name === 'review') {
            reviseTarget = { kind: 'code' };
          } else {
            reviseTarget = { kind: 'none' };
          }

          const tlResult = await thinkLoop({
            initialResult: stepResult.lastResult || '',
            stepName: stepConfig.name,
            challengeQuestion: stepConfig.think_challenge,
            // effectiveConfig() rewrites project_dir to the active worktree.
            // think-loop's challenger/compare spawn in config.project_dir;
            // with raw this.config that's the UNMERGED source repo, so the
            // challenger sees no implementation and (with the A+B blocked
            // detector) false-blocks every worktree-mode ticket.
            config: this.effectiveConfig(),
            ticket,
            emitter: this.emitter,
            reviseTarget,
            risk, // PIPE-024: non-high risk caps the loop once a round is only non-blocking
          });
          thinkLoopResult = tlResult;

          // A+B: think-loop hit a hard blocker / non-convergence. Do NOT
          // proceed to burn implement/review/heal on a doomed plan — halt
          // the ticket and escalate to the human (run() marks it blocked).
          if (tlResult?.blocked) {
            const e = new Error(
              `think-loop halted ${ticket.id}/${stepConfig.name}: ${tlResult.blockedReason}`
            );
            e.thinkBlocked = true;
            e.blockedReason = tlResult.blockedReason;
            e.blockedStep = stepConfig.name;
            throw e;
          }

          // PIPE-018: the revise phase rewrote the worker-output JSON in
          // place. reloadStepFromDisk reads the CANONICAL pipeline JSON,
          // not the worker artifact — so without re-ingesting, the revised
          // plan would never reach pipelineState.steps and the next step
          // would still consume the pre-fix version. Re-run the same
          // whitelisted ingest the step itself used, then persist.
          if (tlResult?.revised && tlResult.reviseKind === 'json') {
            const ingested = await this.ingestWorkerOutput(ticket.id, stepConfig.name, pipelineState);
            if (ingested) {
              try { await this.savePipelineJson(ticket.id, pipelineState); } catch { /* best-effort */ }
              this.emit('think_revise_ingested', { ticket: ticket.id, step: stepConfig.name });
            }
          }

          // Re-read pipeline JSON after think loop (may have been updated)
          pipelineState = await this.reloadStepFromDisk(ticket.id, stepConfig.name, pipelineState);
        }
      }

      // Step's worker actually executed in this run — record so the
      // squash-merge guard can refuse to ship a ticket whose pipelineState
      // claims a step is done but no worker actually ran it.
      executedThisRun.add(stepConfig.name);

      // Collect step metrics with cost
      const stepWallMs = Date.now() - stepStartTime;
      const stepWaitedMs = this.currentStepWaitMs || 0;
      const stepDurationMs = Math.max(0, stepWallMs - stepWaitedMs); // working time only
      const stepArtifactsFinal = pipelineState.steps[stepConfig.name] || {};
      const filesChanged = stepArtifactsFinal.files_changed?.length || 0;
      const filesUpdated = stepArtifactsFinal.files_updated?.length || 0;
      const stepModel = stepConfig.model || this.config.session.model;

      const attempts = stepResult.attempts || 1;
      const stepMaxTurnsHit = stepResult.maxTurnsHit || false;
      const stepGateFailures = stepResult.gateFailuresByAttempt || [];
      const cacheReadTokens = stepCacheReadTokens;
      const cacheCreationTokens = stepCacheCreationTokens;
      const cacheDenom = cacheReadTokens + cacheCreationTokens + stepInputTokens;
      const cacheHitRatio = cacheDenom > 0 ? Number((cacheReadTokens / cacheDenom).toFixed(3)) : null;
      const sessionRotations = Math.max(0, (this.sessionRotateCount || 0) - stepSessionRotateCountBefore);
      const metric = {
        step: stepConfig.name,
        model: stepModel,
        startedAt: new Date(stepStartTime).toISOString(),
        durationMs: stepDurationMs,
        durationFormatted: formatDuration(stepDurationMs),
        wallMs: stepWallMs,
        waitedMs: stepWaitedMs,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cacheHitRatio,
        tokensByModel: stepTokensByModel,
        toolCalls: stepToolCalls,
        toolCallsByName: stepToolCallsByName,
        attempts,
        maxTurnsHit: stepMaxTurnsHit,
        gate: attempts > 1 ? 'failed-then-healed' : 'pass',
        gateFailures: stepGateFailures,
        sessionRotations,
        filesChanged: filesChanged || filesUpdated,
        status: stepArtifactsFinal.status || 'done',
        usagePercent: this.getUsagePercent().percent,
        // Instrumentation: the think-loop's cost+outcome was previously
        // SSE-only and unmeasurable after the fact. Persist a compact
        // summary onto the step metric so the reports API exposes
        // benefit-per-token (rounds, how many critiques were applied,
        // and the loop's own token spend).
        thinkLoop: thinkLoopResult ? {
          rounds: thinkLoopResult.rounds,
          discards: thinkLoopResult.discards,
          improvements: thinkLoopResult.improvements,
          revised: !!thinkLoopResult.revised,
          blocked: !!thinkLoopResult.blocked,
          blockedReason: thinkLoopResult.blockedReason || null,
          tokens: thinkLoopResult.tokens,
          history: thinkLoopResult.history,
        } : null,
      };
      stepMetrics.push(metric);

      // Persist metrics + completed_at + run_id onto the ticket's step record
      // so they survive crashes and are readable from the reports API. All
      // three are orchestrator-stamped (not worker-written) per the
      // architectural fix — workers can't be trusted with timestamps (we saw
      // values minutes off wall-clock in T-359 traces) and the per-run UUID
      // is the F5 evidence channel for "this run actually executed this step."
      if (pipelineState.steps[stepConfig.name] && typeof pipelineState.steps[stepConfig.name] === 'object') {
        pipelineState.steps[stepConfig.name].metrics = metric;
        pipelineState.steps[stepConfig.name].completed_at = new Date().toISOString();
        pipelineState.steps[stepConfig.name].run_id = currentRunId;
        try { await this.savePipelineJson(ticket.id, pipelineState); } catch { /* non-fatal */ }
      }

      console.log(`${logPrefix(this.getUsagePercent().percent)} [step] ${ticket.id}/${stepConfig.name} | ${stepModel} | ${formatDuration(stepDurationMs)} | ${stepInputTokens.toLocaleString()} in / ${stepOutputTokens.toLocaleString()} out | ${stepToolCalls} tools`);

      this.emit('step_done', {
        ticket: ticket.id,
        step: stepConfig.name,
        artifacts: stepArtifactsFinal,
        metrics: metric,
      });

      // Review→implement feedback loop: if review found issues, cycle back
      if (stepConfig.name === 'review' && stepArtifactsFinal.status === 'blocked' && stepArtifactsFinal.findings?.length > 0) {
        const maxReviewCycles = 3;
        const reviewCycle = pipelineState._reviewCycles || 0;

        if (reviewCycle < maxReviewCycles) {
          pipelineState._reviewCycles = reviewCycle + 1;
          const findings = stepArtifactsFinal.findings;

          this.emit('review_cycle', {
            ticket: ticket.id,
            cycle: reviewCycle + 1,
            maxCycles: maxReviewCycles,
            findingsCount: findings.length,
          });
          console.log(`[review→implement] ${ticket.id}: cycle ${reviewCycle + 1}/${maxReviewCycles} — ${findings.length} findings, sending back to implement`);

          // Feed findings back to implement and reset implement→tests_green→review
          pipelineState.steps.implement = {
            status: 'pending',
            completed_at: null,
            review_feedback: findings,
            review_cycle: reviewCycle + 1,
          };
          pipelineState.steps.tests_green = { status: 'pending', completed_at: null };
          pipelineState.steps.review = { status: 'pending', completed_at: null };
          await this.savePipelineJson(ticket.id, pipelineState);

          // Rewind: re-process from implement by restarting the step loop
          return await this.processTicket(ticket);
        }

        // Exhausted review cycles — genuinely blocked
        this.emit('ticket_blocked', {
          ticket: ticket.id,
          step: stepConfig.name,
          findings: stepArtifactsFinal.findings,
          reviewCycles: reviewCycle,
        });
        console.log(`[blocked] ${ticket.id} halted at review after ${reviewCycle} cycles — needs human review`);
        pipelineState.status = 'blocked';
        pipelineState.blocked_at = new Date().toISOString();
        pipelineState.blocked_step = stepConfig.name;
        await this.savePipelineJson(ticket.id, pipelineState);
        break;
      }

      // Other blocked/failed/crashed steps — halt cleanly and mark the
      // TICKET (not just the step) so it stops accumulating as in_progress.
      // Previously only 'blocked' was caught here; 'failed' (native
      // tests_green regression) and 'crashed' (self-heal exhaustion) leaked
      // through, leaving tickets in_progress on disk and piling up on each
      // restart.
      if (['blocked', 'failed', 'crashed'].includes(stepArtifactsFinal.status)) {
        const stepStatus = stepArtifactsFinal.status;
        this.emit('ticket_blocked', {
          ticket: ticket.id,
          step: stepConfig.name,
          stepStatus,
        });
        console.log(`[${stepStatus}] ${ticket.id} halted at ${stepConfig.name}`);
        pipelineState.status = stepStatus === 'blocked' ? 'blocked' : 'failed';
        pipelineState.blocked_at = new Date().toISOString();
        pipelineState.blocked_step = stepConfig.name;
        pipelineState.blocked_reason = stepArtifactsFinal.reason || `${stepConfig.name} returned ${stepStatus}`;
        await this.savePipelineJson(ticket.id, pipelineState);
        break;
      }

    }

    // Build and emit ticket summary report
    const ticketWallMs = Date.now() - ticketStartTime;
    const ticketWaitedMs = stepMetrics.reduce((s, m) => s + (m.waitedMs || 0), 0);
    const ticketDurationMs = Math.max(0, ticketWallMs - ticketWaitedMs);
    const totalInputTokens = stepMetrics.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutputTokens = stepMetrics.reduce((s, m) => s + m.outputTokens, 0);
    const totalCacheReadTokens = stepMetrics.reduce((s, m) => s + (m.cacheReadTokens || 0), 0);
    const totalCacheCreationTokens = stepMetrics.reduce((s, m) => s + (m.cacheCreationTokens || 0), 0);
    const totalToolCalls = stepMetrics.reduce((s, m) => s + m.toolCalls, 0);
    const totalFilesChanged = stepMetrics.reduce((s, m) => s + m.filesChanged, 0);
    const usageEnd = this.getUsagePercent();

    // Rework signals: tokens/time consumed by retries beyond the first attempt,
    // review cycles, and tests_green self-heal (all indicators of first-pass failure).
    const reworkInputTokens = stepMetrics
      .filter((m) => (m.attempts || 1) > 1)
      .reduce((s, m) => s + m.inputTokens, 0);
    const reworkOutputTokens = stepMetrics
      .filter((m) => (m.attempts || 1) > 1)
      .reduce((s, m) => s + m.outputTokens, 0);
    const reworkTokenRatio = (totalInputTokens + totalOutputTokens) > 0
      ? Number(((reworkInputTokens + reworkOutputTokens) / (totalInputTokens + totalOutputTokens)).toFixed(3))
      : 0;
    const cacheDenom = totalCacheReadTokens + totalCacheCreationTokens + totalInputTokens;
    const cacheHitRatio = cacheDenom > 0 ? Number((totalCacheReadTokens / cacheDenom).toFixed(3)) : null;

    const report = {
      ticket: ticket.id,
      title: ticket.title,
      type: ticket.type || 'feature',
      date: new Date().toISOString().split('T')[0],
      totalDurationMs: ticketDurationMs,
      totalDurationFormatted: formatDuration(ticketDurationMs),
      totalWallMs: ticketWallMs,
      totalWaitedMs: ticketWaitedMs,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      cacheHitRatio,
      totalToolCalls,
      totalFilesChanged,
      reviewCycles: pipelineState._reviewCycles || 0,
      reworkInputTokens,
      reworkOutputTokens,
      reworkTokenRatio,
      maxTurnsHitSteps: stepMetrics.filter((m) => m.maxTurnsHit).map((m) => m.step),
      sessionRotations: stepMetrics.reduce((s, m) => s + (m.sessionRotations || 0), 0),
      usagePercent: usageEnd.percent,
      resetsAt: usageEnd.resetTime,
      steps: stepMetrics,
    };

    this.emit('ticket_report', report);

    // Persist to usage log for hotspot analysis
    await this.appendUsageLog(report);
    printTicketReport(report);

    // Persist report alongside pipeline JSON
    pipelineState.report = report;

    // META-001 Phase 1: guard ticket completion so blocked/failed state is
    // never silently overwritten. Previously this block unconditionally set
    // status='done', which clobbered the 'blocked'/'failed' status set by
    // the in-loop break on lines 550/571 — producing the pattern where
    // blocked_at and completed_at land within milliseconds of each other
    // and partial work gets committed under a 'done' label.
    //
    // Terminal step statuses that count as completed: done, not_applicable, skipped.
    // Anything else (pending, blocked, failed, crashed, resumed, in_progress)
    // means the ticket is not finished — halt with status=blocked.
    const TERMINAL_OK = new Set(['done', 'not_applicable', 'skipped']);
    const incompleteSteps = Object.entries(pipelineState.steps || {})
      .filter(([, step]) => !step || !TERMINAL_OK.has(step.status));

    // F2 + F3 (audit 2026-04-26, simplified post 2026-04-28): every step
    // claiming `done` must have actually executed in this run
    // (executedThisRun) OR have crash-recovery evidence in the state file
    // (metrics.attempts > 0 written by the orchestrator after a real run,
    // or tests_green.all_pass===true written by the native runTestsGreen).
    // The previous tag-based fallback is gone — there are no step tags
    // anymore (per-ticket branches and per-step commits removed).
    let unverifiedSteps = [];
    if (this.config.checkpoints?.enabled && pipelineState.status !== 'blocked' && pipelineState.status !== 'failed') {
      for (const stepCfg of steps) {
        const stepState = pipelineState.steps?.[stepCfg.name];
        if (!stepState || stepState.status !== 'done') continue;
        if (executedThisRun.has(stepCfg.name)) continue;       // ran this run
        // Crash-recovery: orchestrator-written evidence from a prior run.
        // Workers can't write metrics or all_pass via the schema gate, so
        // these two markers are trustworthy.
        const metrics = stepState.metrics;
        if (metrics && typeof metrics.attempts === 'number' && metrics.attempts > 0) continue;
        if (stepCfg.name === 'tests_green' && stepState.all_pass === true) continue;
        unverifiedSteps.push(stepCfg.name);
      }
      // tests_green specifically: even if executed, must have all_pass:true.
      // Prevents a self-heal worker rewriting tests_green.all_pass=true
      // without actually running the suite.
      const tg = pipelineState.steps?.tests_green;
      if (tg && tg.status === 'done' && executedThisRun.has('tests_green') && tg.all_pass !== true) {
        unverifiedSteps.push('tests_green:all_pass!=true');
      }
    }

    if (pipelineState.status === 'blocked' || pipelineState.status === 'failed' || pipelineState.blocked_at) {
      // Loop already halted this ticket with a terminal failure state.
      // NEVER flip status back to 'done'. Just persist the report.
      console.log(`[preserve-blocked] ${ticket.id}: keeping status=${pipelineState.status} (blocked_step=${pipelineState.blocked_step || 'n/a'})`);
      await this.savePipelineJson(ticket.id, pipelineState);
    } else if (incompleteSteps.length > 0 || unverifiedSteps.length > 0) {
      // Loop completed without setting a terminal state, but some sub-steps
      // never reached done/not_applicable/skipped. Treat the ticket as blocked
      // rather than silently shipping partial work. unverifiedSteps catches the
      // T-359-class failure: status:done that no worker actually produced.
      const reasons = [];
      if (incompleteSteps.length > 0) {
        reasons.push(`sub-steps not complete: ${incompleteSteps.map(([name, s]) => `${name}=${s?.status ?? 'missing'}`).join(', ')}`);
      }
      if (unverifiedSteps.length > 0) {
        reasons.push(`steps marked done but never executed this run and no prior-run tag: ${unverifiedSteps.join(', ')}`);
      }
      pipelineState.status = 'blocked';
      pipelineState.blocked_at = new Date().toISOString();
      pipelineState.blocked_step = (incompleteSteps[0]?.[0]) || unverifiedSteps[0] || 'unknown';
      pipelineState.blocked_reason =
        `Pipeline loop ended without failure, but: ${reasons.join('; ')}`;
      this.emit('ticket_blocked', {
        ticket: ticket.id,
        step: incompleteSteps[0]?.[0] || unverifiedSteps[0] || 'unknown',
        stepStatus: 'post_loop_incomplete',
        reason: pipelineState.blocked_reason,
      });
      console.log(`[blocked] ${ticket.id} post-loop incomplete: ${pipelineState.blocked_reason}`);
      await this.savePipelineJson(ticket.id, pipelineState);
    } else {
      // All sub-steps terminal-OK and no failure state. Truly done.
      pipelineState.status = 'done';
      pipelineState.completed_at = new Date().toISOString();
      await this.savePipelineJson(ticket.id, pipelineState);

      // META-001 Phase 3+4: ticket completed cleanly.
      //   Phase 4 (merge_to_master, default ON when checkpoints.enabled):
      //     squash-merge the ticket branch into master so the pipeline's
      //     output lands as exactly ONE commit per ticket, eliminating the
      //     reconcile-graveyard.js step.
      //   Phase 3 (keep_branch_on_success, default OFF): delete the branch
      //     + step tags unless the operator opted to keep them for audit.
      //
      // Error policy: a merge conflict is an operator problem (master moved
      // under the pipeline). Surface it as ticket_merge_conflict, keep the
      // branch intact for manual rebase, and skip the delete. The ticket's
      // own status is already 'done' on disk — the only thing missing is
      // integration.
      if (this.config.checkpoints?.enabled) {
        // 2026-04-28: per-ticket branches removed. The ticket's work is
        // currently in master's working tree (uncommitted). Make ONE
        // commit with everything `git add -A` picks up — that's the
        // ticket's full output. Then drop the baseline tag.
        //
        // No branch to merge, no step tags to delete, no DIRTY_TREE
        // class of merge failures. The previous mergeToMaster path could
        // strand tickets on side branches when an operator concurrent
        // edit dirtied master mid-run; that failure mode no longer exists
        // because the ticket never left master in the first place.
        try {
          const ticketSha = commitTicketAsOne(
            ticket.id,
            ticket.title || '',
            this.cwd,
          );
          if (ticketSha) {
            this.emit('ticket_committed', { ticket: ticket.id, sha: ticketSha });
            console.log(`[checkpoint] ${ticket.id}: committed to master (${ticketSha.slice(0, 7)})`);
            // 2026-05-20 (post-revert): the per-attempt tests_green-*.log files
            // are noisy (multi-MB each × N attempts × every ticket); delete
            // them on commit. Everything ELSE in worker-output (plan.json,
            // implement.json, review.json, tests_red.json, .attempt-N.json
            // snapshots, diff-*.patch) is forensic evidence — kept forever
            // on disk. Disk is cheap, projects/ is gitignored, and these
            // files let us backtest plan-static-check, inspect past review
            // history, and debug defects discovered against shipped tickets.
            try {
              const woDir = resolve(this.config._resolved.workerOutputDir, ticket.id);
              if (existsSync(woDir)) {
                for (const f of readdirSync(woDir)) {
                  if (/^tests_green-.+-attempt\d+\.log$/.test(f)) {
                    unlinkSync(resolve(woDir, f));
                  }
                }
              }
            } catch (err) {
              console.warn(`[checkpoint] ${ticket.id}: tests_green log cleanup failed — ${err.message}`);
            }
            // Persist the sha on pipelineState so run()'s post-archive
            // worktree merge step can find it.
            pipelineState.checkpoint = pipelineState.checkpoint || {};
            pipelineState.checkpoint.ticket_sha = ticketSha;
            pipelineState.checkpoint.committed_at = new Date().toISOString();
            await this.savePipelineJson(ticket.id, pipelineState);
          } else {
            // Empty diff — pipeline finished all steps but produced no
            // changes. This is almost always a mis-ship: a previous run
            // that left state=done without actually landing the work,
            // or a worker that no-op'd every step. Either way, nothing to
            // ship. Block the ticket with a clear reason — operator can
            // decide whether to re-queue or split the ticket. (2026-04-28:
            // this case caused BUG-253 to "ship" twice with no commit on
            // master.)
            pipelineState.status = 'blocked';
            pipelineState.blocked_at = new Date().toISOString();
            pipelineState.blocked_step = 'commit';
            pipelineState.blocked_reason =
              'all 7 steps marked done but no working-tree changes to commit. ' +
              'Likely a stale-state bug — re-queue the ticket.';
            await this.savePipelineJson(ticket.id, pipelineState);
            this.emit('ticket_committed_empty', { ticket: ticket.id, reason: pipelineState.blocked_reason });
            console.error(`[checkpoint] ${ticket.id}: BLOCKED — ${pipelineState.blocked_reason}`);
            // Drop baseline tag and bail. The ticket stays in the backlog
            // (run() only archives status:done) and surfaces as blocked.
            try { cleanupBaseline(ticket.id, this.cwd); } catch { /* best effort */ }
            return;
          }
        } catch (err) {
          console.error(`[checkpoint] ${ticket.id}: commit FAILED — ${err.message}`);
          this.emit('ticket_commit_failed', { ticket: ticket.id, error: err.message });
          return;
        }

        // Drop the baseline tag — no longer needed once committed.
        try {
          cleanupBaseline(ticket.id, this.cwd);
        } catch (err) {
          console.warn(`[checkpoint] ${ticket.id}: baseline cleanup failed — ${err.message}`);
        }
      }
    }
  }

  // --- Pipeline JSON management ---

  // PIPE-020: a dependency is "satisfied" only when it has shipped — i.e.
  // it is in the archive as done WITH a landed_commit (the same
  // done-implies-shipped bar PIPE-021 enforces), or its backlog entry is
  // status done. A ticket with no depends_on is always satisfied (zero
  // regression for the common case). Backward compatible: depends_on may be
  // absent, [], or a list of ids.
  async dependenciesSatisfied(ticket) {
    const deps = Array.isArray(ticket.depends_on) ? ticket.depends_on.filter(Boolean) : [];
    if (deps.length === 0) return { ok: true, unsatisfied: [] };

    let archived = [];
    try {
      const a = JSON.parse(await readFile(this.config._resolved.archive, 'utf-8'));
      archived = Array.isArray(a?.tickets) ? a.tickets : [];
    } catch { /* no archive yet */ }
    let backlog = [];
    try { backlog = await loadBacklog(this.config); } catch { /* ignore */ }

    const unsatisfied = [];
    for (const id of deps) {
      const arch = archived.find((t) => t.id === id);
      if (arch && arch.status === 'done' && arch.landed_commit) continue;
      const bl = backlog.find((t) => t.id === id);
      if (bl && bl.status === 'done') continue;
      unsatisfied.push({ id, status: arch?.status || bl?.status || 'absent' });
    }
    return { ok: unsatisfied.length === 0, unsatisfied };
  }

  // PIPE-021 bounded cherry-pick retry: a ticket whose merge keeps
  // hard-conflicting re-runs the FULL pipeline every cycle forever (every
  // step's tokens, indefinitely). After N consecutive non-landing attempts,
  // park it (status → an excluded one, default 'manual' = needs operator)
  // with a reason naming the conflict, so token cost is bounded and the
  // operator sees it instead of an invisible infinite loop.
  async parkIfNonLandingExhausted(ticket, attempts, reasonTemplate) {
    const max = this.config.merge?.max_non_landing_attempts ?? 3;
    if (attempts < max) return false;
    const parkStatus = this.config.merge?.park_status || 'manual';
    const reason = `[PIPE-021] ${reasonTemplate.replace('%N%', String(attempts))}`;
    try {
      await setBacklogTicketStatus(ticket.id, this.config, parkStatus, reason);
      this.emit('pipeline_merge_blocked', {
        ticket: ticket.id, attempts, max, parked_status: parkStatus, reason,
      });
      console.error(`[merge-bound] ${ticket.id}: parked status=${parkStatus} after ${attempts} non-landing attempts — ${reason}`);
      return true;
    } catch (err) {
      console.warn(`[merge-bound] ${ticket.id}: park failed — ${err.message}`);
      return false;
    }
  }

  // PIPE-021 reconciliation invariant: every archived `done` ticket that
  // recorded a landed_commit MUST have that commit as an ancestor of the
  // project's current HEAD. A violation = a false-done (recorded shipped,
  // not actually on master) — the automated form of the manual audit that
  // found the 11 strands. Runs at run start, before the queue. Loud but
  // non-fatal: crashing the queue here would itself be a freeze; the
  // operator needs the queue running to re-queue the strand.
  async reconcileArchiveInvariant() {
    let archive;
    try {
      archive = JSON.parse(await readFile(this.config._resolved.archive, 'utf-8'));
    } catch { return; } // no archive yet — nothing to reconcile
    const tickets = Array.isArray(archive?.tickets) ? archive.tickets : [];
    const dir = this.config.project_dir;
    const violations = [];
    for (const t of tickets) {
      if (t.status !== 'done' || !t.landed_commit) continue;
      try {
        execSync(
          `git -C "${dir}" merge-base --is-ancestor ${t.landed_commit} HEAD`,
          { encoding: 'utf-8', timeout: 10000 },
        );
      } catch {
        violations.push({ id: t.id, landed_commit: t.landed_commit });
      }
    }
    if (violations.length > 0) {
      this.emit('archive_invariant_violation', { count: violations.length, violations });
      console.error(
        `[reconcile] ARCHIVE INVARIANT VIOLATED — ${violations.length} archived done ticket(s) whose landed_commit is NOT an ancestor of HEAD (false-done):\n` +
        violations.map((v) => `  • ${v.id} @ ${String(v.landed_commit).slice(0, 12)}`).join('\n') +
        `\n  These shipped nothing. Re-queue them (set status back to actionable) or investigate the strand.`,
      );
    } else {
      this.emit('archive_invariant_ok', { checked: tickets.filter((t) => t.landed_commit).length });
    }
    return violations;
  }

  async loadOrCreatePipelineJson(ticket) {
    const existing = await this.loadPipelineJson(ticket.id);
    if (existing) {
      // 2026-04-28: state files no longer "resume" across pipeline runs.
      // The ticket is in the actionable backlog (otherwise we wouldn't be
      // running it), so any prior status:done in the state file must be
      // wrong — either from a mis-ship that didn't actually land, or a
      // crash mid-archive, or a stale file the operator left around. Reset
      // to a fresh slate; treat this run as a from-scratch attempt. The
      // previous "skip already-done step" path was the source of repeated
      // mis-ships (T-359, BUG-253) where the orchestrator trusted state
      // and ended up shipping nothing. Crash recovery costs us re-running
      // ~30 minutes of completed steps; mis-shipping cost us a week.
      this.emit('stale_state_reset', { ticket: ticket.id, prior_status: existing.status });
      console.log(`[load] ${ticket.id}: stale state file reset (prior status=${existing.status})`);
    }

    const state = {
      schema: 'pipeline-v2',
      ticket: ticket.id,
      title: ticket.title,
      priority: ticket.priority || 'P2',
      type: ticket.type || 'feature',
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'in_progress',
      created_by: 'pipeline',
      steps: {},
    };

    // PIPE-021 bounded retry: the stale state is reset every run, but the
    // count of consecutive non-landing (cherry-pick conflict) attempts must
    // survive so we can park a permanently-conflicting ticket instead of
    // re-running the full pipeline on it forever.
    const priorNonLanding = existing?.merge?.non_landing_attempts;
    if (Number.isInteger(priorNonLanding) && priorNonLanding > 0) {
      state.merge = { non_landing_attempts: priorNonLanding };
    }

    for (const step of this.config.steps) {
      state.steps[step.name] = { status: 'pending', completed_at: null };
    }

    await this.savePipelineJson(ticket.id, state);
    return state;
  }

  async loadPipelineJson(ticketId) {
    const path = resolve(this.config._resolved.pipelineDir, `${ticketId}.json`);
    if (!existsSync(path)) return null;
    let raw = await readFile(path, 'utf-8');
    // Sanitize: Claude sometimes writes JS expressions in JSON (e.g. "574 + 27" instead of 601)
    raw = raw.replace(/:\s*(\d+)\s*\+\s*(\d+)/g, (_, a, b) => ': ' + (parseInt(a) + parseInt(b)));
    return JSON.parse(raw);
  }

  // Scoped reload: take ONLY the named step's slot from disk, keep the rest of
  // the orchestrator's in-memory state. Used after a worker runs so a worker
  // that wrote `steps.implement.status='done'` while running tests_red can't
  // make implement get skipped on the next loop iteration.
  //
  // 2026-04-26 incident: T-359's tests_red self-heal worker rewrote the full
  // pipeline JSON with done-statuses on every downstream step; the
  // wholesale-reload site at the worker-completion path picked them up; the
  // step loop skipped implement/tests_green/review/docs_update; squash-merge
  // landed on master with no implementation verification.
  // PIPE-017: pre-load the source of each failing test (or compile-broken
  // file) into the heal prompt. Without this the heal only sees "a test
  // failed somewhere" and has to spend turns Re-reading; with it, it has
  // the actual evidence ("this fixture's Entry(...) is missing the new
  // required field"). Composes with PIPE-016 (planner-side prevention):
  // even when the planner misses a consumer, heal can recover from the
  // source it can now see. Dedupes on path, ranks by how many failures
  // reference the file, caps at maxFiles, truncates each to 200 lines/8KB.
  buildFailingTestSourceBlock(failedTests, opts = {}) {
    const MAX_FILES = opts.maxFiles || 8;
    const MAX_LINES = 200;
    const MAX_BYTES = 8 * 1024;
    if (!Array.isArray(failedTests) || failedTests.length === 0) return '';
    const loadErrorPattern = /loading\s+\/|uri_does_not_exist|undefined[_ ]class|undefined[_ ]function|Target of URI doesn't exist/i;
    const pathRe = /([\w./@-]+\.(?:dart|tsx|ts|jsx|js|py))/g;
    const counts = new Map();      // path -> # of failing entries referencing it
    const compilePaths = new Set(); // paths that came from a compile/load error
    for (const entry of failedTests) {
      if (typeof entry !== 'string') continue;
      const isCompile = loadErrorPattern.test(entry);
      const seen = new Set();
      let m;
      pathRe.lastIndex = 0;
      while ((m = pathRe.exec(entry)) !== null) {
        const p = m[1];
        if (seen.has(p)) continue;
        seen.add(p);
        counts.set(p, (counts.get(p) || 0) + 1);
        if (isCompile) compilePaths.add(p);
      }
    }
    if (counts.size === 0) return '';
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FILES);
    const blocks = [];
    for (const [rel] of ranked) {
      const abs = rel.startsWith('/') ? rel : resolve(this.cwd, rel);
      let src;
      try { src = readFileSync(abs, 'utf-8'); } catch { continue; }
      const lines = src.split('\n');
      const totalBytes = Buffer.byteLength(src, 'utf-8');
      let body = lines.slice(0, MAX_LINES).join('\n');
      if (Buffer.byteLength(body, 'utf-8') > MAX_BYTES) body = body.slice(0, MAX_BYTES);
      const truncated = lines.length > MAX_LINES || totalBytes > MAX_BYTES
        ? `\n… [truncated; full file is ${lines.length} lines / ${totalBytes}B]` : '';
      const compileNote = compilePaths.has(rel)
        ? ' note="this file failed to COMPILE — fix the import/type mismatch here first, do not touch test logic"' : '';
      blocks.push(`<failing_source path="${rel}"${compileNote}>\n${body}${truncated}\n</failing_source>`);
    }
    if (blocks.length === 0) return '';
    const omitted = counts.size - ranked.length;
    const cap = omitted > 0
      ? ` (showing the ${blocks.length} most-referenced of ${counts.size} failing source files; ${omitted} omitted — fix these first)`
      : '';
    return `\n\nFAILING SOURCE FILES — pre-loaded so you can reason about cross-file breaks (e.g. a fixture's Type(...) call missing a new required field) WITHOUT re-Reading them${cap}:\n\n${blocks.join('\n\n')}\n`;
  }

  async reloadStepFromDisk(ticketId, stepName, prevState) {
    const fresh = await this.loadPipelineJson(ticketId);
    if (!fresh) return prevState;
    const merged = { ...prevState };
    merged.steps = { ...(prevState.steps || {}) };
    if (fresh.steps && fresh.steps[stepName] !== undefined) {
      merged.steps[stepName] = fresh.steps[stepName];
    }
    return merged;
  }

  // Architectural fix 2026-04-27: workers write a flat JSON object to a
  // per-step output file ({worker_output_dir}/{ticket}/{step}.json) instead
  // of the canonical pipeline state. Orchestrator validates the worker's
  // payload against a per-step field whitelist and merges only those fields
  // into pipelineState.steps[stepName]. Anything else the worker wrote is
  // dropped silently — even if a worker tries to set steps for OTHER pipeline
  // stages, those writes never reach the canonical state.
  //
  // Returns true if a worker output was found and ingested, false otherwise.
  async ingestWorkerOutput(ticketId, stepName, pipelineState) {
    const path = resolve(this.config._resolved.workerOutputDir, ticketId, `${stepName}.json`);
    if (!existsSync(path)) return false;
    let raw;
    try { raw = await readFile(path, 'utf-8'); }
    catch (err) {
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: read failed — ${err.message}`);
      return false;
    }
    raw = raw.replace(/:\s*(\d+)\s*\+\s*(\d+)/g, (_, a, b) => ': ' + (parseInt(a) + parseInt(b)));
    let payload;
    try { payload = JSON.parse(raw); }
    catch (err) {
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: JSON parse failed — ${err.message}`);
      return false;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: payload is not an object`);
      return false;
    }
    const allowed = STEP_OUTPUT_SCHEMA[stepName];
    if (!allowed) {
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: no schema declared, dropping output`);
      return false;
    }
    // F4 (audit 2026-04-26): only the orchestrator may set not_applicable.
    // Workers writing it would bypass the F2 merge guard (which only checks
    // status=='done'). Coerce worker-set not_applicable to pending so the
    // orchestrator's condition-skip path stays the single authority.
    if (payload.status === 'not_applicable') {
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: worker tried to set status=not_applicable; coerced to pending (orchestrator owns this status)`);
      payload.status = 'pending';
      this.emit('worker_status_coerced', { ticket: ticketId, step: stepName, from: 'not_applicable', to: 'pending' });
    }
    // Status value validation. Workers occasionally invent values like
    // "passed" / "success" / "ok" — these aren't in TERMINAL_OK and would
    // trip the merge guard ("incomplete sub-steps"). Coerce common
    // success-shaped synonyms to "done"; coerce anything else to "pending"
    // so the orchestrator decides explicitly.
    const VALID_STATUS = new Set(['done', 'blocked', 'pending', 'failed', 'crashed']);
    const SUCCESS_SYNONYMS = new Set(['passed', 'pass', 'success', 'ok', 'complete', 'completed', 'green']);
    if (payload.status && !VALID_STATUS.has(payload.status)) {
      const original = payload.status;
      const target = SUCCESS_SYNONYMS.has(String(payload.status).toLowerCase()) ? 'done' : 'pending';
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: worker wrote invalid status="${original}"; coerced to "${target}"`);
      payload.status = target;
      this.emit('worker_status_coerced', { ticket: ticketId, step: stepName, from: original, to: target });
    }
    const existing = pipelineState.steps?.[stepName] || {};
    const merged = { ...existing };
    const accepted = [];
    const rejected = [];
    for (const [k, v] of Object.entries(payload)) {
      if (allowed.includes(k)) { merged[k] = v; accepted.push(k); }
      else { rejected.push(k); }
    }
    if (rejected.length > 0) {
      this.emit('worker_output_fields_dropped', { ticket: ticketId, step: stepName, dropped: rejected });
      console.log(`[ingest-worker] ${ticketId}/${stepName}: dropped ${rejected.length} non-whitelisted field(s): ${rejected.join(', ')}`);
    }
    pipelineState.steps = pipelineState.steps || {};
    pipelineState.steps[stepName] = merged;
    await this.savePipelineJson(ticketId, pipelineState);
    this.emit('worker_output_ingested', { ticket: ticketId, step: stepName, fields: accepted });

    // Archive this attempt before the next worker run can clobber {step}.json.
    // The review→implement→review loop and the self-heal loop both overwrite
    // the same path; without an archive, the divergent findings/diffs from
    // earlier cycles are lost — which is exactly why T-045's review history
    // was unrecoverable on 2026-05-20 (each review cycle clobbered the prior
    // one, and the final crash left zero record of what review had flagged).
    //
    // Filesystem-counted: list existing siblings to pick N, no extra state
    // tracking. Append-only — costs ~few KB per ticket per step. Snapshot
    // failure is non-fatal: it's diagnostic, not load-bearing.
    try {
      const dir = resolve(this.config._resolved.workerOutputDir, ticketId);
      const prefix = `${stepName}.attempt-`;
      const siblings = (await readdir(dir)).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
      const n = siblings.length;
      const archivePath = resolve(dir, `${stepName}.attempt-${n}.json`);
      await copyFile(path, archivePath);
      this.emit('worker_output_archived', { ticket: ticketId, step: stepName, attempt: n, path: archivePath });
    } catch (err) {
      console.warn(`[ingest-worker] ${ticketId}/${stepName}: archive snapshot failed — ${err.message}`);
    }
    return true;
  }

  async savePipelineJson(ticketId, state) {
    await mkdir(this.config._resolved.pipelineDir, { recursive: true });
    const path = resolve(this.config._resolved.pipelineDir, `${ticketId}.json`);
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  // --- Dead-code island removed 2026-05-01 ---
  //
  // Previously this section held a parallel rollback/commit/declaration-
  // accounting layer (rollbackTicketFiles, commitTicketFiles,
  // collectTicketFiles, collectDeclaredFiles, checkSilentWrites,
  // snapshotDirtyAtStart, getDirtyFiles, isOrchestratorPath). It diffed
  // `git status --porcelain` against LLM-declared file lists and tried to
  // tell ticket writes apart from operator dirt in a shared working tree.
  //
  // The 2026-04-28 worktree refactor (worktree.js + checkpoint.js) made
  // all of this redundant: each ticket runs in an isolated worktree,
  // `setupTicketBaseline` tags the start point, `revertToBaseline` does
  // `git reset --hard <tag> && git clean -fd` on failure, and
  // `commitTicketAsOne` does `git add -A && git commit` on success. There
  // is no operator dirt in the worktree to tell ticket writes apart from,
  // so no declaration ledger is needed.
  //
  // The silent-writes gate that lived here was also generating false
  // positives whenever git collapsed a new-only directory into `dir/`
  // (BUG-258), since the declaration set held file paths but git reported
  // the parent dir. Removing the gate fixes the false positive without
  // weakening atomicity — the worktree lifecycle enforces it instead.
  // --- Dependency-declaration gate ---

  // PIPE-025: deterministic review gate. T-018 false-passed because a
  // feature added a large pure-logic module with ZERO tests, yet
  // covers_plan_criteria only WARNED (shortfall under threshold) and review
  // marked done. This is a hard gate, not a prompt vibe: a feature/
  // enhancement ticket whose implement added a net-new, non-trivial
  // pure-logic source file with no test referencing it fails review,
  // bypassing the covers_plan_criteria ≤2/≤20% escape valve. Conservative
  // by construction so it never blocks plumbing/[no-test]/refactors:
  // requires BOTH a real logic signature (lines + branch constructs) AND
  // zero test reference AND a behavioural ticket type.
  checkBehaviouralTestCoverage(pipelineState, ticket) {
    const type = (ticket.type || 'feature').toLowerCase();
    if (type !== 'feature' && type !== 'enhancement') return [];

    const implFiles = (pipelineState.steps?.implement?.files_changed || [])
      .map((f) => (typeof f === 'object' ? f.path : f)).filter(Boolean);
    const testFiles = (pipelineState.steps?.tests_red?.test_files || [])
      .map((f) => (typeof f === 'object' ? f.path : f)).filter(Boolean);
    const criteria = (pipelineState.steps?.tests_red?.criteria_to_test_map || []);
    const planList = (pipelineState.steps?.plan?.files_to_change || []);

    // [no-test]-bulleted plan paths are explicitly exempt.
    const noTestPaths = new Set(
      planList
        .filter((p) => /^\s*\[no-test\]/i.test((typeof p === 'object' ? p.what_to_do : '') || ''))
        .map((p) => (typeof p === 'object' ? p.path : p)),
    );
    // Pure plumbing — never behavioural logic worth a dedicated test.
    const PLUMBING = /(^|\/)(index|exports?|barrel|constants?|theme|colors?|strings?|l10n|generated)\.[a-z]+$|\.(g|freezed|gen|pb)\.[a-z]+$/i;

    const testRefs = [
      ...testFiles.map((t) => t.toLowerCase()),
      ...criteria.map((c) => `${c.criterion || ''} ${c.path || ''}`.toLowerCase()),
    ].join('\n');

    const offenders = [];
    for (const f of implFiles) {
      if (isTestPath(f)) continue;
      if (noTestPaths.has(f)) continue;
      if (PLUMBING.test(f)) continue;
      const base = f.split('/').pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
      if (base.length < 3) continue;
      // "covered" = some test file or criterion references the module name.
      if (testRefs.includes(base)) continue;
      // Net-new + non-trivial pure logic check: read from the worktree.
      const abs = resolve(this.cwd, f);
      if (!existsSync(abs)) continue;
      let src = '';
      try { src = readFileSync(abs, 'utf-8'); } catch { continue; }
      const codeLines = src.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*')).length;
      // Real control-flow keywords only — `=>`/`?`/`&&` are too noisy in
      // Dart (arrow bodies, nullable types) and would over-flag DTOs.
      const branches = (src.match(/\b(if|else|for|while|switch|case|catch)\b/g) || []).length;
      // Net-new heuristic: the file was added by this ticket (not present
      // at the per-ticket baseline tag).
      let netNew = true;
      try {
        execSync(`git -C "${this.cwd}" cat-file -e pipeline/${ticket.id}/baseline:"${f}"`,
          { encoding: 'utf-8', timeout: 8000 });
        netNew = false; // existed at baseline → modification, not net-new
      } catch { netNew = true; }
      // Conservative non-trivial-logic signature: real branching AND not a
      // one-liner. Trivial getters/DTOs/constants have ~0 control keywords.
      if (netNew && codeLines >= 8 && branches >= 3) {
        offenders.push(f);
      }
    }
    return offenders;
  }

  checkDepsDeclared(stepArtifacts, planArtifacts) {
    const projectDir = this.cwd;
    // Dart/Flutter packages that are available without being in pubspec:
    const DART_BUILTIN = new Set(['flutter', 'flutter_test', 'flutter_localizations', 'flutter_driver']);
    // Node built-ins (not exhaustive — covers the common ones):
    const NODE_BUILTIN = new Set([
      'fs', 'path', 'os', 'url', 'util', 'crypto', 'http', 'https', 'child_process',
      'events', 'stream', 'buffer', 'readline', 'zlib', 'net', 'tls', 'dns', 'assert',
      'fs/promises',
    ]);

    const changed = (stepArtifacts.files_changed || [])
      .map((f) => (typeof f === 'object' ? f.path : f))
      .filter(Boolean);
    const planned = (planArtifacts?.files_to_change || [])
      .map((f) => (typeof f === 'object' ? f.path : f))
      .filter(Boolean);
    const planSet = new Set(planned);

    const missing = [];

    for (const rel of changed) {
      const ext = rel.slice(rel.lastIndexOf('.'));
      if (!['.dart', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) continue;
      const abs = resolve(projectDir, rel);
      if (!existsSync(abs)) continue;
      let src = '';
      try { src = readFileSync(abs, 'utf-8'); } catch { continue; }

      const imported = new Set();
      if (ext === '.dart') {
        for (const m of src.matchAll(/import\s+['"]package:([^/'"]+)/g)) imported.add(m[1]);
      } else {
        // ES module + CJS: capture first path segment; scoped packages keep @scope/name
        const addJsPkg = (spec) => {
          if (!spec || spec.startsWith('.') || spec.startsWith('/')) return;
          if (spec.startsWith('node:')) return;
          const parts = spec.split('/');
          imported.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
        };
        for (const m of src.matchAll(/import\s+(?:[^'"`;]+?from\s+)?['"]([^'"]+)['"]/g)) addJsPkg(m[1]);
        for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) addJsPkg(m[1]);
      }
      if (imported.size === 0) continue;

      const manifest = this.findNearestManifest(abs, ext === '.dart' ? 'pubspec.yaml' : 'package.json');
      if (!manifest) continue;

      const declared = ext === '.dart'
        ? this.parseDartDeps(manifest)
        : this.parseNodeDeps(manifest);
      const builtins = ext === '.dart' ? DART_BUILTIN : NODE_BUILTIN;
      const manifestRel = manifest.startsWith(projectDir + '/') ? manifest.slice(projectDir.length + 1) : manifest;

      for (const pkg of imported) {
        if (declared.has(pkg)) continue;
        if (builtins.has(pkg)) continue;
        // If the ticket explicitly planned to change the manifest, the implement
        // step may still be mid-way — but it must have added it by now or the
        // gate fires. planSet tells us they acknowledged it; we still require
        // the manifest to contain the dep.
        missing.push({ file: rel, pkg, manifest: manifestRel, manifestInPlan: planSet.has(manifestRel) });
      }
    }

    return missing;
  }

  findNearestManifest(startFile, name) {
    let dir = startFile.slice(0, startFile.lastIndexOf('/'));
    const root = this.cwd;
    while (dir.startsWith(root)) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
      const parent = dir.slice(0, dir.lastIndexOf('/'));
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  parseDartDeps(pubspecPath) {
    const out = new Set();
    try {
      const src = readFileSync(pubspecPath, 'utf-8');
      // The package's own name is implicitly importable (`package:<name>/…`).
      const nameMatch = src.match(/^name:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$/m);
      if (nameMatch) out.add(nameMatch[1]);
      // Collect entries under dependencies / dev_dependencies / overrides.
      let inDeps = false;
      for (const line of src.split('\n')) {
        if (/^(dependencies|dev_dependencies|dependency_overrides):\s*$/.test(line)) { inDeps = true; continue; }
        if (/^\S/.test(line)) { inDeps = false; continue; }
        if (!inDeps) continue;
        const m = line.match(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*):/);
        if (m) out.add(m[1]);
      }
    } catch { /* best-effort */ }
    return out;
  }

  parseNodeDeps(pkgJsonPath) {
    const out = new Set();
    try {
      const json = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const obj = json[section];
        if (obj && typeof obj === 'object') Object.keys(obj).forEach((k) => out.add(k));
      }
    } catch { /* best-effort */ }
    return out;
  }

  async syncDepsIfManifestChanged(pipelineState, projectDir, env) {
    const declared = (pipelineState.steps?.implement?.files_changed || [])
      .map((f) => (typeof f === 'object' ? f.path : f))
      .filter(Boolean);

    // Also pick up any manifest that git sees as modified/untracked — the
    // pipeline's implement sometimes edits pubspec/package.json without
    // recording it in files_changed. Without this, a tests_green retry on
    // a stranded ticket would skip the sync.
    const gitDirty = [];
    try {
      const porcelain = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8', timeout: 10000 });
      for (const line of porcelain.split('\n')) {
        const path = line.slice(3).trim();
        if (!path) continue;
        const base = path.slice(path.lastIndexOf('/') + 1);
        if (base === 'pubspec.yaml' || base === 'package.json') gitDirty.push(path);
      }
    } catch { /* best-effort */ }

    const allChanged = Array.from(new Set([...declared, ...gitDirty]));

    // Build unique (cwd, cmd) pairs — one per manifest directory.
    const syncs = new Map();
    for (const rel of allChanged) {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (base === 'pubspec.yaml') {
        const dir = rel.slice(0, rel.lastIndexOf('/')) || '.';
        syncs.set(`flutter:${dir}`, { cwd: resolve(projectDir, dir), cmd: 'flutter pub get' });
      } else if (base === 'package.json') {
        const dir = rel.slice(0, rel.lastIndexOf('/')) || '.';
        // `npm install` picks up new deps AND updates the lockfile.
        syncs.set(`npm:${dir}`, { cwd: resolve(projectDir, dir), cmd: 'npm install --no-audit --no-fund --silent' });
      }
    }
    if (syncs.size === 0) return;

    for (const { cwd, cmd } of syncs.values()) {
      console.log(`[deps-sync] ${cmd} (cwd=${cwd})`);
      this.emit('deps_sync_start', { cmd, cwd });
      try {
        execSync(`${cmd} 2>&1`, { cwd, encoding: 'utf-8', env, timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
        this.emit('deps_sync_done', { cmd, cwd });
      } catch (err) {
        const tail = (err.stdout || err.stderr || err.message || '').toString().slice(-500);
        console.error(`[deps-sync] FAILED: ${cmd} — ${tail}`);
        this.emit('deps_sync_failed', { cmd, cwd, tail });
        // Non-fatal: tests_green will expose the resulting compile errors, and
        // self-heal has the dep-aware hint. Don't abort the step here.
      }
    }
  }

  // --- Crash recovery ---

  async checkCrashedPipelines() {
    const dir = this.config._resolved.pipelineDir;
    if (!existsSync(dir)) return [];

    const { readdir, stat } = await import('fs/promises');
    const files = await readdir(dir);
    const resumed = [];
    const detectedAt = new Date().toISOString();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = resolve(dir, file);
      let state;
      try {
        let raw = await readFile(filePath, 'utf-8');
        // Same sanitizer loadPipelineJson uses — LLMs occasionally emit
        // JS expressions in JSON.
        raw = raw.replace(/:\s*(\d+)\s*\+\s*(\d+)/g, (_, a, b) => ': ' + (parseInt(a) + parseInt(b)));
        state = JSON.parse(raw);
      } catch (err) {
        console.error(`[checkCrashed] skipping malformed ${file}: ${err.message}`);
        this.emit('pipeline_state_unreadable', { file, error: err.message });
        continue;
      }
      if (state.status === 'in_progress') {
        const resumeStep = Object.entries(state.steps).find(
          ([, s]) => s.status !== 'done' && s.status !== 'not_applicable'
        );
        if (resumeStep) {
          // Infer when the ticket was last touched — ticket JSON mtime is
          // the best proxy for "pipeline last wrote something about you".
          let strandedSince = state.started_at;
          try {
            const st = await stat(filePath);
            strandedSince = st.mtime.toISOString();
          } catch { /* keep started_at */ }

          // Structured crash-detected event for the ops log and reports
          // page. Emit once per ticket per server boot — duplicate fires
          // on repeated /api/run/all invocations just clutter the timeline.
          if (!_crashedDetectedThisBoot.has(state.ticket)) {
            _crashedDetectedThisBoot.add(state.ticket);
            this.emit('pipeline_crashed_detected', {
              ticket: state.ticket,
              last_step: resumeStep[0],
              last_step_status: resumeStep[1]?.status || 'unknown',
              stranded_since: strandedSince,
              stranded_duration_sec: strandedSince ? Math.round((Date.now() - new Date(strandedSince).getTime()) / 1000) : null,
              detected_at: detectedAt,
            });
          }
          this.emit('crash_recovery', { ticket: state.ticket, resumeFrom: resumeStep[0] });
          resumed.push({
            id: state.ticket,
            title: state.title,
            priority: state.priority,
            type: state.type,
            _resumed: true,
            _resumeFrom: resumeStep[0],
          });
        }
      }
    }

    if (resumed.length > 0) {
      this.emit('pipeline_resumed', { count: resumed.length, tickets: resumed.map((t) => t.id) });
    }
    return resumed;
  }

  // --- Step execution with self-healing loop ---

  async runStepWithHealing(ticket, stepConfig, pipelineState, stepStartTime, callbacks) {
    const maxAttempts = 3; // original + 2 heal attempts
    const gateFailuresByAttempt = [];
    let lastMaxTurnsHit = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // PIPE-014: bail before re-spawning a heal attempt if the operator
      // hit Stop. SIGTERM killed the active child; without this check the
      // heal loop would treat the dead child as "attempt failed" and
      // spawn a fresh subprocess for attempt+1.
      if (this.stopRequested) {
        pipelineState.steps[stepConfig.name] = {
          ...pipelineState.steps[stepConfig.name],
          status: 'blocked',
          blocked_at: new Date().toISOString(),
          reason: 'user_stopped_via_api_stop',
        };
        await this.savePipelineJson(ticket.id, pipelineState);
        throw new Error('user_stopped_via_api_stop');
      }
      const isRetry = attempt > 1;

      // Snapshot git state before code-writing steps
      let gitSnapshotBefore = null;
      let canonicalSnapshotBefore = null;
      if (['implement', 'tests_red', 'docs_update'].includes(stepConfig.name)) {
        try {
          const tracked = execSync('git diff --name-only HEAD', { cwd: this.cwd, encoding: 'utf-8' }).trim();
          const untracked = execSync('git ls-files --others --exclude-standard', { cwd: this.cwd, encoding: 'utf-8' }).trim();
          gitSnapshotBefore = [tracked, untracked].filter(Boolean).join('\n');
        } catch { /* ignore */ }
        // Capture canonical project_dir snapshot too — used by PIPE-004
        // write-zone enforcement to detect canonical-project leaks (worker
        // edits the operator's primary checkout instead of the worktree).
        // Only relevant when worktree mode is active (cwd != project_dir).
        if (this.config.project_dir && this.config.project_dir !== this.cwd) {
          try {
            const tracked = execSync('git diff --name-only HEAD', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
            const untracked = execSync('git ls-files --others --exclude-standard', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
            canonicalSnapshotBefore = [tracked, untracked].filter(Boolean).join('\n');
          } catch { /* ignore */ }
        }
      }

      const attemptLabel = isRetry ? `heal-${attempt}` : 'run';

      // Track per-attempt tokens
      let attemptInputTokens = 0;
      let attemptOutputTokens = 0;
      let attemptToolCalls = 0;
      const attemptStartTime = Date.now();
      // Phase 5A: escalation ladder replaces the fixed Sonnet-on-every-heal
      // behaviour so heals climb capability (Haiku → Sonnet → Opus by
      // default). The step's explicit stepConfig.model is still honoured
      // for attempt 1; heals always walk the ladder.
      const ladder = this.config.restart?.escalation_ladder || ['haiku', 'sonnet', 'opus'];
      const attemptModel = pickAttemptModel(stepConfig, attempt, ladder);

      // Build and execute
      const built = isRetry
        ? { prompt: await this.buildHealPrompt(stepConfig, ticket, pipelineState, attempt), preloadedPaths: [] }
        : await buildPrompt(stepConfig, ticket, pipelineState, this.effectiveConfig());
      const prompt = built.prompt;
      const preloadedPaths = built.preloadedPaths;

      // Session-preservation escape hatch. Resuming the prior session helps
      // when the last attempt produced PARTIAL output that just needs
      // amending. It HURTS when the last attempt produced no substantive
      // output at all — Claude sees "I already wrote this" in the session
      // history and takes shortcuts (BUG-202: opus heal-3 ran 21s / 2 tools
      // / 918 out because the session context made it think the work was
      // done, when in fact every required field was undefined). When the
      // prior retry_reason indicates undefined/empty required fields, null
      // the session so the heal starts cold.
      if (isRetry) {
        const prevReason = (pipelineState.steps[stepConfig.name] || {}).retry_reason || '';
        if (/\bgot undefined\b|\bgot null\b|\bgot \[\]\b/.test(prevReason)) {
          this.sessionId = null;
        }
      }
      // Per-ticket step override: a ticket may declare
      //   step_overrides: { tests_red: { max_turns: 35 }, implement: { ... } }
      // in its backlog.json entry to override this step's defaults. Used
      // when a ticket is known to need more budget than the global config
      // (e.g. BUG-202's storage-quota scope spanning Dart + backend in a
      // single step). Falls back to stepConfig's value when absent.
      const override = (ticket.step_overrides || {})[stepConfig.name] || {};
      const effectiveMaxTurns = override.max_turns || stepConfig.max_turns || 30;
      const effectiveMaxSeconds = override.max_seconds || stepConfig.max_seconds || null;
      const result = await this.runWithRateLimitRetry(
        () => spawnClaude({
          prompt,
          model: attemptModel,
          tools: stepConfig.tools || [],
          maxTurns: effectiveMaxTurns,
          maxSeconds: effectiveMaxSeconds,
          onSpawn: (proc) => {
            this.activeSubprocess = proc;
            proc.on('close', () => {
              if (this.activeSubprocess === proc) this.activeSubprocess = null;
            });
          },
          effort: stepConfig.effort || null,
          systemPromptFile: (!isRetry && stepConfig.inject_validation_rules) ? this.config._resolved.validationRules : null,
          workingDir: this.cwd,
          // Preserve session across heal attempts so amendment cases don't
          // re-read spec files. Escape hatch above nulls sessionId when the
          // prior attempt produced no substantive output (undefined required
          // fields) — in that case a cold start beats a warm "I already
          // finished" session context.
          sessionId: this.sessionId,
          env: {
            ...(this.config.environment || {}),
            // Soft hook reads this to know which paths it should
            // discourage Re-Reads on. Empty string when nothing pre-loaded
            // so the hook becomes a no-op (also no-op for any other Claude
            // session running in this project, since they'd never see this
            // env var).
            PIPELINE_PRELOADED_FILES: preloadedPaths.join(','),
            // PreToolUse hook (state-write-protect.sh) reads this to deny
            // Write/Edit on the canonical state file path. Workers must
            // write their per-step output to PIPELINE_WORKER_OUT instead.
            // Both env vars empty/missing = no enforcement (hook no-ops),
            // so the user's other Claude sessions in the same project
            // are unaffected.
            PIPELINE_STATE_PROTECTED: this.config._resolved.pipelineDir,
            PIPELINE_WORKER_OUT: resolve(this.config._resolved.workerOutputDir, ticket.id),
          },
          onData: (event) => {
            const usage = event.message?.usage || event.usage;
            if (usage) {
              if (usage.input_tokens) { attemptInputTokens = usage.input_tokens; callbacks.onTokens({ input_tokens: usage.input_tokens }); }
              if (usage.output_tokens) { attemptOutputTokens += usage.output_tokens; callbacks.onTokens({ output_tokens: usage.output_tokens }); }
              if (usage.cache_read_input_tokens || usage.cache_creation_input_tokens || usage.modelUsage) {
                callbacks.onTokens({
                  cache_read_input_tokens: usage.cache_read_input_tokens,
                  cache_creation_input_tokens: usage.cache_creation_input_tokens,
                  modelUsage: usage.modelUsage,
                });
              }
            }
            // stream-json emits tool_use inside assistant messages, not as content_block_start
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_use') { attemptToolCalls++; callbacks.onToolCall(block.name); }
              }
            }
            this.emit('claude_event', { ticket: ticket.id, step: stepConfig.name, event });
          },
        }),
        ticket.id,
        stepConfig.name,
      );

      // Update rate limit info from runner result
      this.updateRateLimitInfo(result.rateLimitInfo);

      // Log per-attempt usage
      const maxTurnsHit = result.maxTurnsHit || false;
      const timedOut = result.timedOut || false;
      lastMaxTurnsHit = maxTurnsHit;
      if (maxTurnsHit) console.log(`[WARNING] ${ticket.id}/${stepConfig.name}: max turns (${effectiveMaxTurns}) reached`);
      if (timedOut) console.log(`[WARNING] ${ticket.id}/${stepConfig.name}: wall-clock budget (${stepConfig.max_seconds}s) exceeded`);
      console.log(`${logPrefix(this.getUsagePercent().percent)} [usage] ${ticket.id}/${stepConfig.name} (${attemptLabel}) | ${attemptModel} | ${formatDuration(Date.now() - attemptStartTime)} | ${attemptInputTokens.toLocaleString()} in / ${attemptOutputTokens.toLocaleString()} out | ${attemptToolCalls} tools${maxTurnsHit ? ' | MAX TURNS HIT' : ''}${timedOut ? ' | TIMEOUT' : ''}`);
      this.emit('step_attempt_done', { ticket: ticket.id, step: stepConfig.name, attempt, model: attemptModel, inputTokens: attemptInputTokens, outputTokens: attemptOutputTokens, toolCalls: attemptToolCalls, maxTurnsHit, timedOut });

      if (result.sessionId) this.sessionId = result.sessionId;
      // Orchestrator-only state writes (2026-04-27): ingest worker's per-step
      // output file, validate against schema, merge into canonical state.
      // Worker writes outside the schema (or to other steps' slots) are
      // silently dropped here — they never reach pipelineState.
      await this.ingestWorkerOutput(ticket.id, stepConfig.name, pipelineState);
      pipelineState = await this.reloadStepFromDisk(ticket.id, stepConfig.name, pipelineState);

      // Auto-populate files from git
      await this.autoPopulateFiles(stepConfig, pipelineState, ticket, gitSnapshotBefore, stepStartTime);
      pipelineState = await this.reloadStepFromDisk(ticket.id, stepConfig.name, pipelineState);

      // tests_red native verification: the LLM only authored the tests; the
      // orchestrator deterministically runs a scoped red-run (execSync) and
      // is the sole authority for outcome/failure_output. Runs before the
      // gate so validateStep sees the orchestrator-set fields.
      if (stepConfig.name === 'tests_red') {
        await this.verifyTestsRed(ticket, pipelineState);
        pipelineState = await this.reloadStepFromDisk(ticket.id, stepConfig.name, pipelineState);
      }

      // PIPE-004: write-zone enforcement. Catches two failure classes:
      //   1. Worktree-internal misroute (file inside worktree but outside
      //      step's allowed globs — e.g. docs_update touched app/lib/foo.dart).
      //   2. Canonical-project leak (worker edited operator's primary
      //      checkout instead of the worktree — the docs_update class of
      //      bug that produced weeks of memory/code_validation.md leaks
      //      before the 2026-05-03 busydad reorg).
      //
      // Off by default for backwards-compat. Enable per step in
      // pipeline.config.yaml with `write_zones: { mode: warn|strict, allow: [...] }`.
      // In strict mode a violation throws and the step fails; in warn mode
      // we only emit the event so the operator can see the leak in the
      // dashboard without halting the run.
      if (stepConfig.write_zones && stepConfig.write_zones.mode && stepConfig.write_zones.mode !== 'off') {
        const wzMode = stepConfig.write_zones.mode;
        const allow = stepConfig.write_zones.allow || [];
        const deny = stepConfig.write_zones.deny || [];
        const violations = checkWriteZones({
          worktreeCwd: this.cwd,
          canonicalProjectDir: this.config.project_dir,
          worktreeSnapshotBefore: gitSnapshotBefore,
          canonicalSnapshotBefore,
          allowGlobs: allow,
          denyGlobs: deny,
        });
        if (violations.length > 0) {
          this.emit('write_zone_violation', {
            ticket: ticket.id,
            step: stepConfig.name,
            mode: wzMode,
            violations,
          });
          console.warn(`[write-zones:${wzMode}] ${ticket.id}/${stepConfig.name}: ${violations.length} violation(s):\n${formatViolations(violations)}`);
          if (wzMode === 'strict') {
            throw new Error(`Step ${stepConfig.name} wrote outside configured zones (${violations.length} violation${violations.length === 1 ? '' : 's'}). See event log for paths.`);
          }
        }
      }

      // Validate
      const stepArtifacts = pipelineState.steps[stepConfig.name] || {};
      const planArtifacts = pipelineState.steps.plan || {};
      const validation = validateStep(stepArtifacts, stepConfig, planArtifacts);

      // Post-implement dependency check: every package imported by new/modified
      // source or test files must be declared in the project's manifest. Catches
      // the T-333-class bug where a planner introduces `fake_cloud_firestore`
      // imports but forgets to add it to pubspec.yaml, which load-errors every
      // subsequent ticket's tests_green run.
      if (stepConfig.name === 'implement') {
        try {
          const missing = this.checkDepsDeclared(stepArtifacts, planArtifacts);
          if (missing.length > 0) {
            validation.pass = false;
            validation.failures.push(
              `undeclared dependencies (${missing.length}): ${missing.map((m) => `${m.pkg} imported in ${m.file} but missing from ${m.manifest}`).join(' | ')}`,
            );
          }
        } catch (err) {
          console.warn(`[deps-check] skipped for ${ticket.id}: ${err.message}`);
        }
      }

      // PIPE-025: hard review gate — net-new behavioural logic with no test.
      if (stepConfig.name === 'review') {
        try {
          const uncovered = this.checkBehaviouralTestCoverage(pipelineState, ticket);
          if (uncovered.length > 0) {
            validation.pass = false;
            validation.failures.push(
              `[PIPE-025] net-new non-trivial pure-logic file(s) shipped with zero test coverage (hard fail, not subject to coverage shortfall escape valve): ${uncovered.join(', ')}`,
            );
          }
        } catch (err) {
          console.warn(`[pipe025] coverage check skipped for ${ticket.id}: ${err.message}`);
        }
      }

      this.emit('step_gate', {
        ticket: ticket.id,
        step: stepConfig.name,
        pass: validation.pass,
        failures: validation.failures,
        attempt,
      });

      if (validation.pass) {
        // Orchestrator owns step lifecycle. The schema gate (validateStep)
        // is the contract; if it passed, the step is done. The worker's
        // own `status` field is no longer trusted as input — heal cycles
        // routinely persist outputs that omit `status:"done"` (the worker
        // edits the failing fields and writes the file back without
        // re-asserting the lifecycle field), and the previous post-loop
        // guard would then block a ticket whose every gate had passed
        // (BUG-261 plan, BUG-261B plan, etc.).
        //
        // Exception: a worker-emitted `status === 'blocked'` is a deliberate
        // stop signal (the worker decided it can't proceed). Respect that
        // even on gate-pass — it falls through to the blocked-handler below.
        const cur = pipelineState.steps[stepConfig.name] || {};
        if (cur.status !== 'blocked') {
          cur.status = 'done';
          cur.completed_at = cur.completed_at || new Date().toISOString();
          pipelineState.steps[stepConfig.name] = cur;
          await this.savePipelineJson(ticket.id, pipelineState);
        }
        return { pipelineState, lastResult: result.result, attempts: attempt, maxTurnsHit: lastMaxTurnsHit, gateFailuresByAttempt };
      }
      // Remember the failures this attempt produced before deciding what to do next.
      gateFailuresByAttempt.push({ attempt, failures: validation.failures });

      // Blocked steps are intentional — don't heal
      if (stepArtifacts.status === 'blocked') {
        return { pipelineState, lastResult: result.result, attempts: attempt, maxTurnsHit: lastMaxTurnsHit, gateFailuresByAttempt };
      }

      // Review with findings = feedback loop, not self-heal.
      // Return to processTicket which handles the review→implement cycle.
      if (stepConfig.name === 'review' && Array.isArray(stepArtifacts.findings) && stepArtifacts.findings.length > 0) {
        // Ensure status is 'blocked' so the feedback loop picks it up
        pipelineState.steps.review.status = 'blocked';
        await this.savePipelineJson(ticket.id, pipelineState);
        return { pipelineState, lastResult: result.result, attempts: attempt, maxTurnsHit: lastMaxTurnsHit, gateFailuresByAttempt };
      }

      // Non-convergence is not healable. If the LLM burned its turn budget
      // or exceeded the wall-clock budget, spawning another attempt with
      // the same budget reliably reproduces the non-result. Fail fast,
      // rewind via checkpoints if enabled, surface to human.
      const healDecision = shouldHeal({ maxTurnsHit, timedOut, toolCalls: attemptToolCalls });
      if (!healDecision.shouldHeal) {
        const reasonByCode = {
          timeout: `wall-clock budget (${effectiveMaxSeconds}s) exceeded — step did not converge`,
          max_turns: `max turns (${effectiveMaxTurns}) hit — step did not converge`,
          no_tool_calls: `max turns hit with 0 tool calls — step could not execute`,
        };
        const reason = reasonByCode[healDecision.reason] || `heal refused (${healDecision.reason})`;
        pipelineState.steps[stepConfig.name] = {
          ...pipelineState.steps[stepConfig.name],
          status: 'crashed',
          crashed_at: new Date().toISOString(),
          reason,
        };
        await this.savePipelineJson(ticket.id, pipelineState);
        this.emit('step_gate_failed', { ticket: ticket.id, step: stepConfig.name, failures: [reason], attempts: attempt });
        console.error(`[skip-heal] ${ticket.id}/${stepConfig.name}: ${reason}`);

        // Rewind to the previous snapshot so partial work doesn't leak.
        if (this.config.checkpoints?.enabled) {
          try {
            revertToBaseline(ticket.id, this.cwd, { workerOutputDir: `${this.config._resolved.workerOutputDir}/${ticket.id}` });
            this.emit('checkpoint_reverted', { ticket: ticket.id, step: stepConfig.name });
          } catch (err) {
            console.warn(`[checkpoint] ${ticket.id}/${stepConfig.name}: revert failed — ${err.message}`);
          }
        }
        throw new Error(`Step failed for ${ticket.id}/${stepConfig.name}: ${reason}`);
      }

      // Last attempt — no more retries
      if (attempt === maxAttempts) {
        const stepStatus = stepArtifacts.status;
        if (!stepStatus || stepStatus === 'pending') {
          pipelineState.steps[stepConfig.name] = {
            ...pipelineState.steps[stepConfig.name],
            status: 'crashed',
            crashed_at: new Date().toISOString(),
            reason: `failed gate after ${maxAttempts} attempts: ${validation.failures.join(', ')}`,
          };
          await this.savePipelineJson(ticket.id, pipelineState);
        }

        this.emit('step_gate_failed', { ticket: ticket.id, step: stepConfig.name, failures: validation.failures, attempts: maxAttempts });
        console.error(`Gate failed for ${ticket.id}/${stepConfig.name} after ${maxAttempts} attempts:`, validation.failures);

        // META-001 Phase 3: rewind the working tree to the previous step's
        // snapshot so the failed step's partial work doesn't leak onto disk.
        // If no prior snapshot exists (first step failed), resets to branch
        // base (= master tip at ticket start).
        if (this.config.checkpoints?.enabled) {
          try {
            revertToBaseline(ticket.id, this.cwd, { workerOutputDir: `${this.config._resolved.workerOutputDir}/${ticket.id}` });
            this.emit('checkpoint_reverted', { ticket: ticket.id, step: stepConfig.name });
            console.log(`[checkpoint] ${ticket.id}/${stepConfig.name}: working tree reverted to last snapshot`);
          } catch (err) {
            console.warn(`[checkpoint] ${ticket.id}/${stepConfig.name}: revert failed — ${err.message}`);
          }
        }

        throw new Error(`Gate failed for ${ticket.id}/${stepConfig.name}: ${validation.failures.join(', ')}`);
      }

      // Prepare for heal attempt
      this.emit('self_heal_start', { ticket: ticket.id, step: stepConfig.name, attempt: attempt + 1, failures: validation.failures });
      console.log(`[self-heal] ${ticket.id}/${stepConfig.name}: attempt ${attempt + 1}/${maxAttempts} — fixing: ${validation.failures.join('; ')}`);

      // Reset step for retry
      pipelineState.steps[stepConfig.name] = {
        status: 'pending',
        retried_at: new Date().toISOString(),
        retry_reason: validation.failures.join('; '),
        _healAttempt: attempt + 1,
        _maxTurnsHit: maxTurnsHit,
      };
      await this.savePipelineJson(ticket.id, pipelineState);
      // Keep this.sessionId — heal attempt will resume the same session so
      // it has the previous attempt's context. Cross-phase boundaries still
      // null sessionId elsewhere (per architecture rationale: fresh view per
      // phase). Within a step's heal loop, staying in the session is what
      // lets us land small fixes without re-doing discovery.
    }

    return { pipelineState };
  }

  async buildHealPrompt(stepConfig, ticket, pipelineState, attempt) {
    const prevStep = pipelineState.steps[stepConfig.name] || {};
    const pipelineJsonPath = resolve(this.config._resolved.pipelineDir, `${ticket.id}.json`);

    // When the previous attempt hit max turns, the work may already be done —
    // Claude just ran out of turns before writing the pipeline JSON.
    // Give a focused "assess and record" prompt instead of the full step instructions.
    if (prevStep._maxTurnsHit) {
      return `Ticket ${ticket.id}: "${ticket.title}"
The previous "${stepConfig.name}" step ran out of turns before writing results to the pipeline JSON.
The work may already be partially or fully done.

YOUR ONLY JOB: assess what was accomplished and write the pipeline JSON. Do NOT redo work.

PIPELINE JSON PATH: ${pipelineJsonPath}

STEPS:
1. Read ${pipelineJsonPath} to see current state
2. Check git diff and git status for changes the previous attempt made
3. If tests were written/modified, run them to capture output
4. Update steps.${stepConfig.name} in the pipeline JSON with ALL required fields:
${this.getRequiredFieldsDescription(stepConfig)}
5. Set status = "done" (or "blocked" with reason if work could not be completed)

RULES:
- Do NOT write new code or modify source files
- Do NOT re-run the full test suite unless you need failure output
- Focus: read state → determine outcome → write JSON → stop`;
    }

    // Standard heal: gate validation failed (wrong values, not missing values)
    const originalPrompt = (await buildPrompt(stepConfig, ticket, pipelineState, this.effectiveConfig())).prompt;

    return `You are RETRYING the "${stepConfig.name}" step for ticket ${ticket.id}: "${ticket.title}".

PREVIOUS ATTEMPT FAILED. Reason: ${prevStep.retry_reason || 'unknown'}
This is attempt ${attempt} — the previous run did not complete the step correctly.

PIPELINE JSON PATH: ${pipelineJsonPath}

CRITICAL: The previous attempt failed because the pipeline JSON was not updated with the required fields. You MUST write the pipeline JSON file with ALL required fields before doing anything else. Read the original instructions below carefully.

ORIGINAL STEP INSTRUCTIONS:
${originalPrompt}

PRIORITY: Write the pipeline JSON FIRST, then investigate. Do not spend turns reading code without writing output.`;
  }

  getRequiredFieldsDescription(stepConfig) {
    if (!stepConfig.validation) return '   (see step instructions for required fields)';
    return stepConfig.validation.map(v => {
      if (v.rule === 'one_of') return `   - ${v.field}: one of [${v.values.join(', ')}]`;
      if (v.rule === 'non_empty_string') return `   - ${v.field}: non-empty string${v.unless ? ` (unless ${v.unless.field} = ${v.unless.equals})` : ''}`;
      if (v.rule === 'non_empty_array') return `   - ${v.field}: non-empty array`;
      if (v.rule === 'equals') return `   - ${v.field}: must be ${v.value}`;
      if (v.rule === 'greater_than') return `   - ${v.field}: > ${v.value || 0}`;
      return `   - ${v.field}: ${v.rule}`;
    }).join('\n');
  }

  async autoPopulateFiles(stepConfig, pipelineState, ticket, gitSnapshotBefore, stepStartTime) {
    if (!['implement', 'docs_update'].includes(stepConfig.name) || gitSnapshotBefore === null) return;

    const fieldName = stepConfig.name === 'implement' ? 'files_changed' : 'files_updated';
    const step = pipelineState.steps[stepConfig.name] || {};
    if (step[fieldName] && Array.isArray(step[fieldName]) && step[fieldName].length > 0) return;

    try {
      const trackedNow = execSync('git diff --name-only HEAD', { cwd: this.cwd, encoding: 'utf-8' }).trim();
      const untrackedNow = execSync('git ls-files --others --exclude-standard', { cwd: this.cwd, encoding: 'utf-8' }).trim();
      const allDirty = [trackedNow, untrackedNow].filter(Boolean).join('\n').split('\n').filter(Boolean);

      const beforeSet = new Set(gitSnapshotBefore ? gitSnapshotBefore.split('\n') : []);
      const newFiles = allDirty.filter((f) => !beforeSet.has(f));
      const editedFiles = allDirty.filter((f) => {
        if (newFiles.includes(f)) return false;
        try { return statSync(resolve(this.cwd, f)).mtimeMs >= stepStartTime; } catch { return false; }
      });

      const touchedFiles = [...newFiles, ...editedFiles];
      if (touchedFiles.length > 0) {
        step[fieldName] = touchedFiles.map((path) => ({ path, summary: 'auto-detected' }));
        // Promote pending OR missing-status to 'done'. Missing status means
        // Claude wrote step artifacts but no top-level status field (e.g.
        // docs_update frequently writes {files_updated, metrics:{status:'done'}}
        // but forgets the outer status). Without this clause the post-loop
        // check (pipeline.js:~762) flags the step as incomplete and blocks
        // a ticket whose work is actually done.
        if (step.status === 'pending' || step.status == null) step.status = 'done';
        step.completed_at = step.completed_at || new Date().toISOString();
        step.auto_populated = true;
        pipelineState.steps[stepConfig.name] = step;
        await this.savePipelineJson(ticket.id, pipelineState);
        this.emit('auto_populate', { ticket: ticket.id, step: stepConfig.name, files: touchedFiles });
      }
    } catch { /* ignore */ }
  }

  // --- Self-healing: fix gate failures with LLM ---

  async selfHeal(ticket, stepConfig, pipelineState, failures) {
    // Don't self-heal blocked steps — those are intentional
    if (pipelineState.steps[stepConfig.name]?.status === 'blocked') return false;
    // Don't self-heal if already healed once this step
    if (pipelineState.steps[stepConfig.name]?._selfHealed) return false;

    this.emit('self_heal_start', { ticket: ticket.id, step: stepConfig.name, failures });
    console.log(`[self-heal] ${ticket.id}/${stepConfig.name}: attempting fix for ${failures.length} gate failures`);

    const workerOut = resolve(this.config._resolved.workerOutputDir, ticket.id, `${stepConfig.name}.json`);
    const healPrompt = `The pipeline step "${stepConfig.name}" for ticket ${ticket.id} ("${ticket.title}") completed but FAILED its gate validation.

GATE FAILURES:
${failures.map((f, i) => `${i + 1}. ${f}`).join('\n')}

CURRENT STEP STATE (this step's slot only — do NOT speculate about other steps):
${JSON.stringify(pipelineState.steps?.[stepConfig.name] || {}, null, 2)}

YOUR OUTPUT FILE: ${workerOut}

YOUR TASK:
1. Understand what fields are missing or wrong from the gate failures.
2. If the step actually did work (check git diff, read modified files) but just forgot to populate fields — fill them in from what you can observe.
3. If the step didn't complete its work — do the work (read files, check state) and update.
4. Write the corrected step output as a flat JSON object (this step's fields only) to YOUR OUTPUT FILE.

The orchestrator validates your output against a per-step schema. Fields outside the schema are dropped silently. DO NOT attempt to set state for other steps — only this step's slot.

IMPORTANT: Only fix what the gate requires. Do not re-run the entire step. Focus on the specific failures listed above.`;

    try {
      const result = await this.runWithRateLimitRetry(
        () => spawnClaude({
          prompt: healPrompt,
          model: 'opus',
          tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(git *)'],
          maxTurns: 15,
          workingDir: this.cwd,
          sessionId: null,
          env: this.config.environment || {},
          onData: (event) => {
            this.emit('claude_event', { ticket: ticket.id, step: `${stepConfig.name}_heal`, event });
          },
        }),
        ticket.id,
        `${stepConfig.name}_heal`,
      );

      // Ingest the heal worker's output into canonical state through the
      // schema gate (same as a normal step run). Then stamp _selfHealed on
      // the step so the gate doesn't loop forever.
      const updated = await this.loadPipelineJson(ticket.id);
      if (updated) {
        await this.ingestWorkerOutput(ticket.id, stepConfig.name, updated);
        const refreshed = await this.loadPipelineJson(ticket.id);
        if (refreshed?.steps?.[stepConfig.name]) {
          refreshed.steps[stepConfig.name]._selfHealed = true;
          await this.savePipelineJson(ticket.id, refreshed);
        }
      }

      this.emit('self_heal_done', { ticket: ticket.id, step: stepConfig.name });
      console.log(`[self-heal] ${ticket.id}/${stepConfig.name}: fix attempted`);
      return true;
    } catch (err) {
      if (err.rateLimited) throw err; // let pipeline handle rate limits
      this.emit('self_heal_error', { ticket: ticket.id, step: stepConfig.name, error: err.message });
      console.error(`[self-heal] ${ticket.id}/${stepConfig.name}: failed — ${err.message}`);
      return false;
    }
  }

  // --- Mechanical docs: scripted updates that don't need LLM ---

  async mechanicalDocsUpdate(ticket, pipelineState) {
    const projectDir = this.cwd;

    // 1. Append to closed-bugs.json (bugs only)
    if (ticket.type?.includes('bug')) {
      try {
        const closedPath = resolve(projectDir, this.config.closed_bugs_file || 'memory/closed-bugs.json');
        const raw = await readFile(closedPath, 'utf-8');
        const closed = JSON.parse(raw);
        const tickets = closed.tickets || [];

        // Skip if already added
        if (!tickets.find(t => t.id === ticket.id)) {
          const rootCause = pipelineState.steps.root_cause || {};
          const implFiles = (pipelineState.steps.implement?.files_changed || [])
            .map(f => typeof f === 'object' ? f.path : f).join(', ');
          tickets.unshift({
            id: ticket.id,
            title: ticket.title,
            status: 'done',
            reported: ticket.added || new Date().toISOString().split('T')[0],
            closed: new Date().toISOString().split('T')[0],
            area: ticket.area || '',
            fix: `${rootCause.why_happened || ''} Files: ${implFiles}`.trim(),
            complexity: ticket.complexity || 'medium',
          });
          closed.tickets = tickets;
          await writeFile(closedPath, JSON.stringify(closed, null, 2));
          this.emit('mechanical_docs', { ticket: ticket.id, file: 'closed-bugs.json' });
        }
      } catch (err) {
        console.error(`[mechanical-docs] closed-bugs.json failed: ${err.message}`);
      }
    }

    // 2026-04-28: build-log/{date}.md write removed. The CLAUDE.md rule
    // that justified writing it (rule 23 + 23b "weekly retrospective")
    // never actually fired — no retrospective was ever produced in the
    // entire project life. Writing was overhead with no reader. usage.jsonl
    // (token tracking) is unaffected — that lives in appendUsageLog.
  }

  // --- Shared test-suite runner: used by baseline capture and tests_green ---

  // Runs unit + analyzer + extras and parses the output. Returns the raw
  // failure data without any baseline comparison or step-result framing —
  // callers decide what to do with it. Extracted so baseline capture and
  // tests_green don't duplicate the test-harness plumbing.
  //
  // runAllExtras=true unconditionally runs every configured extras phase
  // (used for baseline, where we don't yet know which phases this ticket
  // will trigger). runAllExtras=false keeps the trigger_file_prefix filter
  // driven by the current implement files_changed.
  // logContext: { ticketId, attempt } — when provided, the full per-phase
  // output is persisted to worker-output/{ticketId}/tests_green-{phase}-attempt{N}.log.
  // 2026-05-19: added after T-026 was undiagnosable post-mortem because only
  // the last 5/8 lines per phase were retained. Files are cleaned up on
  // successful ticket commit; failed tickets keep them for forensics.
  async runTestSuite(pipelineState, { runAllExtras = false, logContext = null } = {}) {
    const projectDir = this.cwd;
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.config.environment || {})) {
      env[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
    }

    const profile = this.config.project_profile || {};
    const tc = profile.test_commands || {};

    const runPhase = (spec) => {
      if (!spec) return { output: '', exitCode: 0, skipped: true };
      const cwd = spec.cwd ? resolve(projectDir, spec.cwd) : projectDir;
      const timeout = (spec.timeout_sec || 600) * 1000; // default 10 min — test suites can be slow
      try {
        const out = execSync(`${spec.cmd} 2>&1`, { cwd, encoding: 'utf-8', env, timeout, maxBuffer: 50 * 1024 * 1024 });
        return { output: out, exitCode: 0, skipped: false };
      } catch (err) {
        return { output: err.stdout || err.message, exitCode: err.status || 1, skipped: false };
      }
    };

    // Sync dependencies when a manifest changed in implement. A pubspec /
    // package.json edit doesn't take effect until pub get / npm install
    // refreshes the lockfile + resolved packages. Without this, tests fail
    // with "uri doesn't exist" even though the dep is declared.
    await this.syncDepsIfManifestChanged(pipelineState, projectDir, env);

    // --- Analyzer first (fast-fail gate on compile errors) ---
    // Running ~30s of analyzer before the 2–5 min unit suite lets us skip
    // the slow phase when the code doesn't compile — heal then sees only
    // compile errors, not a pile of cascading test failures. For baseline
    // (runAllExtras=true) we always continue so the full picture is captured.
    let analyzeOutput = '';
    let analyzerErrors = 0;
    if (tc.analyzer) {
      console.log(`[test-suite] Running analyzer (${tc.analyzer.cmd})...`);
      analyzeOutput = runPhase(tc.analyzer).output;
      const ok = tc.analyzer.success_marker || 'No issues found';
      if (analyzeOutput.includes(ok)) {
        analyzerErrors = 0;
      } else {
        const issueRe = tc.analyzer.issue_pattern ? new RegExp(tc.analyzer.issue_pattern) : /(\d+)\s+issue/;
        const m = analyzeOutput.match(issueRe);
        analyzerErrors = m ? parseInt(m[1]) : (analyzeOutput.includes('error') ? 1 : 0);
      }
    }

    const baselineAnalyzerErrors = pipelineState.baseline_analyzer_errors || 0;
    const newAnalyzerErrors = Math.max(0, analyzerErrors - baselineAnalyzerErrors);
    const skipUnitForCompileErrors = !runAllExtras && newAnalyzerErrors > 0;

    if (skipUnitForCompileErrors) {
      console.log(`[test-suite] Skipping unit tests — ${newAnalyzerErrors} new analyzer errors (vs baseline ${baselineAnalyzerErrors}). Heal should fix compile errors first.`);
      return {
        passed: 0, failed: 0, failedTests: [],
        unitCrashed: false, unitExitCode: 0, unitRanNothing: false, unitSkipped: true,
        analyzerErrors, analyzeOutput,
        extraFailures: [], extraOutput: '',
        testOutput: '',
        skippedDueToCompileErrors: true,
      };
    }

    // --- Unit tests ---
    if (!tc.unit) {
      console.warn(`[test-suite] WARNING: project_profile.test_commands.unit is not configured — no unit tests will run.`);
    } else {
      console.log(`[test-suite] Running unit tests (${tc.unit.cmd})...`);
    }
    const { output: testOutput, exitCode: unitExitCode, skipped: unitSkipped } = runPhase(tc.unit);
    if (logContext && !unitSkipped) this._writePhaseLog(logContext, 'unit', testOutput);

    let passed = 0, failed = 0;
    const statsRe = tc.unit?.stats_pattern ? new RegExp(tc.unit.stats_pattern, 'g') : /\+(\d+)\s+-(\d+):\s/g;
    const matches = [...testOutput.matchAll(statsRe)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      passed = parseInt(last[1] || '0');
      failed = parseInt(last[2] || '0');
    }

    const failedTests = [];
    const failRe = tc.unit?.failed_name_pattern ? new RegExp(tc.unit.failed_name_pattern) : /:\s+(.+?)\s+\[E\]/;
    const failLineMarker = tc.unit?.failed_line_marker || '[E]';
    for (const line of testOutput.split('\n')) {
      if (line.includes(failLineMarker) && line.includes(':')) {
        const m = line.match(failRe);
        if (m) failedTests.push(m[1].trim());
      }
    }

    // `flutter test <dir>` exits 1 with this exact text when the path has
    // zero tests. That is not a crash and not a regression — a directory
    // with no tests introduced no new failures. Distinguish it by the
    // explicit sentinel so the genuine-crash guard below stays strict.
    const unitNoTests = !unitSkipped && unitExitCode !== 0 && matches.length === 0
      && /No tests ran\.|No tests were found\.?/i.test(testOutput);
    // Silent failure: non-zero exit with no parseable stats ⇒ the runner
    // crashed before producing a summary. Don't let that slip through as
    // a green pass.
    const unitCrashed = !unitSkipped && unitExitCode !== 0 && matches.length === 0 && !unitNoTests;
    // Suspicious: ran unit but saw zero tests total (command ran but no
    // results). Common cause: wrong cwd, wrong test path, empty glob.
    const unitRanNothing = !unitSkipped && matches.length === 0 && !unitCrashed && !unitNoTests;

    // --- Extras (e.g. backend, integration) ---
    const implFiles = pipelineState.steps?.implement?.files_changed || [];
    const implPaths = implFiles.map((f) => (typeof f === 'object' ? f.path : f));
    let extraOutput = '';
    const extraFailures = [];
    for (const [phase, spec] of Object.entries(tc.extras || {})) {
      const prefix = spec.trigger_file_prefix;
      if (!runAllExtras && prefix && !implPaths.some((p) => p.startsWith(prefix))) continue;
      console.log(`[test-suite] Running ${phase} (${spec.cmd})...`);
      const r = runPhase(spec);
      if (logContext) this._writePhaseLog(logContext, phase, r.output);
      // Keep per-phase tail in the summary (don't truncate after concat).
      const phaseTail = r.output.split('\n').slice(-8).join('\n');
      extraOutput += `--- ${phase} (exit ${r.exitCode}) ---\n${phaseTail}\n`;
      if (r.exitCode !== 0) extraFailures.push({ phase, exitCode: r.exitCode });
    }

    return {
      passed, failed, failedTests, unitCrashed, unitExitCode, unitRanNothing, unitNoTests, unitSkipped,
      analyzerErrors, analyzeOutput,
      extraFailures, extraOutput,
      testOutput,
      skippedDueToCompileErrors: false,
    };
  }

  // --- tests_red native verification (PIPE 2026-05-19) ---
  //
  // tests_red used to be an LLM worker with Bash(flutter*)/Bash(npm*): it
  // wrote the tests AND ran the whole suite itself, reasoning over raw
  // output to self-report `outcome`/`failure_output`. Measured: 52% of its
  // tool calls were re-exploring the codebase, only 19% writing tests, and
  // it ran the FULL (O(n)-growing) suite — incl. 25% that re-ran + healed,
  // one ticket 40min. tests_green/captureBaseline already run natively via
  // execSync; tests_red was the lone LLM-runs-tests outlier.
  //
  // New split (operator directive): the LLM only AUTHORS tests (no Bash);
  // the orchestrator deterministically runs a FOCUSED command — scoped to
  // just the test files the step wrote — to prove they're red, and is the
  // sole authority for outcome/failure_output. All test EXECUTION is a
  // tool (execSync), never an LLM. Whole-suite stays tests_green's job.
  //
  // Requires per-command `scoped_cmd` in project_profile.test_commands with
  // a {files} placeholder. Absent → fall back to the legacy LLM-reported
  // outcome (no behaviour change for unconfigured projects).
  async verifyTestsRed(ticket, pipelineState) {
    const step = pipelineState.steps.tests_red || {};
    const projectDir = this.cwd;
    const profile = this.config.project_profile || {};
    const tc = profile.test_commands || {};
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.config.environment || {})) {
      env[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
    }

    // Source of truth for "what tests_red wrote" = test-path files dirty in
    // the worktree (not the LLM self-report, which can drift). Fall back to
    // the LLM's test_files only if git inspection finds nothing.
    let writtenTests = [];
    try {
      const tracked = execSync('git diff --name-only HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: projectDir, encoding: 'utf-8' }).trim();
      writtenTests = [tracked, untracked].filter(Boolean).join('\n').split('\n')
        .filter(Boolean).filter((p) => isTestPath(p));
    } catch { /* not a git repo — fall through */ }
    if (writtenTests.length === 0) {
      writtenTests = (step.test_files || [])
        .map((f) => (typeof f === 'object' ? f.path : f))
        .filter((p) => p && isTestPath(p));
    }

    if (writtenTests.length === 0) {
      step.outcome = 'tests_red_no_tests_written';
      step.failure_output = 'tests_red wrote no test files (no test-path changes in the worktree).';
      pipelineState.steps.tests_red = step;
      await this.savePipelineJson(ticket.id, pipelineState);
      this.emit('tests_red_verified', { ticket: ticket.id, outcome: step.outcome, scopedFiles: 0 });
      return;
    }

    // Route each written test to the test_command whose cwd contains it,
    // then build a scoped command via that command's scoped_cmd template.
    const commands = [];
    if (tc.unit) commands.push({ name: 'unit', spec: tc.unit });
    for (const [phase, spec] of Object.entries(tc.extras || {})) commands.push({ name: phase, spec });

    const groups = new Map(); // cmdName -> { spec, relFiles[] }
    for (const tf of writtenTests) {
      let chosen = null;
      for (const c of commands) {
        const prefix = c.spec.trigger_file_prefix || (c.spec.cwd ? `${c.spec.cwd}/` : '');
        if (prefix && tf.startsWith(prefix)) { chosen = c; break; }
      }
      if (!chosen) chosen = commands.find((c) => c.name === 'unit') || commands[0];
      if (!chosen) continue;
      const cwdAbs = chosen.spec.cwd ? resolve(projectDir, chosen.spec.cwd) : projectDir;
      const rel = chosen.spec.cwd && tf.startsWith(`${chosen.spec.cwd}/`)
        ? tf.slice(chosen.spec.cwd.length + 1)
        : tf;
      if (!groups.has(chosen.name)) groups.set(chosen.name, { spec: chosen.spec, cwdAbs, relFiles: [] });
      groups.get(chosen.name).relFiles.push(rel);
    }

    let anyFailed = false;
    let anyRan = false;
    const outputs = [];
    let usedScoped = false;

    for (const [name, g] of groups) {
      if (!g.spec.scoped_cmd) {
        outputs.push(`--- ${name}: no scoped_cmd configured; skipped (configure project_profile.test_commands.${name}.scoped_cmd) ---`);
        continue;
      }
      usedScoped = true;
      const cmd = g.spec.scoped_cmd.replace('{files}', g.relFiles.join(' '));
      const timeout = (g.spec.timeout_sec || 300) * 1000;
      console.log(`[tests-red] ${ticket.id}: scoped red-run (${name}): ${cmd}`);
      let out = '', exitCode = 0;
      try {
        out = execSync(`${cmd} 2>&1`, { cwd: g.cwdAbs, encoding: 'utf-8', env, timeout, maxBuffer: 50 * 1024 * 1024 });
      } catch (err) {
        out = err.stdout || err.message || '';
        exitCode = err.status || 1;
      }
      anyRan = true;
      // Parse pass/fail with the SAME patterns runTestSuite uses so a
      // failing assertion is distinguished from a clean pass.
      const statsRe = g.spec.stats_pattern ? new RegExp(g.spec.stats_pattern, 'g') : /\+(\d+)\s+-(\d+):\s/g;
      const m = [...out.matchAll(statsRe)];
      let failed = 0;
      if (m.length) failed = parseInt(m[m.length - 1][2] || '0');
      const groupFailed = failed > 0 || exitCode !== 0;
      if (groupFailed) anyFailed = true;
      outputs.push(`--- ${name} (exit ${exitCode}, parsed failures ${failed}) ---\n${out.split('\n').slice(-25).join('\n')}`);
    }

    if (!usedScoped) {
      // No scoped_cmd anywhere → keep the LLM-reported outcome (legacy
      // behaviour for unconfigured projects). Don't overwrite.
      this.emit('tests_red_verified', { ticket: ticket.id, outcome: step.outcome || '(llm)', scopedFiles: writtenTests.length, scoped: false });
      return;
    }

    if (anyFailed) {
      step.outcome = 'new_test_fails';
      step.failure_output = outputs.join('\n').slice(0, 8000);
    } else if (anyRan) {
      // Tests ran and ALL passed with no implementation present — they are
      // not actually red (vacuous, or assert already-implemented behaviour).
      // Not in the gate's accepted one_of → step fails → heal rewrites them.
      step.outcome = 'tests_red_did_not_fail';
      step.failure_output = `Scoped red-run: written tests PASSED with no implementation — not a valid RED.\n${outputs.join('\n').slice(0, 6000)}`;
    } else {
      step.outcome = 'tests_red_run_broken';
      step.failure_output = `Scoped red-run produced no parseable result.\n${outputs.join('\n').slice(0, 6000)}`;
    }
    step.tests_red_native_verified = true;
    pipelineState.steps.tests_red = step;
    await this.savePipelineJson(ticket.id, pipelineState);
    this.emit('tests_red_verified', {
      ticket: ticket.id, outcome: step.outcome,
      scopedFiles: writtenTests.length, groups: [...groups.keys()], scoped: true,
    });
  }

  // --- Baseline capture: runs at ticket start, records preexisting failures ---

  // Without this, tests_green has no honest way to tell "failure I introduced"
  // from "failure that was already on disk". The LLM-authored tests_red
  // baseline was unreliable — captured the wrong test suite, never refreshed
  // on crash recovery, left every preexisting red test to be healed by later
  // tickets. Deterministic capture here is the single change that stops that.
  async captureBaseline(ticket, pipelineState) {
    if (pipelineState.baseline_captured_at) return; // already captured; survives crash recovery
    const start = Date.now();
    this.emit('baseline_capture_start', { ticket: ticket.id });
    console.log(`[baseline] ${ticket.id}: capturing test failures before any changes...`);

    const res = await this.runTestSuite(pipelineState, { runAllExtras: true });

    pipelineState.baseline_failures = res.failedTests;
    pipelineState.baseline_analyzer_errors = res.analyzerErrors;
    pipelineState.baseline_extra_failures = res.extraFailures.map((e) => e.phase);
    pipelineState.baseline_captured_at = new Date().toISOString();
    await this.savePipelineJson(ticket.id, pipelineState);

    const durMs = Date.now() - start;
    console.log(`[baseline] ${ticket.id}: ${res.failedTests.length} failing tests, ${res.analyzerErrors} analyzer errors, ${res.extraFailures.length} extras failing — captured in ${formatDuration(durMs)}`);
    this.emit('baseline_captured', {
      ticket: ticket.id,
      failingTestCount: res.failedTests.length,
      analyzerErrors: res.analyzerErrors,
      extraFailureCount: res.extraFailures.length,
      durationMs: durMs,
    });
  }

  // --- tests_green: compare current failures against baseline ---

  // Helper: write the full per-phase test output to a per-attempt log file
  // under worker-output/{ticketId}/. Per-attempt (not overwritten) so heal-N
  // can be diffed against heal-0 — that's the T-027 self-heal-regression
  // pattern. Files are cleaned up only on successful ticket commit.
  _writePhaseLog({ ticketId, attempt }, phase, output) {
    try {
      const dir = resolve(this.config._resolved.workerOutputDir, ticketId);
      if (!existsSync(dir)) return; // worker-output dir created elsewhere; don't compete
      const file = resolve(dir, `tests_green-${phase}-attempt${attempt}.log`);
      // synchronous: keep ordering deterministic and avoid drowning on parallel phases
      // (small file, written once per phase per attempt)
      writeFileSync(file, String(output ?? ''));
    } catch (err) {
      console.warn(`[tests_green] failed to persist log for ${phase} attempt${attempt}: ${err.message}`);
    }
  }

  async runTestsGreen(ticket, pipelineState, healAttempt = 0) {
    // Prefer the deterministic baseline captured at ticket start. Fall back
    // to the legacy LLM-authored tests_red.baseline_failures for older
    // pipeline JSONs that predate baseline_capture.
    const baseline = pipelineState.baseline_failures
      || pipelineState.steps.tests_red?.baseline_failures
      || [];
    const baselineExtras = new Set(pipelineState.baseline_extra_failures || []);

    this.emit('tests_green_run', { ticket: ticket.id, phase: 'unit_tests' });
    const res = await this.runTestSuite(pipelineState, {
      runAllExtras: false,
      logContext: { ticketId: ticket.id, attempt: healAttempt },
    });
    this.emit('tests_green_run', { ticket: ticket.id, phase: 'analyzer' });

    const baselineSet = new Set(baseline);
    const newFailedTests = res.failedTests.filter((t) => !baselineSet.has(t));
    const newFailures = newFailedTests.length;

    // An extras phase that was already failing at baseline isn't this
    // ticket's fault — only count newly-broken phases.
    const newExtraFailures = res.extraFailures.filter((e) => !baselineExtras.has(e.phase));

    // Analyzer gate: new compile errors vs baseline count as a failure even
    // if the test suite was skipped. This is the analyzer-first fast-fail
    // path in runTestSuite — unit tests are useless while code won't compile.
    const baselineAnalyzerErrors = pipelineState.baseline_analyzer_errors || 0;
    const newAnalyzerErrors = Math.max(0, res.analyzerErrors - baselineAnalyzerErrors);

    if (res.unitCrashed) {
      console.error(`[tests_green] unit runner crashed (exit ${res.unitExitCode}) with no parseable stats. Output head: ${res.testOutput.slice(0, 500)}`);
    }
    if (res.unitRanNothing) {
      console.warn(`[tests_green] WARNING: unit command produced no stats — check cmd/cwd. exit=${res.unitExitCode}. Tail: ${res.testOutput.slice(-500)}`);
    }
    if (res.unitNoTests) {
      console.log(`[tests_green] unit path has zero tests (flutter exit ${res.unitExitCode}, "No tests were found") — benign, 0 new failures.`);
    }

    const testsActuallyRan = !res.unitRanNothing && !res.skippedDueToCompileErrors;
    const failed_ = !testsActuallyRan || (newFailures > 0) || res.unitCrashed || newExtraFailures.length > 0 || newAnalyzerErrors > 0;
    const step = {
      status: failed_ ? 'failed' : 'done',
      completed_at: new Date().toISOString(),
      all_pass: testsActuallyRan && newFailures === 0 && !res.unitCrashed && newExtraFailures.length === 0 && newAnalyzerErrors === 0,
      unit_tests: { passed: res.passed, failed: res.failed, skipped: 0 },
      unit_crashed: res.unitCrashed,
      unit_exit_code: res.unitExitCode,
      unit_ran_nothing: res.unitRanNothing,
      unit_no_tests: res.unitNoTests || false,
      unit_skipped_compile_errors: res.skippedDueToCompileErrors || false,
      analyzer_errors: res.analyzerErrors,
      new_analyzer_errors: newAnalyzerErrors,
      failed_tests: res.failedTests,
      new_failed_tests: newFailedTests,
      baseline_failures: baseline,
      new_failures: newFailures,
      extra_failures: res.extraFailures,
      new_extra_failures: newExtraFailures,
      test_output_summary: res.testOutput.split('\n').slice(-5).join('\n').trim(),
      // Keep every analyzer diagnostic line (error/warning/info) + the trailing
      // "N issues found." so heal sees ALL errors, not just the last 5 lines of
      // raw output. Caps at 8KB to keep heal prompts bounded. Truncating to a
      // tail (the previous behaviour) made heal converge in 2-error increments
      // and exhaust attempts on tickets with >5 new errors (BUG-261).
      analyze_output_summary: (() => {
        const lines = res.analyzeOutput.split('\n');
        const diagRe = /^\s*(error|warning|info)\s+[•·]/i;
        const summaryRe = /\b\d+\s+issues?\s+found\b/i;
        const kept = lines.filter((l) => diagRe.test(l) || summaryRe.test(l));
        const block = (kept.length > 0 ? kept : lines.slice(-5)).join('\n').trim();
        return block.length > 8000 ? block.slice(0, 8000) + `\n… [truncated; full analyzer output ${block.length}B]` : block;
      })(),
      extra_output_summary: res.extraOutput ? res.extraOutput.trim() : undefined,
      native_step: true,
    };

    pipelineState.steps.tests_green = step;
    await this.savePipelineJson(ticket.id, pipelineState);

    console.log(`[tests_green] ${res.passed} passed, ${res.failed} failed (${newFailures} new), ${res.analyzerErrors} analyzer errors`);
    this.emit('tests_green_done', { ticket: ticket.id, ...step });

    return step;
  }

  // --- Usage monitoring (token-count based, no extra API calls) ---

  startUsageMonitor() {
    // No-op — usage is now tracked from stream events, not separate API calls
  }

  stopUsageMonitor() {
    // No-op
  }

  // Rotate session if input tokens are getting high (approaching context window)
  checkAndRotateSession(ticket) {
    if (!this.sessionId || !this.lastInputTokens) return;

    const contextLimit = 200000; // 200k context window
    const rotatePct = this.config.session.context_new_session_pct || 80;
    const pct = Math.round((this.lastInputTokens / contextLimit) * 100);

    this.emit('usage_check', { percent: pct, used: this.lastInputTokens, total: contextLimit });

    if (pct >= rotatePct) {
      this.sessionRotateCount = (this.sessionRotateCount || 0) + 1;
      this.emit('session_rotate', {
        ticket: ticket.id,
        reason: `context at ${pct}% (${this.lastInputTokens} tokens)`,
        oldSession: this.sessionId,
      });
      this.sessionId = null;
      this.lastInputTokens = 0;
    }
  }

  // --- Rate limit retry ---

  async runWithRateLimitRetry(fn, ticketId, stepName) {
    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (!err.rateLimited) throw err;

        // Parse reset time and calculate wait
        let waitMs = 60 * 60 * 1000; // default: 1 hour
        if (err.resetTime) {
          const resetStr = err.resetTime.trim();
          const tz = err.resetTimezone || 'Europe/London';
          try {
            // Parse time like "11pm" or "11:00 PM"
            const now = new Date();
            const match = resetStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
            if (match) {
              let hours = parseInt(match[1]);
              const mins = parseInt(match[2] || '0');
              const ampm = match[3].toLowerCase();
              if (ampm === 'pm' && hours !== 12) hours += 12;
              if (ampm === 'am' && hours === 12) hours = 0;

              // Build reset date in the given timezone
              const resetDate = new Date(now.toLocaleString('en-US', { timeZone: tz }));
              resetDate.setHours(hours, mins, 0, 0);

              // If reset time is in the past, it means tomorrow
              const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
              if (resetDate <= nowInTz) {
                resetDate.setDate(resetDate.getDate() + 1);
              }

              // Calculate ms difference
              waitMs = resetDate.getTime() - nowInTz.getTime() + 60000; // +1min buffer
            }
          } catch {
            // Fallback to 1 hour
          }
        }

        const waitMins = Math.round(waitMs / 60000);
        const resumeAt = new Date(Date.now() + waitMs).toLocaleTimeString();
        console.log(`[rate-limit] Hit limit for ${ticketId}/${stepName}. Waiting ${waitMins} minutes until ${resumeAt}`);
        this.emit('rate_limited', {
          ticket: ticketId,
          step: stepName,
          waitMinutes: waitMins,
          resumeAt,
          resetTime: err.resetTime,
          resetTimezone: err.resetTimezone,
        });

        await new Promise(r => setTimeout(r, waitMs));

        // Accumulate so the step/ticket duration can subtract idle wait time.
        this.currentStepWaitMs = (this.currentStepWaitMs || 0) + waitMs;
        this.totalRateLimitWaitMs = (this.totalRateLimitWaitMs || 0) + waitMs;

        console.log(`[rate-limit] Resuming ${ticketId}/${stepName}`);
        this.emit('rate_limit_resume', { ticket: ticketId, step: stepName, waitedMs: waitMs });
        // Fresh session after wait
        this.sessionId = null;
      }
    }
  }

  // --- Lock management ---

  getUsagePercent() {
    // Read from shared file written by interactive session's statusline
    try {
      const raw = readFileSync('/tmp/claude-usage.json', 'utf-8');
      const data = JSON.parse(raw);
      const fiveHour = data.five_hour;
      if (fiveHour && fiveHour.pct !== null) {
        return {
          percent: Math.round(fiveHour.pct),
          resetTime: fiveHour.resets_at ? new Date(fiveHour.resets_at * 1000).toISOString() : null,
        };
      }
    } catch { /* file missing or stale */ }

    // Fallback to rate_limit_info from stream events
    const info = this.lastRateLimitInfo;
    if (!info) return { percent: null, resetTime: null };
    return {
      percent: null,
      resetTime: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
    };
  }

  updateRateLimitInfo(rateLimitInfo) {
    if (rateLimitInfo) this.lastRateLimitInfo = rateLimitInfo;
  }


  async appendUsageLog(report) {
    try {
      const logDir = this.config._resolved.buildLogDir || resolve(this.cwd, 'memory/build-log');
      await mkdir(logDir, { recursive: true });
      const logPath = resolve(logDir, 'usage.jsonl');
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        ticket: report.ticket,
        type: report.type,
        duration: report.totalDurationFormatted,
        outputTokens: report.totalOutputTokens,
        toolCalls: report.totalToolCalls,
        usagePercent: report.usagePercent,
        resetsAt: report.resetsAt,
        steps: report.steps.map((s) => ({
          step: s.step, model: s.model, startedAt: s.startedAt,
          duration: s.durationFormatted, outTokens: s.outputTokens, tools: s.toolCalls, status: s.status,
          usagePercent: s.usagePercent ?? null,
        })),
      }) + '\n';
      await writeFile(logPath, entry, { flag: 'a' });
    } catch { /* don't crash on logging failure */ }
  }

  async releaseLock() {
    const released = await releaseLock(this.config._resolved.codeLock);
    if (released) this.emit('lock_released', {});
  }
}

// --- Helpers ---

function logPrefix(usagePct) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const pct = usagePct == null ? '  --' : `${String(usagePct).padStart(3,' ')}%`;
  return `[${ts}] [5h ${pct}]`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function printTicketReport(report) {
  const bar = '─'.repeat(78);
  console.log(`\n${bar}`);
  console.log(`  TICKET REPORT: ${report.ticket}`);
  console.log(`  ${report.title} (${report.type})`);
  console.log(bar);
  console.log(`  Total time:    ${report.totalDurationFormatted}`);
  console.log(`  Files changed: ${report.totalFilesChanged}`);
  if (report.usagePercent !== null) {
    const usageBar = '\u2588'.repeat(Math.floor(report.usagePercent / 2)) + '\u2591'.repeat(50 - Math.floor(report.usagePercent / 2));
    console.log(`  5h window:     ${usageBar} ${report.usagePercent}%`);
  }
  if (report.resetsAt) {
    console.log(`  Window resets: ${report.resetsAt}`);
  }
  console.log(bar);

  const nameWidth = Math.max(...report.steps.map((s) => s.step.length), 4);
  const header = `  ${'STEP'.padEnd(nameWidth)}  ${'MODEL'.padEnd(8)}  ${'TIME'.padStart(8)}  ${'OUT TOK'.padStart(8)}  ${'FILES'.padStart(5)}  STATUS`;
  console.log(header);
  console.log(`  ${'─'.repeat(header.length - 2)}`);

  for (const m of report.steps) {
    console.log(
      `  ${m.step.padEnd(nameWidth)}  ${m.model.padEnd(8)}  ${m.durationFormatted.padStart(8)}  ${m.outputTokens.toLocaleString().padStart(8)}  ${String(m.filesChanged).padStart(5)}  ${m.status}`
    );
  }

  console.log(`${bar}\n`);
}
