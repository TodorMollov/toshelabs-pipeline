import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { loadBacklog, filterAndSort, archiveTicket } from './backlog.js';
import { spawnClaude, checkUsage } from './runner.js';
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
        await this.processTicket(ticket);

        this.emit('ticket_done', { ticket: ticket.id });

        // Dry run: only plan step
        if (this.dryRun) continue;

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

    // Start usage monitoring
    this.startUsageMonitor();

    for (const stepConfig of steps) {
      // Check step condition (e.g., root_cause only for bugs)
      if (stepConfig.condition) {
        const fieldVal = ticket[stepConfig.condition.field];
        if (fieldVal !== stepConfig.condition.equals &&
            !(stepConfig.condition.equals === 'bug' && fieldVal?.includes('bug'))) {
          pipelineState.steps[stepConfig.name] = { status: 'not_applicable', reason: `condition not met: ${stepConfig.condition.field} !== ${stepConfig.condition.equals}` };
          await this.savePipelineJson(ticket.id, pipelineState);
          this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'condition not met' });
          continue;
        }
      }

      // Check if step already done (crash recovery)
      const existingStep = pipelineState.steps[stepConfig.name];
      if (existingStep?.status === 'done' || existingStep?.status === 'not_applicable') {
        this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'already done' });
        continue;
      }

      // Dry run: only plan step
      if (this.dryRun && stepConfig.name !== 'plan') {
        this.emit('step_skipped', { ticket: ticket.id, step: stepConfig.name, reason: 'dry run' });
        continue;
      }

      this.emit('step_start', { ticket: ticket.id, step: stepConfig.name });

      // Build prompt
      const prompt = await buildPrompt(stepConfig, ticket, pipelineState, this.config);

      // Execute step
      const result = await spawnClaude({
        prompt,
        model: stepConfig.model || this.config.session.model,
        tools: stepConfig.tools || [],
        maxTurns: stepConfig.max_turns || 30,
        systemPromptFile: this.config._resolved.validationRules,
        workingDir: this.config.project_dir,
        sessionId: this.sessionId,
        env: this.config.environment || {},
        onData: (event) => {
          this.emit('claude_event', {
            ticket: ticket.id,
            step: stepConfig.name,
            event,
          });
        },
      });

      // Update session ID for resume
      if (result.sessionId) this.sessionId = result.sessionId;

      // Re-read pipeline JSON (Claude may have written to it)
      pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;

      // Validate step artifacts
      const stepArtifacts = pipelineState.steps[stepConfig.name] || {};
      const planArtifacts = pipelineState.steps.plan || {};
      const validation = validateStep(stepArtifacts, stepConfig, planArtifacts);

      this.emit('step_gate', {
        ticket: ticket.id,
        step: stepConfig.name,
        pass: validation.pass,
        failures: validation.failures,
      });

      if (!validation.pass) {
        this.emit('step_gate_failed', {
          ticket: ticket.id,
          step: stepConfig.name,
          failures: validation.failures,
        });
        // TODO: retry logic or halt
        console.error(`Gate failed for ${ticket.id}/${stepConfig.name}:`, validation.failures);
      }

      // Think loop (if configured for this step)
      if (stepConfig.think_loop && stepConfig.think_challenge) {
        this.emit('think_loop_start', { ticket: ticket.id, step: stepConfig.name });

        const thinkResult = await thinkLoop({
          initialResult: result.result,
          stepName: stepConfig.name,
          challengeQuestion: stepConfig.think_challenge,
          config: this.config,
          sessionId: this.sessionId,
          ticket,
          emitter: this.emitter,
        });

        if (thinkResult.sessionId) this.sessionId = thinkResult.sessionId;

        // Re-read pipeline JSON after think loop (may have been updated)
        pipelineState = await this.loadPipelineJson(ticket.id) || pipelineState;
      }

      this.emit('step_done', {
        ticket: ticket.id,
        step: stepConfig.name,
        artifacts: pipelineState.steps[stepConfig.name],
      });

      // Check context usage — start new session if too high
      await this.checkAndRotateSession(ticket);
    }

    // Mark ticket pipeline as done
    pipelineState.status = 'done';
    pipelineState.completed_at = new Date().toISOString();
    await this.savePipelineJson(ticket.id, pipelineState);
  }

  // --- Pipeline JSON management ---

  async loadOrCreatePipelineJson(ticket) {
    const existing = await this.loadPipelineJson(ticket.id);
    if (existing) return existing;

    const state = {
      schema: 'pipeline-v2',
      ticket: ticket.id,
      title: ticket.title,
      priority: ticket.priority || 'P2',
      type: ticket.type || 'feature',
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'in_progress',
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
    const raw = await readFile(path, 'utf-8');
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

  // --- Usage monitoring ---

  startUsageMonitor() {
    if (this.usageTimer) return;
    const intervalMs = (this.config.session.usage_check_interval_sec || 120) * 1000;
    this.usageTimer = setInterval(async () => {
      if (!this.sessionId) return;
      const usage = await checkUsage(this.sessionId, this.config.session.monitor_model);
      this.emit('usage_check', usage);
    }, intervalMs);
  }

  stopUsageMonitor() {
    if (this.usageTimer) {
      clearInterval(this.usageTimer);
      this.usageTimer = null;
    }
  }

  async checkAndRotateSession(ticket) {
    if (!this.sessionId) return;
    const usage = await checkUsage(this.sessionId, this.config.session.monitor_model);
    this.emit('usage_check', usage);

    if (usage.percent && usage.percent >= this.config.session.context_new_session_pct) {
      this.emit('session_rotate', {
        ticket: ticket.id,
        reason: `context at ${usage.percent}%`,
        oldSession: this.sessionId,
      });
      this.sessionId = null; // Next step starts a fresh session
    }
  }

  // --- Lock management ---

  async releaseLock() {
    const released = await releaseLock(this.config._resolved.codeLock);
    if (released) this.emit('lock_released', {});
  }
}
