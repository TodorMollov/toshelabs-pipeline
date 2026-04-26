import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, statSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { loadBacklog, filterAndSort, archiveTicket } from './backlog.js';
import { spawnClaude } from './runner.js';
import { thinkLoop } from './think-loop.js';
import { validateStep } from './validator.js';
import { buildPrompt } from './prompts.js';
import { acquireLock, releaseLock } from './lock.js';
import {
  ensureBranch as checkpointEnsureBranch,
  commitStepSnapshot as checkpointCommitStep,
  revertToLastSnapshot as checkpointRevert,
  deleteBranch as checkpointDeleteBranch,
  mergeToMaster as checkpointMergeToMaster,
  autoCommitPaths,
  listStepSnapshots,
  CheckpointError,
} from './checkpoint.js';
import { pickAttemptModel, decideRestart, shouldHeal } from './retry-policy.js';

// Module-scoped set of ticket ids already surfaced as stranded in this
// server process. Without this, every `/api/run/all` re-scans the pipeline
// dir and re-emits pipeline_crashed_detected for the same tickets — 23
// duplicates in a single day's ops log. Cleared on server restart.
const _crashedDetectedThisBoot = new Set();

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
    this.emit('pipeline_start', {});

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

      // Process tickets one at a time
      for (let i = 0; i < queue.length; i++) {
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

        this.emit('ticket_start', { ticket: ticket.id, title: ticket.title, index: i, total: queue.length });

        // Fresh session per ticket
        this.sessionId = null;
        try {
          await this.processTicket(ticket);
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
              failedState.status = 'failed';
              failedState.failed_at = new Date().toISOString();
              failedState.failure_reason = err.message;
              await this.savePipelineJson(ticket.id, failedState);
            }
          } catch { /* best-effort */ }
          // Atomic rollback: revert this ticket's declared files so the next
          // ticket's baseline is clean. Skipped on dry-run and when the
          // ticket has no declared files (e.g. crashed before plan).
          //
          // Hard skip when the failure is a checkpoint refusal (DIRTY_TREE
          // and friends): we never wrote a thing, so there is nothing to
          // revert. Running rollback here would incorrectly attribute the
          // operator's pre-existing uncommitted edits to this ticket and
          // `git checkout HEAD --` them out of the tree (this is exactly
          // how 13 backlog edits were destroyed on 2026-04-25).
          const skipRollback = err instanceof CheckpointError;
          if (!this.dryRun && failedState && !skipRollback) {
            try { await this.rollbackTicketFiles(ticket, failedState); }
            catch (rbErr) { console.error(`[rollback] ${ticket.id}: ${rbErr.message}`); }
          }
          // Return the working tree to master so the operator isn't left on
          // a dead pipeline/{id} branch after a failure. Best-effort: a
          // dirty tree or detached HEAD here is better than crashing the
          // whole run loop on cleanup.
          if (!this.dryRun && this.config.checkpoints?.enabled) {
            try {
              execSync('git checkout master', { cwd: this.config.project_dir, encoding: 'utf-8', timeout: 10000 });
            } catch (coErr) {
              console.error(`[checkout-master] ${ticket.id}: ${coErr.message?.slice(0, 200)}`);
            }
          }
          this.emit('ticket_failed', { ticket: ticket.id, error: err.message });
          continue;
        }

        this.emit('ticket_done', { ticket: ticket.id });

        // Dry run: only plan step
        if (this.dryRun) continue;

        // Don't archive blocked tickets — they need another pass. Files
        // stay on disk so the next retry can resume without re-writing
        // them; only terminally-failed tickets get rolled back.
        const finalState = await this.loadPipelineJson(ticket.id);
        if (finalState?.status === 'blocked') {
          this.emit('ticket_blocked_skip_archive', { ticket: ticket.id, step: finalState.blocked_step });
          continue;
        }

        // Archive the ticket first so its backlog.json/backlog-archive.json
        // mutations are dirty in the tree when commitTicketFiles runs and get
        // folded into the same ticket-tagged commit. Reversing this order
        // leaves the archive write uncommitted and the next ticket's
        // checkpoint guard refuses with DIRTY_TREE.
        await archiveTicket(ticket.id, this.config);

        // Auto-commit: successful tickets commit their declared files as a
        // single ticket-tagged commit. Keeps the tree clean so subsequent
        // baseline captures reflect a genuine HEAD, not a pile of
        // uncommitted work from earlier pipeline runs.
        if (finalState?.status === 'done') {
          try { await this.commitTicketFiles(ticket, finalState); }
          catch (err) { console.error(`[auto-commit] ${ticket.id}: ${err.message}`); }
        }

        // Pause between tickets if requested
        if (this.pause && i < queue.length - 1) {
          this.emit('paused', { next: queue[i + 1]?.id });
          // In a real implementation, this would wait for user input via the UI
          console.log(`Paused. Next ticket: ${queue[i + 1]?.id}. Press enter to continue...`);
          await new Promise((resolve) => process.stdin.once('data', resolve));
        }
      }

      // Phase 3-5: Integration tests, docs, build
      this.emit('pipeline_complete', { ticketsProcessed: queue.length });
    } finally {
      await this.releaseLock();
      this.stopUsageMonitor();
    }
  }

  async processTicket(ticket) {
    const MAX_BLOCKED_ATTEMPTS = 3;
    const steps = this.config.steps;
    let pipelineState = await this.loadOrCreatePipelineJson(ticket);
    const ticketStartTime = Date.now();
    const stepMetrics = [];
    // Steps whose worker actually ran (or whose orchestrator-driven body
    // executed) in THIS run. Distinct from `pipelineState.steps[X].status`
    // which a misbehaving worker can write directly. Used at squash-merge
    // time to refuse "ship" when a step claims done but never executed.
    const executedThisRun = new Set();

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
      try {
        const ledgerPaths = [
          this.config.backlog_file || 'memory/backlog.json',
          this.config.archive_file || 'memory/backlog-archive.json',
          this.config.closed_bugs_file || 'memory/closed-bugs.json',
        ];
        const sha = autoCommitPaths(this.config.project_dir, ledgerPaths);
        if (sha) {
          this.emit('human_backlog_committed', { ticket: ticket.id, sha });
          console.log(`[checkpoint] ${ticket.id}: absorbed human backlog edits as ${sha.slice(0, 7)}`);
        }
      } catch (err) {
        console.error(`[checkpoint] ${ticket.id}: auto-commit of backlog edits failed: ${err.message}`);
      }

      try {
        const res = await checkpointEnsureBranch(ticket.id, this.config.project_dir);
        this.emit('checkpoint_branch_ready', { ticket: ticket.id, ...res });
        console.log(`[checkpoint] ${ticket.id}: on branch ${res.branch}${res.recoveredFromExisting ? ' (recovered stale)' : ''}`);
      } catch (err) {
        if (err instanceof CheckpointError) {
          // DIRTY_TREE is operator error, not pipeline failure — surface
          // clearly and refuse to start so we don't smash their work.
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
      // Record which files were already dirty so rollback/auto-commit can
      // distinguish this ticket's output from earlier uncommitted work.
      try {
        await this.snapshotDirtyAtStart(ticket, pipelineState);
      } catch (err) {
        console.error(`[dirty-snapshot] failed for ${ticket.id}: ${err.message}`);
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
          // Sanctioned skip: orchestrator deliberately set not_applicable.
          // Counts as "handled this run" so the merge guard doesn't flag it.
          executedThisRun.add(stepConfig.name);
          // Restore session — skipped step shouldn't kill session for the next reuse_session step
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

        while (true) {
          testsGreenResult = await this.runTestsGreen(ticket, pipelineState);
          pipelineState = await this.reloadStepFromDisk(ticket.id, 'tests_green', pipelineState);
          const stepArtifacts = pipelineState.steps.tests_green || {};

          // If tests pass (no new failures AND no new analyzer errors) or
          // we've exhausted heal attempts, proceed to gate.
          const needsHeal = (stepArtifacts.new_failures > 0) || (stepArtifacts.new_analyzer_errors > 0);
          if (!needsHeal || healAttempt >= maxHealAttempts) {
            const planArtifacts = pipelineState.steps.plan || {};
            const validation = validateStep(stepArtifacts, stepConfig, planArtifacts);

            this.emit('step_gate', { ticket: ticket.id, step: 'tests_green', pass: validation.pass, failures: validation.failures });

            if (!validation.pass) {
              // Last resort: try self-heal on the gate itself
              const healed = await this.selfHeal(ticket, stepConfig, pipelineState, validation.failures);
              if (healed) {
                pipelineState = await this.reloadStepFromDisk(ticket.id, 'tests_green', pipelineState);
                const healValidation = validateStep(pipelineState.steps.tests_green || {}, stepConfig, pipelineState.steps.plan || {});
                if (!healValidation.pass) {
                  this.emit('step_gate_failed', { ticket: ticket.id, step: 'tests_green', failures: healValidation.failures });
                  throw new Error(`Gate failed for ${ticket.id}/tests_green: ${healValidation.failures.join(', ')}`);
                }
              } else {
                this.emit('step_gate_failed', { ticket: ticket.id, step: 'tests_green', failures: validation.failures });
                throw new Error(`Gate failed for ${ticket.id}/tests_green: ${validation.failures.join(', ')}`);
              }
            }
            break;
          }

          // Tests have new failures (or new analyzer errors) — ask Claude to fix
          healAttempt++;
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

          const fixPrompt = `You are fixing failing tests for ticket ${ticket.id}: "${ticket.title}".

${newAnalyzerErrCount > 0 ? `NEW ANALYZER ERRORS (${newAnalyzerErrCount} — fix these first):\n${stepArtifacts.analyze_output_summary || '(see full analyzer output in pipeline state)'}\n\n` : ''}FAILING TESTS (${stepArtifacts.new_failures} new failures — preexisting red tests are filtered out):
${newFailedTests.join('\n')}

TEST OUTPUT (last lines):
${stepArtifacts.test_output_summary}${compileHint}${depHint}

PIPELINE STATE:
${JSON.stringify({ plan: pipelineState.steps.plan, implement: pipelineState.steps.implement, tests_green: pipelineState.steps.tests_green })}

Fix the code so these tests pass. Read the failing test files to understand what they expect, then fix the source code (not the tests — unless the test itself has a bug like a missing mock setup or wrong import).

After fixing, DO NOT run the tests — the pipeline will re-run them automatically.`;

          // Model escalation ladder: most heal fixes are trivial (missing
          // import, null check, typo) — haiku handles them cheaply. Escalate
          // only when a cheaper model has already failed on the same run.
          const healModel = healAttempt === 1 ? 'haiku' : healAttempt === 2 ? 'sonnet' : 'opus';
          try {
            let healIn = 0, healOut = 0, healTools = 0;
            const healStart = Date.now();
            const healResult = await this.runWithRateLimitRetry(
              () => spawnClaude({
                prompt: fixPrompt,
                model: healModel,
                tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
                maxTurns: 20,
                workingDir: this.config.project_dir,
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
                await checkpointRevert(ticket.id, this.config.project_dir);
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
      if (stepConfig.think_loop && stepConfig.think_challenge) {
        const risk = pipelineState.steps.plan?.risk;
        if (risk === 'low') {
          this.emit('think_loop_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'low risk' });
        } else {
          this.emit('think_loop_start', { ticket: ticket.id, step: stepConfig.name, risk });

          await thinkLoop({
            initialResult: stepResult.lastResult || '',
            stepName: stepConfig.name,
            challengeQuestion: stepConfig.think_challenge,
            config: this.config,
            ticket,
            emitter: this.emitter,
          });

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
      };
      stepMetrics.push(metric);

      // Persist metrics onto the ticket's step record so they survive crashes
      // and are readable from the reports API.
      if (pipelineState.steps[stepConfig.name] && typeof pipelineState.steps[stepConfig.name] === 'object') {
        pipelineState.steps[stepConfig.name].metrics = metric;
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

    // F2 + F3 (audit 2026-04-26): every step claiming `done` must either
    // have actually executed in this run (executedThisRun) OR have a step
    // tag from a prior run (crash recovery). A worker can't fake a tag —
    // they're created by the orchestrator after gate pass.
    let unverifiedSteps = [];
    if (this.config.checkpoints?.enabled && pipelineState.status !== 'blocked' && pipelineState.status !== 'failed') {
      let priorRunStepNames = new Set();
      try {
        const tags = await listStepSnapshots(ticket.id, this.config.project_dir);
        priorRunStepNames = new Set(tags.map((t) => t.step));
      } catch (err) {
        console.warn(`[merge-guard] ${ticket.id}: tag listing failed — ${err.message}`);
      }
      for (const stepCfg of steps) {
        const stepState = pipelineState.steps?.[stepCfg.name];
        if (!stepState || stepState.status !== 'done') continue;
        if (executedThisRun.has(stepCfg.name)) continue;       // ran this run
        if (priorRunStepNames.has(stepCfg.name)) continue;      // tag from prior run
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
      console.log(`[blocked] ${ticket.id} post-loop incomplete: ${stepList}`);
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
        // Capture pipeline-owned post-loop writes (memory/build-log/usage.jsonl
        // from appendUsageLog, memory/build-log/YYYY-MM-DD.md from mechanical
        // docs) into a final snapshot on the ticket branch. Without this, the
        // subsequent `git checkout master` inside mergeToMaster carries those
        // writes over as "dirty master" and the merge refuses with DIRTY_TREE
        // — which is how 4 of 6 tickets on 2026-04-21 ended up stranded on
        // their branches until manually squash-merged. Bundling the writes
        // into the ticket's own snapshot makes the merge see a clean master
        // and lands everything in ONE ticket commit as intended.
        try {
          const metaSha = await checkpointCommitStep(ticket.id, 'pipeline-metadata', this.config.project_dir);
          if (metaSha) {
            this.emit('checkpoint_step_committed', { ticket: ticket.id, step: 'pipeline-metadata', sha: metaSha });
          }
        } catch (err) {
          console.warn(`[checkpoint] ${ticket.id}/pipeline-metadata: pre-merge snapshot failed — ${err.message}`);
        }

        const shouldMerge = this.config.checkpoints.merge_to_master !== false;
        let mergedSha = null;
        if (shouldMerge) {
          try {
            mergedSha = await checkpointMergeToMaster(ticket.id, {
              title: ticket.title,
              cwd: this.config.project_dir,
              ledgerPaths: [
                this.config.backlog_file || 'memory/backlog.json',
                this.config.archive_file || 'memory/backlog-archive.json',
                this.config.closed_bugs_file || 'memory/closed-bugs.json',
              ],
            });
            if (mergedSha) {
              this.emit('checkpoint_merged_to_master', { ticket: ticket.id, sha: mergedSha });
              console.log(`[checkpoint] ${ticket.id}: squash-merged to master (${mergedSha.slice(0, 7)})`);
            }
          } catch (err) {
            this.emit('ticket_merge_conflict', {
              ticket: ticket.id,
              code: err.code || 'UNKNOWN',
              message: err.message,
            });
            console.error(`[checkpoint] ${ticket.id}: merge to master FAILED — ${err.message}`);
            // Skip branch cleanup — operator needs the branch to resolve.
            return;
          }
        }

        if (!this.config.checkpoints.keep_branch_on_success) {
          try {
            // After a successful merge we're already on master; otherwise
            // checkout defensively before deleting.
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
            if (currentBranch !== 'master') {
              execSync('git checkout master', { cwd: this.config.project_dir, stdio: 'pipe' });
            }
            await checkpointDeleteBranch(ticket.id, this.config.project_dir);
            this.emit('checkpoint_branch_cleaned', { ticket: ticket.id });
          } catch (err) {
            console.warn(`[checkpoint] ${ticket.id}: cleanup failed — ${err.message}`);
          }
        }
      }
    }
  }

  // --- Pipeline JSON management ---

  async loadOrCreatePipelineJson(ticket) {
    const existing = await this.loadPipelineJson(ticket.id);
    if (existing) {
      if (existing.created_by === 'pipeline') return existing;
      // File was created by a Claude Code session, not this pipeline.
      // Reset all "done" steps to pending so the pipeline re-runs them
      // with its own prompts and validation.
      this.emit('external_file_reset', {
        ticket: ticket.id,
        reason: 'pipeline file not created by pipeline runner — resetting steps',
      });
      for (const [name, step] of Object.entries(existing.steps)) {
        if (step.status === 'done') {
          existing.steps[name] = { status: 'pending', completed_at: null };
        }
      }
      existing.created_by = 'pipeline';
      await this.savePipelineJson(ticket.id, existing);
      return existing;
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

  async savePipelineJson(ticketId, state) {
    await mkdir(this.config._resolved.pipelineDir, { recursive: true });
    const path = resolve(this.config._resolved.pipelineDir, `${ticketId}.json`);
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  // --- File tracking: dirty snapshot, rollback, auto-commit ---

  // Union of files_changed across every step's artifacts. Pipeline state
  // files (memory/pipeline/*.json) are excluded — they're bookkeeping, not
  // ticket output. Paths are relative to project_dir, matching git.
  collectDeclaredFiles(pipelineState) {
    const out = new Set();
    for (const step of Object.values(pipelineState.steps || {})) {
      if (!step || typeof step !== 'object') continue;
      for (const fc of (step.files_changed || [])) {
        const p = typeof fc === 'object' ? fc.path : fc;
        if (!p || typeof p !== 'string') continue;
        if (p.startsWith('memory/pipeline/')) continue;
        out.add(p);
      }
    }
    return out;
  }

  // Authoritative "this ticket touched" set: union of LLM-declared files
  // AND git-observed changes since ticket start. Catches silent writes
  // (LLM forgot to list a file, step wrote a sibling config, crash mid-
  // step). Files already dirty at ticket start are never attributed here —
  // they belong to earlier uncommitted work or manual edits.
  collectTicketFiles(pipelineState) {
    const out = this.collectDeclaredFiles(pipelineState);
    const dirtyAtStart = new Set(pipelineState.dirty_at_start || []);
    const nowDirty = this.getDirtyFiles(this.config.project_dir);
    for (const path of nowDirty.keys()) {
      if (dirtyAtStart.has(path)) continue;
      if (path.startsWith('memory/pipeline/')) continue;
      out.add(path);
    }
    return out;
  }

  // Returns paths currently dirty that are NOT declared anywhere (plan.
  // files_to_change ∪ all steps' files_changed) AND were not dirty at
  // ticket start. Forces the implement step to own every file it wrote:
  // either declare it or revert it. Without this, silent writes accumulate
  // into the kind of 40-file graveyard we cleaned up in 2026-04-19.
  checkSilentWrites(pipelineState) {
    const dirtyAtStart = new Set(pipelineState.dirty_at_start || []);
    const nowDirty = this.getDirtyFiles(this.config.project_dir);
    const declared = this.collectDeclaredFiles(pipelineState);
    // Also accept paths the planner declared under plan.files_to_change
    // even if no step reports them in files_changed yet.
    const plan = pipelineState.steps?.plan;
    for (const fc of (plan?.files_to_change || [])) {
      const p = typeof fc === 'object' ? fc.path : fc;
      if (p && typeof p === 'string' && !p.startsWith('memory/pipeline/')) declared.add(p);
    }
    const silent = [];
    for (const path of nowDirty.keys()) {
      if (dirtyAtStart.has(path)) continue;
      if (path.startsWith('memory/pipeline/')) continue;
      if (declared.has(path)) continue;
      silent.push(path);
    }
    return silent;
  }

  // `git status --porcelain` snapshot keyed by path. Values: 'M' (modified),
  // 'A' (added), 'D' (deleted), '??' (untracked), etc. Best-effort: returns
  // empty map on git error so downstream code degrades gracefully.
  getDirtyFiles(projectDir) {
    const map = new Map();
    try {
      const porcelain = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8', timeout: 10000 });
      for (const line of porcelain.split('\n')) {
        if (!line) continue;
        const code = line.slice(0, 2).trim();
        const path = line.slice(3).trim();
        if (path) map.set(path, code || 'M');
      }
    } catch { /* best effort */ }
    return map;
  }

  // Record which files were already dirty/untracked at ticket start so
  // rollback and auto-commit can ignore them — they belong to earlier
  // uncommitted tickets or manual edits, not to this ticket.
  async snapshotDirtyAtStart(ticket, pipelineState) {
    if (Array.isArray(pipelineState.dirty_at_start)) return; // already captured
    const dirty = this.getDirtyFiles(this.config.project_dir);
    pipelineState.dirty_at_start = Array.from(dirty.keys());
    pipelineState.dirty_at_start_captured_at = new Date().toISOString();
    await this.savePipelineJson(ticket.id, pipelineState);
    this.emit('dirty_at_start_captured', { ticket: ticket.id, count: pipelineState.dirty_at_start.length });
  }

  // Revert declared files the ticket authored, leaving everything else
  // untouched. Only called on terminal failure — blocked tickets keep their
  // files so the next retry can resume without re-running earlier steps.
  async rollbackTicketFiles(ticket, pipelineState) {
    if (pipelineState.rollback?.at) return; // already rolled back — idempotent
    // Refuse to roll back when `dirty_at_start` was never captured. Without
    // that snapshot `collectTicketFiles` cannot tell ticket writes apart
    // from the operator's pre-existing dirty files, and would attribute
    // every dirty path in the tree to this ticket. Missing baseline means
    // we don't know what's safe to touch — so touch nothing. This is the
    // structural backstop for the BUG-252 / 2026-04-25 incident.
    if (!Array.isArray(pipelineState.dirty_at_start)) {
      pipelineState.rollback = {
        at: new Date().toISOString(),
        skipped_reason: 'dirty_at_start not captured — refusing to revert',
        reverted: [], deleted: [], skipped: [], errors: [],
      };
      await this.savePipelineJson(ticket.id, pipelineState);
      console.log(`[rollback] ${ticket.id}: SKIPPED — baseline never captured`);
      this.emit('ticket_rolled_back', {
        ticket: ticket.id,
        revertedCount: 0, deletedCount: 0, skippedCount: 0, errorCount: 0,
        skippedReason: 'dirty_at_start not captured',
      });
      return;
    }
    const projectDir = this.config.project_dir;
    const touched = this.collectTicketFiles(pipelineState);
    const dirtyAtStart = new Set(pipelineState.dirty_at_start);
    const nowDirty = this.getDirtyFiles(projectDir);

    const reverted = [];
    const deleted = [];
    const skipped = [];
    const errors = [];

    for (const path of touched) {
      if (dirtyAtStart.has(path)) { skipped.push(path); continue; } // not this ticket's
      const code = nowDirty.get(path);
      if (!code) continue; // file is not currently changed
      try {
        if (code === '??' || code === 'A') {
          execSync(`rm -f ${JSON.stringify(path)}`, { cwd: projectDir, encoding: 'utf-8', timeout: 5000 });
          deleted.push(path);
        } else {
          execSync(`git checkout HEAD -- ${JSON.stringify(path)}`, { cwd: projectDir, encoding: 'utf-8', timeout: 10000 });
          reverted.push(path);
        }
      } catch (err) {
        errors.push({ path, error: err.message });
      }
    }

    pipelineState.rollback = {
      at: new Date().toISOString(),
      reverted, deleted, skipped, errors,
    };
    await this.savePipelineJson(ticket.id, pipelineState);

    console.log(`[rollback] ${ticket.id}: reverted ${reverted.length}, deleted ${deleted.length}, skipped ${skipped.length} (not this ticket's), errors ${errors.length}`);
    this.emit('ticket_rolled_back', {
      ticket: ticket.id,
      revertedCount: reverted.length,
      deletedCount: deleted.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
    });
  }

  // Commit the ticket's declared files as a single commit tagged with the
  // ticket ID. Only stages files the ticket declared AND currently dirty —
  // other uncommitted work in the tree is left alone. No-op if nothing
  // declared by this ticket is currently dirty (idempotent across retries).
  async commitTicketFiles(ticket, pipelineState) {
    const projectDir = this.config.project_dir;
    const touched = this.collectTicketFiles(pipelineState);
    const nowDirty = this.getDirtyFiles(projectDir);

    const toCommit = [];
    for (const path of touched) {
      if (nowDirty.has(path)) toCommit.push(path);
    }
    if (toCommit.length === 0) {
      this.emit('auto_commit_skipped', { ticket: ticket.id, reason: 'no declared files currently dirty' });
      return;
    }

    const title = (ticket.title || '').slice(0, 72);
    const subject = `[${ticket.id}] ${title}`.trim();
    const bodyLines = [''];
    const plan = pipelineState.steps?.plan;
    if (plan?.summary) bodyLines.push(plan.summary);
    else if (ticket.description) bodyLines.push(ticket.description.slice(0, 500));
    bodyLines.push('', '🤖 toshelabs-pipeline');
    const body = bodyLines.join('\n');
    const message = `${subject}\n${body}`;

    try {
      // Stage only the declared files — never `git add -A`.
      const quoted = toCommit.map((p) => JSON.stringify(p)).join(' ');
      execSync(`git add -- ${quoted}`, { cwd: projectDir, encoding: 'utf-8', timeout: 15000 });

      // Detect whether there's anything actually staged by this ticket
      // (files may have been identical to HEAD → git add is a no-op).
      const staged = execSync('git diff --cached --name-only', { cwd: projectDir, encoding: 'utf-8', timeout: 10000 }).trim();
      if (!staged) {
        this.emit('auto_commit_skipped', { ticket: ticket.id, reason: 'no diff after staging' });
        return;
      }

      // Escape single quotes in message for shell safety.
      const safeMsg = message.replace(/'/g, "'\\''");
      execSync(`git commit -m '${safeMsg}' -- ${quoted}`, { cwd: projectDir, encoding: 'utf-8', timeout: 30000 });

      const sha = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8', timeout: 5000 }).trim();
      pipelineState.auto_commit = { at: new Date().toISOString(), sha, files: toCommit };
      await this.savePipelineJson(ticket.id, pipelineState);

      console.log(`[auto-commit] ${ticket.id}: committed ${toCommit.length} files as ${sha.slice(0, 7)}`);
      this.emit('auto_commit_done', { ticket: ticket.id, sha, fileCount: toCommit.length });
    } catch (err) {
      const tail = (err.stderr || err.stdout || err.message || '').toString().slice(-500);
      console.error(`[auto-commit] ${ticket.id} failed: ${tail}`);
      // Persist so reports can list tickets done-but-not-committed and the
      // user knows they need manual intervention.
      pipelineState.auto_commit = { status: 'failed', at: new Date().toISOString(), error: tail };
      try { await this.savePipelineJson(ticket.id, pipelineState); } catch { /* best-effort */ }
      this.emit('auto_commit_failed', { ticket: ticket.id, error: tail });
    }
  }

  // --- Dependency-declaration gate ---

  checkDepsDeclared(stepArtifacts, planArtifacts) {
    const projectDir = this.config.project_dir;
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
    const root = this.config.project_dir;
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
      const isRetry = attempt > 1;

      // Snapshot git state before code-writing steps
      let gitSnapshotBefore = null;
      if (['implement', 'tests_red', 'docs_update'].includes(stepConfig.name)) {
        try {
          const tracked = execSync('git diff --name-only HEAD', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
          const untracked = execSync('git ls-files --others --exclude-standard', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
          gitSnapshotBefore = [tracked, untracked].filter(Boolean).join('\n');
        } catch { /* ignore */ }
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
        : await buildPrompt(stepConfig, ticket, pipelineState, this.config);
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
          workingDir: this.config.project_dir,
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
      pipelineState = await this.reloadStepFromDisk(ticket.id, stepConfig.name, pipelineState);

      // Auto-populate files from git
      await this.autoPopulateFiles(stepConfig, pipelineState, ticket, gitSnapshotBefore, stepStartTime);
      pipelineState = await this.reloadStepFromDisk(ticket.id, stepConfig.name, pipelineState);

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

        // Plan-vs-actual gate: every file implement touched must be declared
        // in either plan.files_to_change OR implement.files_changed. Catches
        // silent writes (LLM wrote a helper and forgot to list it) before
        // they leak into the tree as orphan files that poison future tickets.
        try {
          const silent = this.checkSilentWrites(pipelineState);
          if (silent.length > 0) {
            validation.pass = false;
            validation.failures.push(
              `undeclared file writes (${silent.length}): ${silent.slice(0, 10).join(', ')}${silent.length > 10 ? ` ...+${silent.length - 10} more` : ''}. Add these to implement.files_changed or revert them.`,
            );
          }
        } catch (err) {
          console.warn(`[silent-writes] skipped for ${ticket.id}: ${err.message}`);
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
        // META-001 Phase 3: snapshot the step's output to the ticket branch
        // so a later step's failure can be rewound to this exact state.
        if (this.config.checkpoints?.enabled) {
          try {
            const sha = await checkpointCommitStep(ticket.id, stepConfig.name, this.config.project_dir);
            if (sha) {
              this.emit('checkpoint_step_committed', { ticket: ticket.id, step: stepConfig.name, sha });
            }
          } catch (err) {
            // Snapshot failure shouldn't block the step — log and continue.
            // Worst case: a later revert can't find this step; it just walks
            // further back or to the branch base.
            console.warn(`[checkpoint] ${ticket.id}/${stepConfig.name}: snapshot failed — ${err.message}`);
          }
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
            await checkpointRevert(ticket.id, this.config.project_dir);
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
            await checkpointRevert(ticket.id, this.config.project_dir);
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
    const originalPrompt = (await buildPrompt(stepConfig, ticket, pipelineState, this.config)).prompt;

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
      const trackedNow = execSync('git diff --name-only HEAD', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
      const untrackedNow = execSync('git ls-files --others --exclude-standard', { cwd: this.config.project_dir, encoding: 'utf-8' }).trim();
      const allDirty = [trackedNow, untrackedNow].filter(Boolean).join('\n').split('\n').filter(Boolean);

      const beforeSet = new Set(gitSnapshotBefore ? gitSnapshotBefore.split('\n') : []);
      const newFiles = allDirty.filter((f) => !beforeSet.has(f));
      const editedFiles = allDirty.filter((f) => {
        if (newFiles.includes(f)) return false;
        try { return statSync(resolve(this.config.project_dir, f)).mtimeMs >= stepStartTime; } catch { return false; }
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

    const healPrompt = `The pipeline step "${stepConfig.name}" for ticket ${ticket.id} ("${ticket.title}") completed but FAILED its gate validation.

GATE FAILURES:
${failures.map((f, i) => `${i + 1}. ${f}`).join('\n')}

CURRENT PIPELINE JSON:
${JSON.stringify(pipelineState, null, 2)}

PIPELINE JSON PATH: ${resolve(this.config._resolved.pipelineDir, `${ticket.id}.json`)}

YOUR TASK:
1. Read the pipeline JSON file
2. Understand what fields are missing or wrong
3. If the step actually did work (check git diff, read modified files) but just forgot to update the JSON — fill in the missing fields from what you can observe
4. If the step didn't complete its work — do the work (read files, check state) and update the JSON
5. Write the corrected pipeline JSON back

IMPORTANT: Only fix what the gate requires. Do not re-run the entire step. Focus on the specific failures listed above.`;

    try {
      const result = await this.runWithRateLimitRetry(
        () => spawnClaude({
          prompt: healPrompt,
          model: 'sonnet',
          tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash(git *)'],
          maxTurns: 15,
          workingDir: this.config.project_dir,
          sessionId: null,
          env: this.config.environment || {},
          onData: (event) => {
            this.emit('claude_event', { ticket: ticket.id, step: `${stepConfig.name}_heal`, event });
          },
        }),
        ticket.id,
        `${stepConfig.name}_heal`,
      );

      // Mark that we've attempted self-heal for this step
      const updated = await this.loadPipelineJson(ticket.id);
      if (updated?.steps[stepConfig.name]) {
        updated.steps[stepConfig.name]._selfHealed = true;
        await this.savePipelineJson(ticket.id, updated);
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
    const projectDir = this.config.project_dir;

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

    // 2. Append one-line summary to build log
    try {
      const today = new Date().toISOString().split('T')[0];
      const logDir = resolve(projectDir, this.config.build_log_dir || 'memory/build-log');
      await mkdir(logDir, { recursive: true });
      const logPath = resolve(logDir, `${today}.md`);

      const implFiles = (pipelineState.steps.implement?.files_changed || [])
        .map(f => typeof f === 'object' ? f.path : f);
      const line = `- **${ticket.id}** ${ticket.title} (${ticket.type || 'feature'}) — ${implFiles.length} files changed\n`;

      await writeFile(logPath, line, { flag: 'a' });
      this.emit('mechanical_docs', { ticket: ticket.id, file: `build-log/${today}.md` });
    } catch (err) {
      console.error(`[mechanical-docs] build-log failed: ${err.message}`);
    }
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
  async runTestSuite(pipelineState, { runAllExtras = false } = {}) {
    const projectDir = this.config.project_dir;
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

    // Silent failure: non-zero exit with no parseable stats ⇒ the runner
    // crashed before producing a summary. Don't let that slip through as
    // a green pass.
    const unitCrashed = !unitSkipped && unitExitCode !== 0 && matches.length === 0;
    // Suspicious: ran unit but saw zero tests total (command ran but no
    // results). Common cause: wrong cwd, wrong test path, empty glob.
    const unitRanNothing = !unitSkipped && matches.length === 0 && !unitCrashed;

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
      // Keep per-phase tail in the summary (don't truncate after concat).
      const phaseTail = r.output.split('\n').slice(-8).join('\n');
      extraOutput += `--- ${phase} (exit ${r.exitCode}) ---\n${phaseTail}\n`;
      if (r.exitCode !== 0) extraFailures.push({ phase, exitCode: r.exitCode });
    }

    return {
      passed, failed, failedTests, unitCrashed, unitExitCode, unitRanNothing, unitSkipped,
      analyzerErrors, analyzeOutput,
      extraFailures, extraOutput,
      testOutput,
      skippedDueToCompileErrors: false,
    };
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

  async runTestsGreen(ticket, pipelineState) {
    // Prefer the deterministic baseline captured at ticket start. Fall back
    // to the legacy LLM-authored tests_red.baseline_failures for older
    // pipeline JSONs that predate baseline_capture.
    const baseline = pipelineState.baseline_failures
      || pipelineState.steps.tests_red?.baseline_failures
      || [];
    const baselineExtras = new Set(pipelineState.baseline_extra_failures || []);

    this.emit('tests_green_run', { ticket: ticket.id, phase: 'unit_tests' });
    const res = await this.runTestSuite(pipelineState, { runAllExtras: false });
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

    const failed_ = (newFailures > 0) || res.unitCrashed || newExtraFailures.length > 0 || newAnalyzerErrors > 0;
    const step = {
      status: failed_ ? 'failed' : 'done',
      completed_at: new Date().toISOString(),
      all_pass: res.failed === 0 && !res.unitCrashed && res.extraFailures.length === 0 && newAnalyzerErrors === 0,
      unit_tests: { passed: res.passed, failed: res.failed, skipped: 0 },
      unit_crashed: res.unitCrashed,
      unit_exit_code: res.unitExitCode,
      unit_ran_nothing: res.unitRanNothing,
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
      analyze_output_summary: res.analyzeOutput.split('\n').slice(-5).join('\n').trim(),
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
      const logDir = this.config._resolved.buildLogDir || resolve(this.config.project_dir, 'memory/build-log');
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
