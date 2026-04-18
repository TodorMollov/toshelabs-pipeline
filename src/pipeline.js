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

export class Pipeline {
  constructor(config, opts = {}) {
    this.config = config;
    this.dryRun = opts.dryRun || false;
    this.ticketId = opts.ticketId || null;
    this.pause = opts.pause || false;
    this.emitter = opts.emitter || null;
    this.sessionId = null;
    this.usageTimer = null;
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
      // Check for crashed pipelines (resume)
      const resumed = await this.checkCrashedPipelines();

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
        const ticket = queue[i];
        this.emit('ticket_start', { ticket: ticket.id, title: ticket.title, index: i, total: queue.length });

        // Fresh session per ticket
        this.sessionId = null;
        try {
          await this.processTicket(ticket);
        } catch (err) {
          if (err.rateLimited) throw err; // bubble up — runWithRateLimitRetry handles the wait
          console.error(`[pipeline] ${ticket.id} failed: ${err.message}`);
          this.emit('ticket_failed', { ticket: ticket.id, error: err.message });
          continue;
        }

        this.emit('ticket_done', { ticket: ticket.id });

        // Dry run: only plan step
        if (this.dryRun) continue;

        // Don't archive blocked tickets — they need another pass
        const finalState = await this.loadPipelineJson(ticket.id);
        if (finalState?.status === 'blocked') {
          this.emit('ticket_blocked_skip_archive', { ticket: ticket.id, step: finalState.blocked_step });
          continue;
        }

        // Archive the ticket
        await archiveTicket(ticket.id, this.config);

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
    const steps = this.config.steps;
    let pipelineState = await this.loadOrCreatePipelineJson(ticket);
    const ticketStartTime = Date.now();
    const stepMetrics = [];

    // Start usage monitoring
    this.startUsageMonitor();

    for (const stepConfig of steps) {
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
      let stepInputTokens = 0;
      let stepOutputTokens = 0;
      let stepToolCalls = 0;

      // Pre-populate mechanical docs before LLM docs_update step
      if (stepConfig.name === 'docs_update') {
        await this.mechanicalDocsUpdate(ticket, pipelineState);
      }

      // tests_green: run tests + analyzer directly, self-heal if failures
      if (stepConfig.name === 'tests_green') {
        const maxHealAttempts = 2;
        let healAttempt = 0;
        let testsGreenResult;

        while (true) {
          testsGreenResult = await this.runTestsGreen(ticket, pipelineState);
          pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;
          const stepArtifacts = pipelineState.steps.tests_green || {};

          // If tests pass or we've exhausted heal attempts, proceed to gate
          if (stepArtifacts.new_failures === 0 || healAttempt >= maxHealAttempts) {
            const planArtifacts = pipelineState.steps.plan || {};
            const validation = validateStep(stepArtifacts, stepConfig, planArtifacts);

            this.emit('step_gate', { ticket: ticket.id, step: 'tests_green', pass: validation.pass, failures: validation.failures });

            if (!validation.pass) {
              // Last resort: try self-heal on the gate itself
              const healed = await this.selfHeal(ticket, stepConfig, pipelineState, validation.failures);
              if (healed) {
                pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;
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

          // Tests have new failures — ask Claude to fix the code
          healAttempt++;
          this.emit('tests_green_heal', { ticket: ticket.id, attempt: healAttempt, newFailures: stepArtifacts.new_failures, failedTests: stepArtifacts.failed_tests });
          console.log(`[self-heal] ${ticket.id}/tests_green: ${stepArtifacts.new_failures} new failures, fix attempt ${healAttempt}/${maxHealAttempts}`);

          const fixPrompt = `You are fixing failing tests for ticket ${ticket.id}: "${ticket.title}".

FAILING TESTS (${stepArtifacts.new_failures} new failures):
${stepArtifacts.failed_tests.join('\n')}

TEST OUTPUT (last lines):
${stepArtifacts.test_output_summary}

PIPELINE STATE:
${JSON.stringify({ plan: pipelineState.steps.plan, implement: pipelineState.steps.implement, tests_green: pipelineState.steps.tests_green })}

Fix the code so these tests pass. Read the failing test files to understand what they expect, then fix the source code (not the tests — unless the test itself has a bug like a missing mock setup or wrong import).

After fixing, DO NOT run the tests — the pipeline will re-run them automatically.`;

          try {
            let healIn = 0, healOut = 0, healTools = 0;
            const healStart = Date.now();
            const healResult = await this.runWithRateLimitRetry(
              () => spawnClaude({
                prompt: fixPrompt,
                model: 'sonnet',
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
            console.log(`${logPrefix(this.getUsagePercent().percent)} [usage] ${ticket.id}/tests_green (heal-${healAttempt}) | sonnet | ${formatDuration(Date.now() - healStart)} | ${healIn.toLocaleString()} in / ${healOut.toLocaleString()} out | ${healTools} tools`);
            this.emit('step_attempt_done', { ticket: ticket.id, step: 'tests_green_heal', attempt: healAttempt, model: 'sonnet', inputTokens: healIn, outputTokens: healOut, toolCalls: healTools });
          } catch (err) {
            if (err.rateLimited) throw err; // let pipeline handle rate limits
            console.error(`[self-heal] Fix attempt failed: ${err.message}`);
            break;
          }
        }

        const durationMs = Date.now() - stepStartTime;
        const finalArtifacts = pipelineState.steps.tests_green || {};
        const metric = {
          step: 'tests_green', model: healAttempt > 0 ? 'native+sonnet' : 'native',
          startedAt: new Date(stepStartTime).toISOString(),
          durationMs, durationFormatted: formatDuration(durationMs),
          inputTokens: 0, outputTokens: 0, toolCalls: 0,
          filesChanged: 0, gate: 'pass', status: finalArtifacts.status || 'done',
          usagePercent: this.getUsagePercent().percent,
        };
        stepMetrics.push(metric);
        this.emit('step_done', { ticket: ticket.id, step: 'tests_green', artifacts: finalArtifacts, metrics: metric });
        continue;
      }

      // Run step with self-healing: execute → auto-populate → validate → heal → retry
      const stepResult = await this.runStepWithHealing(ticket, stepConfig, pipelineState, stepStartTime, {
        onTokens: (usage) => {
          if (usage.input_tokens) { this.lastInputTokens = usage.input_tokens; stepInputTokens = usage.input_tokens; }
          if (usage.output_tokens) stepOutputTokens += usage.output_tokens;
        },
        onToolCall: () => { stepToolCalls++; },
      });
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
          pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;
        }
      }

      // Collect step metrics with cost
      const stepDurationMs = Date.now() - stepStartTime;
      const stepArtifactsFinal = pipelineState.steps[stepConfig.name] || {};
      const filesChanged = stepArtifactsFinal.files_changed?.length || 0;
      const filesUpdated = stepArtifactsFinal.files_updated?.length || 0;
      const stepModel = stepConfig.model || this.config.session.model;

      const metric = {
        step: stepConfig.name,
        model: stepModel,
        startedAt: new Date(stepStartTime).toISOString(),
        durationMs: stepDurationMs,
        durationFormatted: formatDuration(stepDurationMs),
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        toolCalls: stepToolCalls,
        filesChanged: filesChanged || filesUpdated,
        gate: 'pass',
        status: stepArtifactsFinal.status || 'done',
        usagePercent: this.getUsagePercent().percent,
      };
      stepMetrics.push(metric);

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

      // Other blocked steps — halt cleanly
      if (stepArtifactsFinal.status === 'blocked') {
        this.emit('ticket_blocked', {
          ticket: ticket.id,
          step: stepConfig.name,
        });
        console.log(`[blocked] ${ticket.id} halted at ${stepConfig.name}`);
        pipelineState.status = 'blocked';
        pipelineState.blocked_at = new Date().toISOString();
        pipelineState.blocked_step = stepConfig.name;
        await this.savePipelineJson(ticket.id, pipelineState);
        break;
      }

    }

    // Build and emit ticket summary report
    const ticketDurationMs = Date.now() - ticketStartTime;
    const totalInputTokens = stepMetrics.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutputTokens = stepMetrics.reduce((s, m) => s + m.outputTokens, 0);
    const totalToolCalls = stepMetrics.reduce((s, m) => s + m.toolCalls, 0);
    const totalFilesChanged = stepMetrics.reduce((s, m) => s + m.filesChanged, 0);
    const usageEnd = this.getUsagePercent();

    const report = {
      ticket: ticket.id,
      title: ticket.title,
      type: ticket.type || 'feature',
      date: new Date().toISOString().split('T')[0],
      totalDurationMs: ticketDurationMs,
      totalDurationFormatted: formatDuration(ticketDurationMs),
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls,
      totalFilesChanged,
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

    // Mark ticket pipeline as done
    pipelineState.status = 'done';
    pipelineState.completed_at = new Date().toISOString();
    await this.savePipelineJson(ticket.id, pipelineState);
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

  async savePipelineJson(ticketId, state) {
    await mkdir(this.config._resolved.pipelineDir, { recursive: true });
    const path = resolve(this.config._resolved.pipelineDir, `${ticketId}.json`);
    await writeFile(path, JSON.stringify(state, null, 2));
  }

  // --- Crash recovery ---

  async checkCrashedPipelines() {
    const dir = this.config._resolved.pipelineDir;
    if (!existsSync(dir)) return [];

    const { readdir } = await import('fs/promises');
    const files = await readdir(dir);
    const resumed = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const raw = await readFile(resolve(dir, file), 'utf-8');
      const state = JSON.parse(raw);
      if (state.status === 'in_progress') {
        const resumeStep = Object.entries(state.steps).find(
          ([, s]) => s.status !== 'done' && s.status !== 'not_applicable'
        );
        if (resumeStep) {
          this.emit('crash_recovery', { ticket: state.ticket, resumeFrom: resumeStep[0] });
          // Create a minimal ticket object for the queue
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

    return resumed;
  }

  // --- Step execution with self-healing loop ---

  async runStepWithHealing(ticket, stepConfig, pipelineState, stepStartTime, callbacks) {
    const maxAttempts = 3; // original + 2 heal attempts
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
      const attemptModel = isRetry ? 'sonnet' : (stepConfig.model || this.config.session.model);

      // Build and execute
      const prompt = isRetry
        ? await this.buildHealPrompt(stepConfig, ticket, pipelineState, attempt)
        : await buildPrompt(stepConfig, ticket, pipelineState, this.config);
      const result = await this.runWithRateLimitRetry(
        () => spawnClaude({
          prompt,
          model: attemptModel,
          tools: stepConfig.tools || [],
          maxTurns: stepConfig.max_turns || 30,
          effort: stepConfig.effort || null,
          systemPromptFile: (!isRetry && stepConfig.inject_validation_rules) ? this.config._resolved.validationRules : null,
          workingDir: this.config.project_dir,
          sessionId: isRetry ? null : this.sessionId,
          env: this.config.environment || {},
          onData: (event) => {
            const usage = event.message?.usage || event.usage;
            if (usage?.input_tokens) { attemptInputTokens = usage.input_tokens; callbacks.onTokens({ input_tokens: usage.input_tokens }); }
            if (usage?.output_tokens) { attemptOutputTokens += usage.output_tokens; callbacks.onTokens({ output_tokens: usage.output_tokens }); }
            // stream-json emits tool_use inside assistant messages, not as content_block_start
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_use') { attemptToolCalls++; callbacks.onToolCall(); }
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
      if (maxTurnsHit) console.log(`[WARNING] ${ticket.id}/${stepConfig.name}: max turns (${stepConfig.max_turns || 30}) reached`);
      console.log(`${logPrefix(this.getUsagePercent().percent)} [usage] ${ticket.id}/${stepConfig.name} (${attemptLabel}) | ${attemptModel} | ${formatDuration(Date.now() - attemptStartTime)} | ${attemptInputTokens.toLocaleString()} in / ${attemptOutputTokens.toLocaleString()} out | ${attemptToolCalls} tools${maxTurnsHit ? ' | MAX TURNS HIT' : ''}`);
      this.emit('step_attempt_done', { ticket: ticket.id, step: stepConfig.name, attempt, model: attemptModel, inputTokens: attemptInputTokens, outputTokens: attemptOutputTokens, toolCalls: attemptToolCalls, maxTurnsHit });

      if (result.sessionId) this.sessionId = result.sessionId;
      pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;

      // Auto-populate files from git
      await this.autoPopulateFiles(stepConfig, pipelineState, ticket, gitSnapshotBefore, stepStartTime);
      pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;

      // Validate
      const stepArtifacts = pipelineState.steps[stepConfig.name] || {};
      const planArtifacts = pipelineState.steps.plan || {};
      const validation = validateStep(stepArtifacts, stepConfig, planArtifacts);

      this.emit('step_gate', {
        ticket: ticket.id,
        step: stepConfig.name,
        pass: validation.pass,
        failures: validation.failures,
        attempt,
      });

      if (validation.pass) {
        return { pipelineState, lastResult: result.result };
      }

      // Blocked steps are intentional — don't heal
      if (stepArtifacts.status === 'blocked') {
        return { pipelineState, lastResult: result.result };
      }

      // Review with findings = feedback loop, not self-heal.
      // Return to processTicket which handles the review→implement cycle.
      if (stepConfig.name === 'review' && Array.isArray(stepArtifacts.findings) && stepArtifacts.findings.length > 0) {
        // Ensure status is 'blocked' so the feedback loop picks it up
        pipelineState.steps.review.status = 'blocked';
        await this.savePipelineJson(ticket.id, pipelineState);
        return { pipelineState, lastResult: result.result };
      }

      // Max turns with no tool calls = step couldn't do any work, healing won't help
      if (maxTurnsHit && attemptToolCalls === 0) {
        const reason = `max turns hit with 0 tool calls — step could not execute`;
        pipelineState.steps[stepConfig.name] = {
          ...pipelineState.steps[stepConfig.name],
          status: 'crashed',
          crashed_at: new Date().toISOString(),
          reason,
        };
        await this.savePipelineJson(ticket.id, pipelineState);
        this.emit('step_gate_failed', { ticket: ticket.id, step: stepConfig.name, failures: [reason], attempts: attempt });
        console.error(`[skip-heal] ${ticket.id}/${stepConfig.name}: ${reason}`);
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
      this.sessionId = null; // fresh session for heal attempt
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
    const originalPrompt = await buildPrompt(stepConfig, ticket, pipelineState, this.config);

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
        if (stepConfig.name === 'docs_update') {
          const backlogFile = this.config.backlog_file || 'memory/backlog.json';
          if (touchedFiles.some((f) => f.includes(backlogFile) || f.includes('backlog'))) step.backlog_updated = true;
        }
        step.status = step.status === 'pending' ? 'done' : step.status;
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

  // --- tests_green: run flutter test + analyze directly ---

  async runTestsGreen(ticket, pipelineState) {
    const projectDir = this.config.project_dir;
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.config.environment || {})) {
      env[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
    }

    const baseline = pipelineState.steps.tests_red?.baseline_failures || [];
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

    // --- Unit tests ---
    this.emit('tests_green_run', { ticket: ticket.id, phase: 'unit_tests' });
    if (!tc.unit) {
      console.warn(`[tests_green] WARNING: project_profile.test_commands.unit is not configured — no unit tests will run for ${ticket.id}.`);
    } else {
      console.log(`[tests_green] Running unit tests (${tc.unit.cmd})...`);
    }
    const { output: testOutput, exitCode: testExitCode, skipped: unitSkipped } = runPhase(tc.unit);

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

    const baselineSet = new Set(baseline);
    const newFailures = failedTests.filter((t) => !baselineSet.has(t)).length;

    // Detect silent failures: non-zero exit with no parseable stats ⇒ the
    // runner crashed before producing a summary. Don't let that slip through
    // as a green pass.
    let unitCrashed = false;
    if (!unitSkipped && testExitCode !== 0 && matches.length === 0) {
      unitCrashed = true;
      console.error(`[tests_green] unit runner crashed (exit ${testExitCode}) with no parseable stats. Output head: ${testOutput.slice(0, 500)}`);
    }

    // --- Analyzer ---
    this.emit('tests_green_run', { ticket: ticket.id, phase: 'analyzer' });
    let analyzeOutput = '';
    let analyzerErrors = 0;
    if (tc.analyzer) {
      console.log(`[tests_green] Running analyzer (${tc.analyzer.cmd})...`);
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

    // --- Extra phases (e.g. backend, integration), each conditional on file-path prefix ---
    const implFiles = pipelineState.steps.implement?.files_changed || [];
    const implPaths = implFiles.map((f) => (typeof f === 'object' ? f.path : f));
    let extraOutput = '';
    for (const [phase, spec] of Object.entries(tc.extras || {})) {
      const prefix = spec.trigger_file_prefix;
      if (prefix && !implPaths.some((p) => p.startsWith(prefix))) continue;
      console.log(`[tests_green] Running ${phase} (${spec.cmd})...`);
      const r = runPhase(spec);
      extraOutput += `--- ${phase} (exit ${r.exitCode}) ---\n${r.output}\n`;
    }

    // Write results
    const step = {
      status: (newFailures > 0 || unitCrashed) ? 'failed' : 'done',
      completed_at: new Date().toISOString(),
      all_pass: failed === 0 && !unitCrashed,
      unit_tests: { passed, failed, skipped: 0 },
      unit_crashed: unitCrashed,
      unit_exit_code: testExitCode,
      analyzer_errors: analyzerErrors,
      failed_tests: failedTests,
      baseline_failures: baseline,
      new_failures: newFailures,
      test_output_summary: testOutput.split('\n').slice(-5).join('\n').trim(),
      analyze_output_summary: analyzeOutput.split('\n').slice(-3).join('\n').trim(),
      extra_output_summary: extraOutput ? extraOutput.split('\n').slice(-5).join('\n').trim() : undefined,
      native_step: true,
    };

    pipelineState.steps.tests_green = step;
    await this.savePipelineJson(ticket.id, pipelineState);

    console.log(`[tests_green] ${passed} passed, ${failed} failed (${newFailures} new), ${analyzerErrors} analyzer errors`);
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

        console.log(`[rate-limit] Resuming ${ticketId}/${stepName}`);
        this.emit('rate_limit_resume', { ticket: ticketId, step: stepName });
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
