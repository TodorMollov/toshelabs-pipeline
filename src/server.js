import express from 'express';
import { EventEmitter } from 'events';
import { readFile, readFile as readFileAsync } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadBacklog, filterAndSort, reorderTicket } from './backlog.js';
import { Pipeline } from './pipeline.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startServer(config) {
  const app = express();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  // Pipeline state
  let activePipeline = null;

  // Store all events for new clients to catch up
  const eventLog = [];
  const MAX_LOG = 5000;

  emitter.on('*', () => {}); // no-op to prevent unhandled

  // Intercept all emits to log them
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, data) => {
    const entry = { event, data, timestamp: new Date().toISOString() };
    eventLog.push(entry);
    if (eventLog.length > MAX_LOG) eventLog.shift();
    originalEmit(event, data);
    originalEmit('_sse', entry);
  };

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
    });
  });

  // API: get full backlog (all tickets from all sources)
  app.get('/api/backlog', async (req, res) => {
    try {
      const tickets = await loadBacklog(config);
      const actionable = filterAndSort(tickets, config);

      // Also load v2 backlog if it exists
      let v2Tickets = [];
      try {
        const v2Raw = await readFile(resolve(config.project_dir, 'memory/backlog-v2.json'), 'utf-8');
        v2Tickets = JSON.parse(v2Raw).tickets || [];
      } catch {}

      const all = [...tickets, ...v2Tickets];
      res.json({
        all,
        actionable,
        total: all.length,
        actionableCount: actionable.length,
      });
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

  // API: stop pipeline
  app.post('/api/stop', async (req, res) => {
    if (!activePipeline) {
      return res.status(400).json({ error: 'No pipeline running' });
    }
    emitter.emit('stop_requested', {});
    await activePipeline.releaseLock();
    activePipeline = null;
    res.json({ status: 'stopped' });
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
