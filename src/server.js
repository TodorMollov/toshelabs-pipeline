import express from 'express';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadBacklog, filterAndSort } from './backlog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startServer(config) {
  const app = express();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

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
    // Also emit on wildcard for SSE
    originalEmit('_sse', entry);
  };

  // Static files
  app.use(express.static(resolve(__dirname, '..', 'public')));

  // SSE endpoint
  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Send event history (catch-up)
    const since = parseInt(req.query.since || '0');
    for (let i = since; i < eventLog.length; i++) {
      res.write(`data: ${JSON.stringify(eventLog[i])}\n\n`);
    }

    // Stream new events
    const handler = (entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    emitter.on('_sse', handler);

    req.on('close', () => {
      emitter.off('_sse', handler);
    });
  });

  // API: get current state
  app.get('/api/state', (req, res) => {
    res.json({
      eventCount: eventLog.length,
      lastEvent: eventLog[eventLog.length - 1] || null,
    });
  });

  // API: get backlog
  app.get('/api/backlog', async (req, res) => {
    try {
      const tickets = await loadBacklog(config);
      const sorted = filterAndSort(tickets, config);
      res.json({ tickets: sorted, total: tickets.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API: refresh backlog
  app.post('/api/backlog/refresh', async (req, res) => {
    try {
      const tickets = await loadBacklog(config);
      const sorted = filterAndSort(tickets, config);
      emitter.emit('backlog_refreshed', { total: tickets.length, actionable: sorted.length });
      res.json({ tickets: sorted, total: tickets.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
    app.listen(config.server.port, config.server.host, () => {
      resolvePromise(emitter);
    });
  });
}
