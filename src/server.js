import express from 'express';
import { EventEmitter } from 'events';
import { readFile, readFile as readFileAsync } from 'fs/promises';
import { watchFile, unwatchFile } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadBacklog, filterAndSort, reorderTicket, archiveTicket } from './backlog.js';
import { reloadConfig } from './config.js';
import { Pipeline } from './pipeline.js';
import { EventLogger } from './event-log.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * List PIDs of claude subprocesses that are children of this node server.
 * Used by /api/stop as a safety net — if Pipeline.run() resolved but its
 * Claude child is still alive (observed 2026-04-21 during T-335 run), the
 * normal `activePipeline.stopActiveSubprocess()` path can't reach it because
 * `activePipeline` has already been nulled. ps on ppid catches the orphan.
 */
function findOrphanClaudeChildren() {
  try {
    const out = execSync(`ps --ppid ${process.pid} -o pid=,comm=`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().split('\n')
      .map((l) => l.trim())
      .filter((l) => /\bclaude\b/.test(l))
      .map((l) => parseInt(l.split(/\s+/)[0], 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

export async function startServer(config) {
  const app = express();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  // Pipeline state
  let activePipeline = null;

  // Ring buffer for SSE backfill. Byte-capped because event sizes span
  // ~200× (p50 ~1KB, max ~200KB during heal) — a count cap lets a big-event
  // run blow memory, and a tiny-event run truncate backfill to minutes.
  // V8 string/object overhead is ~3× serialized JSON, so 150MB of JSON
  // sits around ~450MB RSS. Count cap is a secondary guardrail.
  const eventLog = [];
  const MAX_LOG_BYTES = 150 * 1024 * 1024;
  const MAX_LOG_COUNT = 50_000;
  let eventLogBytes = 0;

  // Persistent ops log (NDJSON, one file per day in ops/). Survives restarts
  // and is the authoritative source for the reports page.
  const opsLogger = new EventLogger();

  emitter.on('*', () => {}); // no-op to prevent unhandled

  // Intercept all emits to log them
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, data) => {
    const entry = { event, data, timestamp: new Date().toISOString() };
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    Object.defineProperty(entry, '_size', { value: size, enumerable: false });
    eventLog.push(entry);
    eventLogBytes += size;
    while (eventLog.length > MAX_LOG_COUNT || eventLogBytes > MAX_LOG_BYTES) {
      const dropped = eventLog.shift();
      eventLogBytes -= dropped._size || 0;
    }
    opsLogger.write(event, data);
    originalEmit(event, data);
    originalEmit('_sse', entry);
  };

  // First event of every process: server boot. Reports page pairs this with
  // the stranded tickets detected at pipeline start to infer crash causes.
  const serverStartedAt = new Date().toISOString();
  emitter.emit('server_started', {
    pid: process.pid,
    node: process.version,
    argv: process.argv.slice(2),
    startedAt: serverStartedAt,
  });

  // Hot-reload pipeline.config.yaml on change. Without this, every config
  // edit needs a process restart — the 2026-04-20 `checkpoints.enabled:
  // true` change lived in the file for 3 hours before the running server
  // noticed it. watchFile polls every 2s (lighter than fs.watch,
  // cross-platform). Mutates the shared `config` object in-place so all
  // closures and new Pipeline instances pick up the change.
  if (config?._resolved?.configPath) {
    watchFile(config._resolved.configPath, { interval: 2000 }, async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      try {
        await reloadConfig(config);
        emitter.emit('config_reloaded', { at: new Date().toISOString() });
        console.log(`[config] reloaded ${config._resolved.configPath}`);
      } catch (err) {
        console.error(`[config] reload failed — ${err.message}`);
      }
    });
    process.on('exit', () => {
      try { unwatchFile(config._resolved.configPath); } catch { /* noop */ }
    });
  }

  // Memory sampler — lets us correlate a crashed pipeline.log cut-off with
  // RSS/heap just before the crash. Samples every 30s.
  const memSampler = setInterval(() => {
    const m = process.memoryUsage();
    emitter.emit('memory_sample', {
      rssMB: Math.round(m.rss / 1048576),
      heapUsedMB: Math.round(m.heapUsed / 1048576),
      heapTotalMB: Math.round(m.heapTotal / 1048576),
      externalMB: Math.round(m.external / 1048576),
    });
  }, 30000);
  memSampler.unref();

  // Record the signal and then exit — don't swallow the signal, otherwise
  // start.sh's `kill` won't actually stop the process.
  const gracefulExit = (signal) => {
    emitter.emit('server_stopping', { signal });
    // Best-effort lock release so the next start doesn't have to detect a
    // stale lock (the stale-lock path still covers SIGKILL). Fire-and-forget
    // because we're about to exit anyway.
    if (activePipeline && typeof activePipeline.releaseLock === 'function') {
      activePipeline.releaseLock().catch(() => {});
    }
    opsLogger.close();
    // Small delay so the final write flushes before we exit.
    setTimeout(() => process.exit(0), 50);
  };
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
  process.on('SIGINT',  () => gracefulExit('SIGINT'));

  app.use(express.json());

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  // Static files
  app.use(express.static(resolve(__dirname, '..', 'public')));

  // SSE endpoint
  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const since = parseInt(req.query.since || '0');
    for (let i = since; i < eventLog.length; i++) {
      res.write(`data: ${JSON.stringify(eventLog[i])}\n\n`);
    }

    const handler = (entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    emitter.on('_sse', handler);
    req.on('close', () => emitter.off('_sse', handler));
  });

  // API: pipeline status
  app.get('/api/status', (req, res) => {
    res.json({
      running: activePipeline !== null,
      eventCount: eventLog.length,
      lastEvent: eventLog[eventLog.length - 1] || null,
      server: {
        startedAt: serverStartedAt,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
      },
    });
  });

  // API: get full backlog (all tickets from all sources)
  app.get('/api/backlog', async (req, res) => {
    try {
      const tickets = await loadBacklog(config);
      const actionable = filterAndSort(tickets, config);

      // Also load v2 backlog if it exists. Tag each v2 ticket with
      // backlog:'v2' so the UI can distinguish them — without the marker
      // they merge into the same list as runnable tickets and the UI
      // shows a "Run" button on v2 items whose status isn't in its own
      // exclude list (e.g. T-250 status:'open' is not actionable here
      // but looks actionable to the UI).
      let v2Tickets = [];
      try {
        const v2Raw = await readFile(resolve(config.project_dir, 'memory/backlog-v2.json'), 'utf-8');
        const parsed = JSON.parse(v2Raw).tickets || [];
        v2Tickets = parsed.map((t) => ({ ...t, backlog: 'v2' }));
      } catch {}

      const taggedPrimary = tickets.map((t) => ({ ...t, backlog: 'primary' }));
      const all = [...taggedPrimary, ...v2Tickets];
      res.json({
        all,
        actionable,
        v2: v2Tickets,
        total: all.length,
        actionableCount: actionable.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: manually archive a ticket that landed outside the pipeline's own
  // run loop (e.g. via operator squash-merge rescue after a merge-to-master
  // DIRTY_TREE). Moves the ticket from backlog.json → backlog-archive.json,
  // and appends to closed-bugs.json when the ticket is a bug. Optional
  // `landedCommit` body param records the sha onto the archived record so
  // future audits can trace the code change.
  //
  // Response: { archived: true, ticket: <archived ticket> } or 404 when
  // the id isn't in the current backlog.
  app.post('/api/archive/:ticketId', async (req, res) => {
    try {
      const ticketId = req.params.ticketId;
      const landedCommit = typeof req.body?.landedCommit === 'string' ? req.body.landedCommit : null;
      const archived = await archiveTicket(ticketId, config, { landedCommit });
      if (!archived) {
        return res.status(404).json({ error: `ticket ${ticketId} not found in backlog` });
      }
      emitter.emit('ticket_archived_manually', { ticket: ticketId, landedCommit });
      res.json({ archived: true, ticket: archived });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: refresh backlog
  app.post('/api/backlog/refresh', async (req, res) => {
    try {
      const tickets = await loadBacklog(config);
      const actionable = filterAndSort(tickets, config);

      let v2Tickets = [];
      try {
        const v2Raw = await readFile(resolve(config.project_dir, 'memory/backlog-v2.json'), 'utf-8');
        v2Tickets = JSON.parse(v2Raw).tickets || [];
      } catch {}

      const all = [...tickets, ...v2Tickets];
      emitter.emit('backlog_refreshed', { total: all.length, actionable: actionable.length });
      res.json({ all, actionable, total: all.length, actionableCount: actionable.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: reorder a ticket (move up/down)
  app.post('/api/backlog/reorder', async (req, res) => {
    try {
      const { ticketId, direction } = req.body;
      if (!ticketId || !['up', 'down'].includes(direction)) {
        return res.status(400).json({ error: 'ticketId and direction (up|down) required' });
      }
      const actionable = await reorderTicket(ticketId, direction, config);
      if (!actionable) {
        return res.status(400).json({ error: 'Cannot move further' });
      }
      const tickets = await loadBacklog(config);
      let v2Tickets = [];
      try {
        const v2Raw = await readFile(resolve(config.project_dir, 'memory/backlog-v2.json'), 'utf-8');
        v2Tickets = JSON.parse(v2Raw).tickets || [];
      } catch {}
      const all = [...tickets, ...v2Tickets];
      emitter.emit('backlog_reordered', { ticketId, direction });
      res.json({ all, actionable, total: all.length, actionableCount: actionable.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: run a single ticket
  app.post('/api/run/ticket/:ticketId', async (req, res) => {
    if (activePipeline) {
      return res.status(409).json({ error: 'Pipeline already running' });
    }

    const ticketId = req.params.ticketId;
    const dryRun = req.body?.dryRun || false;

    emitter.emit('run_requested', { ticket: ticketId, dryRun });

    activePipeline = new Pipeline(config, {
      ticketId,
      dryRun,
      emitter,
    });

    res.json({ status: 'started', ticket: ticketId, dryRun });

    // Run in background — don't block the response
    activePipeline.run()
      .catch((err) => {
        console.error('Pipeline error:', err);
        emitter.emit('pipeline_error', { error: err.message });
      })
      .finally(() => {
        activePipeline = null;
      });
  });

  // API: run all actionable tickets
  app.post('/api/run/all', async (req, res) => {
    if (activePipeline) {
      return res.status(409).json({ error: 'Pipeline already running' });
    }

    const dryRun = req.body?.dryRun || false;

    emitter.emit('run_requested', { ticket: 'all', dryRun });

    activePipeline = new Pipeline(config, {
      dryRun,
      emitter,
    });

    const tickets = await loadBacklog(config);
    const actionable = filterAndSort(tickets, config);

    res.json({ status: 'started', ticketCount: actionable.length, dryRun });

    activePipeline.run()
      .catch((err) => {
        console.error('Pipeline error:', err);
        emitter.emit('pipeline_error', { error: err.message });
      })
      .finally(() => {
        activePipeline = null;
      });
  });

  // API: stop pipeline. Default semantics are "stop after current step"
  // (pipeline winds down when the step's Claude subprocess completes).
  // Pass `?hard=true` or {"hard": true} body to SIGTERM the subprocess
  // immediately — fixes the recurring "stop is slow" complaint where a
  // mid-step /api/stop could wait 5-15 min for Claude to finish.
  app.post('/api/stop', async (req, res) => {
    const hard = req.query?.hard === 'true' || req.body?.hard === true;
    emitter.emit('stop_requested', { hard });

    // Happy path: pipeline reference still live.
    if (activePipeline) {
      let killed = false;
      if (hard && typeof activePipeline.stopActiveSubprocess === 'function') {
        killed = activePipeline.stopActiveSubprocess();
      }
      await activePipeline.releaseLock();
      activePipeline = null;
      return res.json({ status: 'stopped', hard, subprocessKilled: killed });
    }

    // Orphan path: `activePipeline` was nulled (Pipeline.run() resolved/rejected
    // or Node evented the `.finally`) but a Claude child is still alive. This
    // was silent before — UI stop would 400 while the subprocess kept editing.
    // Scan our own children and SIGTERM any `claude -p …` we find. Covers both
    // a failed-away run and any genuinely orphaned subprocess.
    const orphans = findOrphanClaudeChildren();
    if (orphans.length === 0) {
      return res.status(400).json({ error: 'No pipeline running' });
    }
    let killedCount = 0;
    if (hard) {
      for (const pid of orphans) {
        try {
          process.kill(pid, 'SIGTERM');
          setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
          killedCount++;
        } catch { /* already gone */ }
      }
    }
    res.json({
      status: 'stopped',
      hard,
      orphansFound: orphans.length,
      orphansKilled: killedCount,
      note: hard ? 'no live pipeline; killed orphan claude subprocess(es)' : 'no live pipeline; found orphan subprocesses — pass ?hard=true to kill',
    });
  });

  // API: force-release code lock
  app.post('/api/unlock', async (req, res) => {
    const { releaseLock } = await import('./lock.js');
    const released = await releaseLock(config._resolved.codeLock);
    if (released) {
      emitter.emit('lock_released', { forced: true });
      res.json({ status: 'unlocked' });
    } else {
      res.json({ status: 'no_lock' });
    }
  });

  // API: aggregate per-ticket data for the reports page. Walks the live
  // `memory/pipeline/*.json` and the archived `memory/pipeline/archive/**/*.json`,
  // returning a flat list with timing + step status distilled from each state file.
  app.get('/api/reports/tickets', async (req, res) => {
    try {
      const { readdir, readFile: rf, stat } = await import('fs/promises');
      const liveDir = config._resolved.pipelineDir;
      const archiveDir = resolve(liveDir, 'archive');
      const results = [];

      const loadFromDir = async (dir, isArchive) => {
        let files;
        try { files = await readdir(dir); } catch { return; }
        for (const f of files) {
          const full = resolve(dir, f);
          if (!f.endsWith('.json')) {
            // archive directories (YYYY-MM-DD/ etc.)
            if (isArchive) {
              try {
                const st = await stat(full);
                if (st.isDirectory()) await loadFromDir(full, true);
              } catch { /* skip */ }
            }
            continue;
          }
          try {
            const raw = await rf(full, 'utf-8');
            const s = JSON.parse(raw);
            if (!s.ticket) continue;
            const started = s.started_at ? new Date(s.started_at).getTime() : null;
            const completed = s.completed_at ? new Date(s.completed_at).getTime() : null;
            const stepStatuses = {};
            const stepMetrics = {};
            let totalWaitedMs = 0;
            for (const [name, st] of Object.entries(s.steps || {})) {
              stepStatuses[name] = st.status || 'unknown';
              if (st && typeof st === 'object' && st.metrics) {
                const m = st.metrics;
                totalWaitedMs += m.waitedMs ?? 0;
                stepMetrics[name] = {
                  model: m.model || null,
                  durationMs: m.durationMs ?? null,
                  durationFormatted: m.durationFormatted || null,
                  wallMs: m.wallMs ?? null,
                  waitedMs: m.waitedMs ?? 0,
                  inputTokens: m.inputTokens ?? 0,
                  outputTokens: m.outputTokens ?? 0,
                  toolCalls: m.toolCalls ?? 0,
                  filesChanged: m.filesChanged ?? 0,
                  usagePercent: m.usagePercent ?? null,
                  startedAt: m.startedAt || null,
                };
              }
            }
            const rep = s.report || {};
            results.push({
              id: s.ticket,
              title: s.title || '',
              priority: s.priority || null,
              type: s.type || null,
              status: s.status || 'unknown',
              started_at: s.started_at || null,
              completed_at: s.completed_at || null,
              duration_sec: (started && completed) ? Math.round((completed - started) / 1000) : null,
              // working_sec = ticket wall time minus accumulated rate-limit idle waits
              // (5h-window resets are downtime, not pipeline effort).
              working_sec: (started && completed)
                ? Math.max(0, Math.round(((completed - started) - totalWaitedMs) / 1000))
                : null,
              waited_sec: Math.round(totalWaitedMs / 1000),
              steps: stepStatuses,
              step_metrics: stepMetrics,
              // Ticket-level rollups from the run report (present after completion).
              totals: rep.totalInputTokens != null ? {
                inputTokens: rep.totalInputTokens,
                outputTokens: rep.totalOutputTokens,
                cacheReadTokens: rep.totalCacheReadTokens,
                cacheCreationTokens: rep.totalCacheCreationTokens,
                cacheHitRatio: rep.cacheHitRatio,
                toolCalls: rep.totalToolCalls,
                filesChanged: rep.totalFilesChanged,
              } : null,
              rework: rep.reworkTokenRatio != null ? {
                inputTokens: rep.reworkInputTokens || 0,
                outputTokens: rep.reworkOutputTokens || 0,
                tokenRatio: rep.reworkTokenRatio,
                reviewCycles: rep.reviewCycles || 0,
                maxTurnsHitSteps: rep.maxTurnsHitSteps || [],
                sessionRotations: rep.sessionRotations || 0,
              } : null,
              archived: isArchive,
              // Presence of baseline_captured_at is how the reports page
              // tells new (post-atomicity) tickets from legacy ones whose
              // metrics would skew the view.
              baseline_captured_at: s.baseline_captured_at || null,
            });
          } catch { /* skip malformed */ }
        }
      };

      await loadFromDir(liveDir, false);
      await loadFromDir(archiveDir, true);

      // Sort most-recent first (completed_at || started_at || id)
      results.sort((a, b) => {
        const ak = a.completed_at || a.started_at || '';
        const bk = b.completed_at || b.started_at || '';
        return bk.localeCompare(ak);
      });
      res.json({ count: results.length, tickets: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: read persisted ops events (NDJSON) for the reports page.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, events=csv list, limit=N
  app.get('/api/reports/events', async (req, res) => {
    try {
      const { from, to, events, limit } = req.query;
      const wanted = events ? new Set(String(events).split(',').map(s => s.trim())) : null;
      const entries = await opsLogger.readRange({
        from: from || undefined,
        to: to || undefined,
        limit: limit ? Math.min(parseInt(limit, 10) || 5000, 50000) : 5000,
        filter: wanted ? (e) => wanted.has(e.event) : undefined,
      });
      res.json({ count: entries.length, entries });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: get 5h/7d usage from statusline file
  app.get('/api/usage', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const raw = await readFile('/tmp/claude-usage.json', 'utf-8');
      res.json(JSON.parse(raw));
    } catch {
      res.json({ five_hour: null, seven_day: null });
    }
  });

  // API: get pipeline JSON for a ticket
  app.get('/api/pipeline/:ticketId', async (req, res) => {
    try {
      const path = resolve(config._resolved.pipelineDir, `${req.params.ticketId}.json`);
      const raw = await readFile(path, 'utf-8');
      res.json(JSON.parse(raw));
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  });

  return new Promise((resolvePromise) => {
    const server = app.listen(config.server.port, config.server.host, () => {
      resolvePromise({ emitter, server });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${config.server.port} already in use — running without UI server`);
        resolvePromise({ emitter, server: null });
      } else {
        throw err;
      }
    });
  });
}
