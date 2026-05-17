import express from 'express';
import { EventEmitter } from 'events';
import { readFile, writeFile, readFile as readFileAsync, readFile as readFileFs, writeFile as writeFileFs } from 'fs/promises';
import { watchFile, unwatchFile, readFileSync, readdirSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadBacklog, filterAndSort, reorderTicket, archiveTicket } from './backlog.js';
import { reloadConfig, loadAllConfigs, persistActiveProject } from './config.js';
import { createMcpServer, mountMcpOnExpress } from './mcp/server.js';
import { Pipeline } from './pipeline.js';
import { EventLogger } from './event-log.js';
import { releaseLock } from './lock.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read field 22 (starttime, in clock ticks since boot) from /proc/<pid>/stat.
 * Used as a stable per-process identity — survives across signals, unaffected
 * by PID reuse. Returns null when the process doesn't exist or /proc isn't
 * available (non-Linux). Handles the quirk that the comm field (2) can
 * contain spaces and parens: always parse after the last `)`.
 */
function procStarttime(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tailIdx = raw.lastIndexOf(')');
    if (tailIdx < 0) return null;
    const fields = raw.slice(tailIdx + 2).split(' ');
    // After the ')' comes field 3 onward — so field 22 is index (22 - 3) = 19.
    return fields[19] || null;
  } catch {
    return null;
  }
}

/**
 * List {pid, starttime} for claude subprocesses that are direct children of
 * this node server. Used by /api/stop as a safety net: if Pipeline.run()
 * already resolved but its Claude child is still alive, activePipeline is
 * null and stopActiveSubprocess() can't reach it. The starttime is captured
 * here so a follow-up SIGKILL can verify we're signaling the same process,
 * not a recycled PID.
 *
 * Linux-only: reads /proc/<pid>/{comm,stat}. Non-Linux returns [].
 * Only finds direct children — spawn path is currently synchronous (spawnClaude
 * in runner.js), so grandchild detection isn't needed. If Claude ever gets
 * wrapped in a shell, this needs to walk /proc/<pid>/status PPid recursively.
 */
function findOrphanClaudeChildren() {
  const parent = process.pid;
  const results = [];
  let pids;
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  for (const s of pids) {
    try {
      const status = readFileSync(`/proc/${s}/status`, 'utf8');
      const ppidMatch = /^PPid:\s*(\d+)/m.exec(status);
      if (!ppidMatch || Number(ppidMatch[1]) !== parent) continue;
      const comm = readFileSync(`/proc/${s}/comm`, 'utf8').trim();
      // Exact match against comm — `claude-code`, `claude-wrapper`, etc. must
      // not match, and comm is truncated to 15 chars on Linux so substring
      // checks are risky.
      if (comm !== 'claude') continue;
      const starttime = procStarttime(Number(s));
      results.push({ pid: Number(s), starttime });
    } catch { /* proc vanished mid-scan — skip */ }
  }
  return results;
}

export async function startServer(config) {
  const app = express();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  // Expose the emitter on the config object so non-Pipeline consumers
  // (e.g. loadBacklog's schema validator) can emit events without needing
  // to be passed an emitter explicitly. Pipeline instances still get
  // `emitter` via opts and own the lifecycle of their own emits.
  config._emitter = emitter;

  // PIPE-008: per-project Pipeline instances. Multiple projects can run
  // concurrently — each has its own config object, code_lock, worktree,
  // and pipeline-state directory, so they don't fight on disk. The
  // server's job is to keep one Pipeline per project alive, route
  // events with the project tag, and refuse a SECOND start for a
  // project that already has an active run.
  //
  // Keyed by projectId (Map). Each entry's value is a live Pipeline
  // instance. When Pipeline.run() resolves/rejects, the entry is
  // removed in the .finally() handler.
  const activePipelines = new Map();

  function pipelineRunningForAny() { return activePipelines.size > 0; }
  // Returns the live Pipeline instance (NOT the map entry — entries are
  // {pipeline, donePromise} so the server can drain on shutdown).
  function pipelineFor(projectId) {
    const entry = activePipelines.get(projectId);
    return entry ? entry.pipeline : null;
  }
  // Resolve a project's config from id. Used by both startPipeline and
  // the per-project HTTP handlers so they can't disagree about what
  // "project X" resolves to. Returns null if the project isn't loaded —
  // callers should 404.
  function configForProject(projectId) {
    if (!projectId) return null;
    const projectsMap = config._projects;
    if (projectsMap) return projectsMap.get(projectId) || null;
    // Single-config mode (no registry): the active config IS the only project.
    const activeId = config._activeProjectId || config.name;
    if (projectId === activeId) return config;
    return null;
  }

  // Start a Pipeline for the given project. Returns the Pipeline instance.
  // Throws if the project doesn't exist OR a pipeline is already running
  // for it. Each Pipeline gets a project-tagging emitter wrapper so its
  // events flow through the global SSE stream with `project: <id>` for
  // dashboard multiplexing.
  function startPipeline(projectId, opts = {}) {
    if (activePipelines.has(projectId)) {
      const err = new Error(`pipeline already running for project ${projectId}`);
      err.code = 'ALREADY_RUNNING';
      throw err;
    }
    const projectCfg = configForProject(projectId);
    if (!projectCfg) {
      const err = new Error(`project ${projectId} not loaded`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    // Project-tagging emitter: stamps the project id AFTER any payload
    // fields (so the wrapper's tag is authoritative; Pipeline can't
    // mistag by including its own `project` key). Proxies on/off/once/
    // emit so any future Pipeline code that calls .on() doesn't crash.
    const projectEmitter = {
      emit(event, data) {
        return emitter.emit(event, { ...(data || {}), project: projectId });
      },
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      off: emitter.off.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      removeAllListeners: emitter.removeAllListeners.bind(emitter),
    };
    const pipeline = new Pipeline(projectCfg, { ...opts, emitter: projectEmitter });
    // Store the run promise alongside the instance so callers can drain
    // ("await all running pipelines to finish") on graceful shutdown,
    // not just signal them.
    const donePromise = pipeline.run()
      .catch((err) => {
        console.error(`[pipeline:${projectId}] error:`, err);
        emitter.emit('pipeline_error', { project: projectId, error: err.message });
      })
      .finally(() => {
        activePipelines.delete(projectId);
        emitter.emit('pipeline_stopped', { project: projectId });
      });
    activePipelines.set(projectId, { pipeline, donePromise });
    return pipeline;
  }

  // PIPE-009: stop is always decisive — SIGTERM the active Claude
  // subprocess (Pipeline.stopActiveSubprocess escalates to SIGKILL after
  // 5s if it didn't take). The subprocess dies in seconds, the step
  // throws, pipeline.run() rejects, .finally() cleans up the map entry.
  //
  // The previous soft-stop semantic (hard=false: release lock and walk
  // away while the subprocess kept running) was a lie — it returned
  // status:'stopped' to the caller while the pipeline kept consuming
  // tokens. The lock-release-without-stop side effect was also actively
  // harmful: another process seeing the lockfile gone could think
  // nothing was running and try to start a parallel pipeline against
  // the same worktree. Removed.
  //
  // Returns { stopped, killed, reason? }. stopped=false means there was
  // no pipeline to stop.
  async function stopPipeline(projectId) {
    const entry = activePipelines.get(projectId);
    if (!entry) {
      return { stopped: false, killed: false, reason: 'no pipeline running for this project' };
    }
    const { pipeline } = entry;
    let killed = false;
    // PIPE-014: requestStop() sets the sticky flag AND kills the
    // subprocess. The flag is what halts the supervisor — the kill
    // alone wasn't enough because heal loops retried and the ticket
    // loop advanced. Fall back to bare kill for old pipeline instances
    // that pre-date requestStop (e.g. mid-deploy).
    if (typeof pipeline.requestStop === 'function') {
      killed = pipeline.requestStop();
    } else if (typeof pipeline.stopActiveSubprocess === 'function') {
      killed = pipeline.stopActiveSubprocess();
    }
    await pipeline.releaseLock();
    // Don't pre-emptively delete the map entry — pipeline.run()'s
    // .finally() handles that. Deleting here would race the .finally,
    // produce a duplicate pipeline_stopped emission, and break the
    // "drain all" semantic (caller can no longer await the donePromise
    // for confirmation that the run actually wound down).
    return { stopped: true, killed };
  }

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
    // Each map entry is {pipeline, donePromise}. releaseLock is async;
    // optional-chaining returns undefined when absent, and `.catch` on
    // undefined throws — so guard the method explicitly.
    for (const entry of activePipelines.values()) {
      const p = entry?.pipeline;
      if (p && typeof p.releaseLock === 'function') {
        try { p.releaseLock().catch(() => {}); } catch {}
      }
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

  // PIPE-006: mount the MCP server on POST /mcp + GET /mcp (SSE).
  // Same Node process — shares the projects map, the active-project
  // pointer, and the event emitter with the HTTP server. Local-only
  // by default (the HTTP transport is bound to whatever host the
  // pipeline server runs on; if you exposed the pipeline beyond
  // loopback, MCP travels with it — add auth before doing that).
  if (config._projects) {
    try {
      const serverFactory = () => createMcpServer({
        projects: config._projects,
        getActiveId: () => config._activeProjectId || config.name || 'default',
        emitter,
      });
      await mountMcpOnExpress(app, serverFactory, '/mcp');
      console.log(`MCP: tools available at POST ${config.server.host}:${config.server.port}/mcp`);
    } catch (err) {
      console.error(`[mcp] mount failed: ${err.message}`);
    }
  }

  // SSE endpoint
  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Replay only when the client explicitly asks (since= present). On a
    // fresh page load the client omits the param and starts from "now" —
    // without this, every reload flushes the in-memory event log to the
    // UI, which makes the status pill animate through old ticket_start /
    // ticket_done pairs as if they were happening live.
    if (req.query.since !== undefined) {
      const since = Math.max(0, parseInt(req.query.since) || 0);
      for (let i = since; i < eventLog.length; i++) {
        res.write(`data: ${JSON.stringify(eventLog[i])}\n\n`);
      }
    }

    const handler = (entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    emitter.on('_sse', handler);
    req.on('close', () => emitter.off('_sse', handler));
  });

  // API: pipeline status. Field semantics:
  //   running:              bool — true if ANY project's pipeline is
  //                                running (matches pre-PIPE-008
  //                                semantic; preserves backwards-compat
  //                                for monitors that polled this).
  //   activeProjectRunning: bool — true only if the ACTIVE project's
  //                                pipeline is running. Use this for
  //                                "the dashboard's currently-displayed
  //                                project's status pill."
  //   runningProjects: [id]      — every project with an active run.
  //   perProject: { id: { running: bool } } — full per-project map.
  //
  // The two booleans diverge when the operator switches the picker
  // mid-run: `running` stays true (something IS running), but
  // `activeProjectRunning` flips to false because the picker now
  // points at an idle project.
  app.get('/api/status', (req, res) => {
    const activeId = config._activeProjectId || null;
    const runningProjects = [...activePipelines.keys()];
    const perProject = {};
    for (const id of runningProjects) perProject[id] = { running: true };
    res.json({
      running: pipelineRunningForAny(),
      activeProjectRunning: activeId ? activePipelines.has(activeId) : false,
      runningProjects,
      perProject,
      eventCount: eventLog.length,
      lastEvent: eventLog[eventLog.length - 1] || null,
      activeProjectId: activeId,
      server: {
        startedAt: serverStartedAt,
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
      },
    });
  });

  // PIPE-008: per-project status (cheap; just the running flag).
  app.get('/api/projects/:id/status', (req, res) => {
    res.json({
      project: req.params.id,
      running: activePipelines.has(req.params.id),
    });
  });

  // PIPE-003: list all loaded projects with their basic metadata. The
  // active project is the one served by all top-level routes (/api/backlog,
  // /api/run/all, etc.). Switch the active project with POST
  // /api/projects/:id/activate. Switching is refused while a run is in
  // flight — config mutation mid-run would corrupt the live Pipeline
  // instance's path resolution.
  app.get('/api/projects', (req, res) => {
    const projects = config._projects;
    if (!projects) {
      // Single-config mode — surface the active config as the only project.
      return res.json({
        active: config._activeProjectId || config.name || 'default',
        projects: [{
          id: config._activeProjectId || config.name || 'default',
          name: config.name || 'default',
          project_dir: config.project_dir,
          configPath: config._resolved?.configPath || null,
          active: true,
        }],
      });
    }
    const list = [...projects.entries()].map(([id, cfg]) => ({
      id,
      name: cfg.name || id,
      project_dir: cfg.project_dir,
      configPath: cfg._resolved?.configPath || null,
      active: id === config._activeProjectId,
    }));
    res.json({ active: config._activeProjectId, projects: list });
  });

  // PIPE-003: hot-reload the projects map from disk. Re-enumerates
  // ~/.toshelabs/projects/*.yaml + the legacy config file, replaces every
  // entry in the live projects Map EXCEPT the currently-active one (its
  // config object holds live state — running Pipeline instance, _resolved
  // paths the worker is using, etc. — and replacing it mid-run would
  // desync). New project files become visible in /api/projects
  // immediately; activating one is still refused while a run is in
  // flight (handled by /api/projects/:id/activate). The active project's
  // config does NOT see changes from disk via this endpoint — for that
  // use the existing /api/backlog/refresh (which calls reloadConfig on
  // the active config in place) or restart.
  app.post('/api/projects/refresh', async (req, res) => {
    try {
      const projectsMap = config._projects;
      if (!projectsMap) {
        return res.status(400).json({ error: 'multi-project mode not enabled (single-config startup)' });
      }
      const fresh = await loadAllConfigs({ legacyConfigPath: config._legacyConfigPath || 'pipeline.config.yaml' });
      const activeId = config._activeProjectId;
      const before = new Set(projectsMap.keys());

      // Mutate in place so any closures over `projectsMap` keep working.
      // Active project keeps its existing config object (do not replace).
      const activeCfg = projectsMap.get(activeId);
      projectsMap.clear();
      for (const [id, freshCfg] of fresh.entries()) {
        if (id === activeId && activeCfg) {
          projectsMap.set(id, activeCfg);
        } else {
          projectsMap.set(id, freshCfg);
        }
      }
      const after = new Set(projectsMap.keys());
      const added = [...after].filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !after.has(id));

      emitter.emit('projects_refreshed', { count: projectsMap.size, ids: [...projectsMap.keys()], added, removed, active: activeId });
      console.log(`[projects] refreshed: ${projectsMap.size} projects (added=[${added.join(',')}], removed=[${removed.join(',')}], active=${activeId})`);
      res.json({ ok: true, count: projectsMap.size, projects: [...projectsMap.keys()], added, removed, active: activeId });
    } catch (err) {
      console.error('[projects] refresh failed:', err.stack || err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PIPE-003: full settings dump for a project. Returns the config as
  // loaded (minus internal fields prefixed with _). Used by the dashboard
  // settings panel to display paths, schema mode, plan_critic config,
  // per-step write zones, etc. without making the operator open YAML files.
  app.get('/api/projects/:id', (req, res) => {
    const projects = config._projects;
    const targetId = req.params.id;
    const target = projects ? projects.get(targetId) : (targetId === (config._activeProjectId || config.name || 'default') ? config : null);
    if (!target) {
      return res.status(404).json({ error: `project ${targetId} not found` });
    }
    // Strip private/internal fields (anything starting with _) and any
    // non-serialisable values. Keep _resolved separately so the UI can
    // show the absolute paths the pipeline actually uses.
    const safe = {};
    for (const [k, v] of Object.entries(target)) {
      if (k.startsWith('_')) continue;
      try { JSON.stringify(v); safe[k] = v; } catch { /* skip non-serialisable */ }
    }
    res.json({
      id: targetId,
      config: safe,
      resolved: target._resolved || null,
      configPath: target._resolved?.configPath || null,
      active: targetId === (config._activeProjectId || null),
    });
  });

  // PIPE-005 MVP (option B): toggle-only settings edits. Allows flipping
  // a small whitelist of fields without exposing a full YAML editor:
  //   - ticket_schema.mode                            : off | warn | strict
  //   - plan_critic.enabled                           : true | false
  //   - steps[<name>].write_zones.mode                : off | warn | strict
  //
  // Anything else returns 400 — full structured-form editor is PIPE-005.
  // Refused (409) during a pipeline run; a config mutation mid-run would
  // change the live Pipeline instance's behaviour halfway through a step.
  // Writes the YAML file in place (no .bak yet — also PIPE-005), then
  // calls reloadConfig so the running server picks up the new values.
  app.post('/api/projects/:id/settings', async (req, res) => {
    // PIPE-008: refuse if THIS project's pipeline is running (mutating
    // its config mid-run would change worker behaviour halfway through
    // a step). Other projects' runs are unaffected.
    const targetId = req.params.id;
    if (activePipelines.has(targetId)) {
      return res.status(409).json({ error: `cannot edit settings while project ${targetId}'s pipeline is running. Wait for it to finish or POST /api/projects/${targetId}/stop first.` });
    }
    const projects = config._projects;
    const target = projects ? projects.get(targetId) : (targetId === (config._activeProjectId || config.name || 'default') ? config : null);
    if (!target) {
      return res.status(404).json({ error: `project ${targetId} not found` });
    }
    const { path: settingPath, value } = req.body || {};
    if (typeof settingPath !== 'string' || value === undefined) {
      return res.status(400).json({ error: 'request body must be {path: string, value: any}' });
    }

    // Whitelist + validate the path. A regex-ish match keeps this readable.
    const ALLOWED_MODES = new Set(['off', 'warn', 'strict']);
    let yamlEditDescriptor;
    if (settingPath === 'ticket_schema.mode') {
      if (!ALLOWED_MODES.has(value)) return res.status(400).json({ error: `value must be one of [${[...ALLOWED_MODES].join(', ')}]` });
      yamlEditDescriptor = { kind: 'simple', keys: ['ticket_schema', 'mode'], value };
    } else if (settingPath === 'plan_critic.enabled') {
      if (typeof value !== 'boolean') return res.status(400).json({ error: 'value must be boolean' });
      yamlEditDescriptor = { kind: 'simple', keys: ['plan_critic', 'enabled'], value };
    } else {
      const stepMatch = settingPath.match(/^steps\.([A-Za-z_]+)\.write_zones\.mode$/);
      if (stepMatch) {
        if (!ALLOWED_MODES.has(value)) return res.status(400).json({ error: `value must be one of [${[...ALLOWED_MODES].join(', ')}]` });
        yamlEditDescriptor = { kind: 'step', stepName: stepMatch[1], keys: ['write_zones', 'mode'], value };
      } else {
        return res.status(400).json({ error: `path "${settingPath}" not in the toggle-only whitelist. Allowed: ticket_schema.mode, plan_critic.enabled, steps.<name>.write_zones.mode. Full editing pending PIPE-005.` });
      }
    }

    // Apply to the in-memory config (so /api/projects/:id/config returns
    // the new value immediately) AND persist to the YAML file. Order:
    // file first, then in-memory — if the write fails, the in-memory
    // state isn't desynced from disk.
    const yamlPath = target._resolved?.configPath;
    if (!yamlPath) return res.status(500).json({ error: 'project has no configPath; cannot persist' });
    let raw;
    try {
      raw = await readFileFs(yamlPath, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `failed to read ${yamlPath}: ${err.message}` });
    }

    // Edit YAML by parsing → mutating → re-stringifying. Loses comments and
    // formatting (acceptable for toggle-only MVP; full PIPE-005 will use a
    // round-trip-preserving YAML editor or section-targeted regex edits).
    let parsed;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      return res.status(500).json({ error: `existing YAML is unparseable: ${err.message}` });
    }
    if (yamlEditDescriptor.kind === 'simple') {
      let cur = parsed;
      for (let i = 0; i < yamlEditDescriptor.keys.length - 1; i++) {
        const k = yamlEditDescriptor.keys[i];
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
      }
      cur[yamlEditDescriptor.keys[yamlEditDescriptor.keys.length - 1]] = yamlEditDescriptor.value;
    } else if (yamlEditDescriptor.kind === 'step') {
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const step = steps.find((s) => s?.name === yamlEditDescriptor.stepName);
      if (!step) return res.status(400).json({ error: `step "${yamlEditDescriptor.stepName}" not found in config` });
      let cur = step;
      for (let i = 0; i < yamlEditDescriptor.keys.length - 1; i++) {
        const k = yamlEditDescriptor.keys[i];
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
      }
      cur[yamlEditDescriptor.keys[yamlEditDescriptor.keys.length - 1]] = yamlEditDescriptor.value;
    }

    let serialized;
    try {
      serialized = stringifyYaml(parsed, { lineWidth: 0 });
    } catch (err) {
      return res.status(500).json({ error: `failed to serialise YAML: ${err.message}` });
    }
    try {
      await writeFileFs(yamlPath, serialized, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `failed to write ${yamlPath}: ${err.message}` });
    }

    // Reload BOTH (a) the projects Map entry — that's where /api/projects/:id
    // reads from on subsequent requests, and (b) the active config holder if
    // this project is currently active. Index.js shallow-clones the Map entry
    // into the runtime config holder, so they're SEPARATE objects with the
    // same configPath. Updating only one leaves the other stale.
    try {
      if (projects && projects.has(targetId)) {
        await reloadConfig(projects.get(targetId));
      }
      if (targetId === (config._activeProjectId || config.name || 'default')) {
        await reloadConfig(config);
        // reloadConfig overwrites the _ fields too — restore them.
        Object.defineProperty(config, '_projects', { value: projects, enumerable: false });
        Object.defineProperty(config, '_activeProjectId', { value: targetId, enumerable: false, writable: true });
      }
    } catch (err) {
      console.error(`[settings] write succeeded but reload failed: ${err.message}`);
    }

    emitter.emit('project_settings_updated', { id: targetId, path: settingPath, value });
    console.log(`[settings] ${targetId}: ${settingPath} = ${JSON.stringify(value)}`);
    res.json({ ok: true, id: targetId, path: settingPath, value });
  });

  // PIPE-005: full config replace. Writes a fresh YAML to the project's
  // configPath, with a sibling .yaml.bak backup of the previous content
  // so a bad save can be rolled back manually. Refused if THIS project's
  // pipeline is running. Reload semantics match the toggle endpoint
  // above (both projects Map entry AND active config holder).
  //
  // Body: { config: <full YAML-equivalent JSON> }. The body's config
  // must include name + project_dir matching the route param (no
  // accidental project rename / repath via this endpoint).
  app.put('/api/projects/:id/config', async (req, res) => {
    const targetId = req.params.id;
    if (activePipelines.has(targetId)) {
      return res.status(409).json({ error: `cannot edit settings while project ${targetId}'s pipeline is running. POST /api/projects/${targetId}/stop first or wait for it to finish.` });
    }
    const projects = config._projects;
    const target = projects ? projects.get(targetId) : (targetId === (config._activeProjectId || config.name || 'default') ? config : null);
    if (!target) return res.status(404).json({ error: `project ${targetId} not found` });

    const newConfig = req.body?.config;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'request body must be { config: <object> }' });
    }
    // Identity guard: name + project_dir must match the existing
    // project. Renaming a project is a separate operation; this
    // endpoint is for editing a project's settings in place.
    if (newConfig.name && newConfig.name !== target.name) {
      return res.status(400).json({ error: `body.config.name (${newConfig.name}) must match existing name (${target.name}). Renaming is not supported via this endpoint.` });
    }
    if (newConfig.project_dir && newConfig.project_dir !== target.project_dir) {
      return res.status(400).json({ error: `body.config.project_dir cannot be changed via this endpoint. Existing: ${target.project_dir}. Submitted: ${newConfig.project_dir}.` });
    }

    const yamlPath = target._resolved?.configPath;
    if (!yamlPath) return res.status(500).json({ error: 'project has no configPath; cannot persist' });

    let prevRaw;
    try {
      prevRaw = await readFileFs(yamlPath, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `failed to read ${yamlPath}: ${err.message}` });
    }
    // Sanity: serialise the new config first; if YAML serialisation
    // throws, we abort BEFORE touching disk.
    let serialized;
    try {
      // Strip any private fields the client might have echoed back.
      const clean = {};
      for (const [k, v] of Object.entries(newConfig)) if (!k.startsWith('_')) clean[k] = v;
      serialized = stringifyYaml(clean, { lineWidth: 0 });
    } catch (err) {
      return res.status(400).json({ error: `failed to serialise config: ${err.message}` });
    }

    // Backup, then write. Operator can `mv {path}.yaml.bak {path}` to
    // roll back if the new config breaks something on next load.
    const backupPath = `${yamlPath}.bak`;
    try {
      await writeFileFs(backupPath, prevRaw, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `failed to write backup ${backupPath}: ${err.message}` });
    }
    try {
      await writeFileFs(yamlPath, serialized, 'utf-8');
    } catch (err) {
      return res.status(500).json({ error: `failed to write ${yamlPath}: ${err.message}` });
    }

    // Reload BOTH (a) the projects Map entry — that's where
    // /api/projects/:id reads from — and (b) the active config holder
    // if this project is currently active.
    try {
      if (projects && projects.has(targetId)) {
        await reloadConfig(projects.get(targetId));
      }
      if (targetId === (config._activeProjectId || config.name || 'default')) {
        await reloadConfig(config);
        Object.defineProperty(config, '_projects', { value: projects, enumerable: false });
        Object.defineProperty(config, '_activeProjectId', { value: targetId, enumerable: false, writable: true });
      }
    } catch (err) {
      console.error(`[settings] write succeeded but reload failed: ${err.message}`);
      return res.status(500).json({
        error: `wrote config but reload failed: ${err.message}. To roll back: mv ${backupPath} ${yamlPath} && curl -X POST http://localhost:${config.server.port}/api/backlog/refresh`,
      });
    }

    emitter.emit('project_settings_updated', { id: targetId, path: '<full-config>', value: '<replaced>' });
    console.log(`[settings] ${targetId}: full config replaced (backup at ${backupPath})`);
    res.json({ ok: true, id: targetId, backupPath });
  });

  app.post('/api/projects/:id/activate', async (req, res) => {
    // PIPE-008: dropping the running-pipeline guard. Activate is now a
    // *display* preference — switches which project the dashboard's
    // top-level routes (/api/backlog, /api/run/all, /api/stop) operate
    // on. Pipelines running on other projects keep running independently;
    // the operator just changes which one the picker is currently
    // looking at. Per-project routes (/api/projects/:id/run/all,
    // /api/projects/:id/stop, etc.) work regardless of who's active.
    const targetId = req.params.id;
    const projects = config._projects;
    if (!projects || !projects.has(targetId)) {
      return res.status(404).json({ error: `project ${targetId} not found. Available: ${projects ? [...projects.keys()].join(', ') : '(single-config mode)'}` });
    }
    const target = projects.get(targetId);
    // In-place mutation preserves the config object identity so closures
    // (route handlers that captured `config`) see the new active project
    // without needing to re-bind. Same pattern as reloadConfig. Critical:
    // shallow-clone `target` first — assigning the Map entry directly
    // would alias config and target, and the next switch's
    // delete-loop would destroy both.
    const preservedProjects = config._projects;
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, { ...target });
    Object.defineProperty(config, '_projects', { value: preservedProjects, enumerable: false });
    Object.defineProperty(config, '_activeProjectId', { value: targetId, enumerable: false, writable: true });
    // Persist so a hard restart (start.sh, not a PIPE-019 exit-75
    // relaunch) resumes this project instead of the alphabetical default.
    persistActiveProject(targetId);
    emitter.emit('project_activated', { id: targetId, name: config.name });
    console.log(`[projects] activated ${targetId} (project_dir=${config.project_dir})`);
    res.json({ active: targetId, name: config.name, project_dir: config.project_dir });
  });

  // Load primary + v2 backlogs and tag each ticket with `backlog:'primary'|'v2'`
  // so the UI can distinguish them. Without the marker, v2 items leak into the
  // runnable list (UI filters via `t.backlog !== 'v2'`). Both /api/backlog and
  // /api/backlog/refresh return the same shape — when one drifts from the
  // other, the page-refresh and refresh-button views disagree (2026-04-25).
  async function loadFullBacklog() {
    const tickets = await loadBacklog(config);
    const actionable = filterAndSort(tickets, config);
    let v2Tickets = [];
    try {
      const v2Raw = await readFile(resolve(config.project_dir, config.backlog_v2_file || 'state/backlog-v2.json'), 'utf-8');
      const parsed = JSON.parse(v2Raw).tickets || [];
      v2Tickets = parsed.map((t) => ({ ...t, backlog: 'v2' }));
    } catch {}
    const taggedPrimary = tickets.map((t) => ({ ...t, backlog: 'primary' }));
    const all = [...taggedPrimary, ...v2Tickets];
    return { all, actionable, v2: v2Tickets, total: all.length, actionableCount: actionable.length };
  }

  // API: get full backlog (all tickets from all sources)
  app.get('/api/backlog', async (req, res) => {
    try {
      res.json(await loadFullBacklog());
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
      const payload = await loadFullBacklog();
      emitter.emit('backlog_refreshed', { total: payload.total, actionable: payload.actionableCount });
      res.json(payload);
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
        const v2Raw = await readFile(resolve(config.project_dir, config.backlog_v2_file || 'state/backlog-v2.json'), 'utf-8');
        v2Tickets = JSON.parse(v2Raw).tickets || [];
      } catch {}
      const all = [...tickets, ...v2Tickets];
      emitter.emit('backlog_reordered', { ticketId, direction });
      res.json({ all, actionable, total: all.length, actionableCount: actionable.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PIPE-008: shared helpers for run-all and run-ticket. Both project-
  // scoped (POST /api/projects/:id/run/...) and top-level backwards-
  // compat (POST /api/run/...; dispatches to active project) use these.

  // Single error-mapper so the same Pipeline error codes return the
  // same HTTP statuses everywhere. Logs include the project id so
  // multi-project log streams stay readable.
  function sendStartError(res, projectId, err) {
    if (err.code === 'ALREADY_RUNNING') return res.status(409).json({ error: err.message });
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    console.error(`[pipeline:${projectId}] start failed:`, err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }

  async function handleRunAll(projectId, body, res) {
    const dryRun = body?.dryRun || false;
    // Hard-fail BEFORE touching anything: project must be loaded. Don't
    // fall back to the active project — that would silently route the
    // request to the wrong pipeline.
    const projectCfg = configForProject(projectId);
    if (!projectCfg) {
      return res.status(404).json({ error: `project ${projectId} not loaded` });
    }
    // Read the backlog FIRST. Two reasons: (1) if loadBacklog throws,
    // we 500 cleanly without leaving a half-started pipeline; (2) the
    // ticketCount in the response is computed from the same snapshot
    // the pipeline is about to consume, not from a second read after
    // start (which could disagree with what the pipeline actually runs).
    let actionableCount;
    try {
      const tickets = await loadBacklog(projectCfg);
      actionableCount = filterAndSort(tickets, projectCfg).length;
    } catch (err) {
      console.error(`[pipeline:${projectId}] backlog load failed:`, err.stack || err.message);
      return res.status(500).json({ error: `backlog load failed: ${err.message}` });
    }
    try {
      emitter.emit('run_requested', { project: projectId, ticket: 'all', dryRun });
      startPipeline(projectId, { dryRun });
      res.json({ status: 'started', project: projectId, ticketCount: actionableCount, dryRun });
    } catch (err) {
      sendStartError(res, projectId, err);
    }
  }
  function handleRunTicket(projectId, ticketId, body, res) {
    const dryRun = body?.dryRun || false;
    if (!configForProject(projectId)) {
      return res.status(404).json({ error: `project ${projectId} not loaded` });
    }
    try {
      emitter.emit('run_requested', { project: projectId, ticket: ticketId, dryRun });
      startPipeline(projectId, { ticketId, dryRun });
      res.json({ status: 'started', project: projectId, ticket: ticketId, dryRun });
    } catch (err) {
      sendStartError(res, projectId, err);
    }
  }
  // Returns the active project id, or null after writing a 400. The
  // previous fallback to literal `'default'` made the 400 unreachable
  // and silently routed top-level requests to a project literally named
  // 'default' even when none was configured. Now: if neither
  // _activeProjectId nor config.name is set, the caller gets a clear
  // 400 telling them to use the project-scoped endpoint.
  function activeProjectIdOr400(res) {
    const id = config._activeProjectId || config.name;
    if (!id) {
      res.status(400).json({ error: 'no active project set; use /api/projects/:id/run/* with an explicit project id, or POST /api/projects/:id/activate first' });
      return null;
    }
    return id;
  }

  // API: run a single ticket on the ACTIVE project (backwards-compat)
  app.post('/api/run/ticket/:ticketId', async (req, res) => {
    const projectId = activeProjectIdOr400(res); if (!projectId) return;
    handleRunTicket(projectId, req.params.ticketId, req.body, res);
  });

  // API: run all actionable tickets on the ACTIVE project (backwards-compat)
  app.post('/api/run/all', async (req, res) => {
    const projectId = activeProjectIdOr400(res); if (!projectId) return;
    handleRunAll(projectId, req.body, res);
  });

  // PIPE-008: project-scoped run endpoints. Same shape, explicit project.
  app.post('/api/projects/:id/run/all', async (req, res) => {
    handleRunAll(req.params.id, req.body, res);
  });
  app.post('/api/projects/:id/run/ticket/:ticketId', async (req, res) => {
    handleRunTicket(req.params.id, req.params.ticketId, req.body, res);
  });

  // Re-queue a stuck ticket. Archives the existing pipeline-state JSON
  // (preserves the audit trail) so the next pipeline run sees no state
  // for this ticket and starts fresh from `requested`. Does NOT trigger
  // a run — the operator decides when to re-process. Idempotent: if no
  // state file exists, returns ok with archived:false.
  app.post('/api/projects/:id/tickets/:ticketId/requeue', async (req, res) => {
    const projectId = req.params.id;
    const ticketId = req.params.ticketId;
    const cfg = configForProject(projectId);
    if (!cfg) return res.status(404).json({ error: `project ${projectId} not loaded` });
    if (activePipelines.has(projectId)) {
      return res.status(409).json({ error: `pipeline is running for project ${projectId}; stop it before re-queueing` });
    }
    try {
      const { existsSync } = await import('fs');
      const { mkdir, rename, readFile: rf, writeFile: wf } = await import('fs/promises');
      const { resolve: rsv } = await import('path');
      const liveDir = cfg._resolved.pipelineDir;
      const archiveDir = rsv(liveDir, 'archive');
      const stateFile = rsv(liveDir, `${ticketId}.json`);
      let archivedTo = null;
      if (existsSync(stateFile)) {
        await mkdir(archiveDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        archivedTo = rsv(archiveDir, `${ticketId}.requeued-${stamp}.json`);
        await rename(stateFile, archivedTo);
      }
      // Defensive: ensure backlog ticket status is `requested`, since
      // a `failed` state would be odd for a re-queued ticket. Schema
      // validation lives in the MCP/CRUD path; here we just patch the
      // status field if the ticket exists in the backlog.
      const backlogPath = cfg._resolved.backlog;
      let backlogUpdated = false;
      if (existsSync(backlogPath)) {
        const data = JSON.parse(await rf(backlogPath, 'utf-8'));
        const idx = (data.tickets || []).findIndex((t) => t.id === ticketId);
        if (idx >= 0 && data.tickets[idx].status !== 'requested') {
          data.tickets[idx].status = 'requested';
          data.updated_at = new Date().toISOString().slice(0, 10);
          await wf(backlogPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
          backlogUpdated = true;
        }
      }
      emitter.emit('ticket_requeued', { project: projectId, ticket: ticketId, archived: !!archivedTo, backlogUpdated });
      res.json({ project: projectId, ticket: ticketId, archived: !!archivedTo, archivedTo, backlogUpdated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PIPE-008: project-scoped stop. Stops the pipeline running for that
  // specific project (if any). Other projects' pipelines are untouched.
  // 404 not 400: the request is well-formed; the resource just doesn't
  // exist (no running pipeline for that id).
  app.post('/api/projects/:id/stop', async (req, res) => {
    const projectId = req.params.id;
    if (!configForProject(projectId)) {
      return res.status(404).json({ error: `project ${projectId} not loaded` });
    }
    if (activePipelines.has(projectId)) {
      emitter.emit('stop_requested', { project: projectId });
      const result = await stopPipeline(projectId);
      return res.json({ status: 'stopped', project: projectId, subprocessKilled: result.killed });
    }
    return res.status(404).json({ error: `no pipeline running for project ${projectId}` });
  });

  // API: stop pipeline. PIPE-009: stop is always decisive — SIGTERMs
  // the active Claude subprocess (escalates to SIGKILL after 5s).
  // Subprocess dies in seconds, step throws, run() rejects, map entry
  // is cleaned. The previous soft-stop semantic (hard=false: release
  // lock and walk away while the pipeline kept running) was a lie and
  // produced a dangerous race window where the lockfile was gone but
  // a worker was still alive. Removed; `hard` query/body params are
  // ignored (no breakage, just no-op).
  //
  // PIPE-008: this endpoint stops the ACTIVE PROJECT's pipeline only.
  // Use /api/projects/:id/stop to stop a non-active project's run.
  // PIPE-019: graceful restart-between-tickets. Arms a sticky flag on the
  // running pipeline; the CURRENT ticket finishes (and is cherry-picked)
  // and then run() exits with RESTART_EXIT_CODE so the start.sh supervisor
  // relaunches node on freshly-deployed code. The queue resumes
  // automatically — already-done tickets are skipped via pipeline-state.
  // Unlike /api/stop this does NOT kill the subprocess (no work is lost).
  app.post('/api/restart-after-ticket', async (req, res) => {
    const projectId = config._activeProjectId || config.name || 'default';
    const entry = activePipelines.get(projectId);
    if (!entry) {
      return res.status(400).json({
        error: 'No pipeline running — nothing to restart between tickets. Restart the server normally to pick up new code.',
      });
    }
    const { pipeline } = entry;
    if (typeof pipeline.requestRestartAfterTicket !== 'function') {
      return res.status(409).json({
        error: 'Running pipeline pre-dates graceful restart (PIPE-019). Use /api/stop, then restart.',
      });
    }
    pipeline.requestRestartAfterTicket();
    emitter.emit('restart_after_ticket_requested', { project: projectId });
    return res.json({
      status: 'restart_armed',
      project: projectId,
      note: 'Current ticket will finish, then the server restarts and the queue continues.',
    });
  });

  app.post('/api/stop', async (req, res) => {
    const projectId = config._activeProjectId || config.name || 'default';

    // Happy path: pipeline reference still live.
    if (activePipelines.has(projectId)) {
      emitter.emit('stop_requested', { project: projectId });
      const result = await stopPipeline(projectId);
      return res.json({ status: 'stopped', project: projectId, subprocessKilled: result.killed });
    }

    // Orphan path: no map entry for the active project (Pipeline.run()
    // already resolved/rejected and .finally() cleaned up) but a Claude
    // child may still be alive editing files. Before this branch existed
    // the endpoint would 400 and leave the subprocess orphaned. Note:
    // post-PIPE-008 this scans for orphans server-wide, not per-project
    // — the spawn relationship doesn't carry project metadata, so any
    // orphaned `claude` child of this server gets cleaned up.
    //
    // PIPE-009: the previous "soft" path (409 with a hint to retry with
    // hard=true) is gone. If the orphan exists, it's by definition NOT
    // doing pipeline-orchestrated work (the pipeline finished already);
    // it's just a stuck worker. Always SIGTERM.
    const orphans = findOrphanClaudeChildren();
    if (orphans.length === 0) {
      return res.status(400).json({ error: 'No pipeline running' });
    }

    emitter.emit('stop_requested', { orphans: orphans.length });

    // Three distinct terminal states per orphan:
    //   signaled     — SIGTERM delivered; SIGKILL attempted at +5s if still alive
    //                  and starttime still matches (guards against PID reuse).
    //   alreadyDead  — ESRCH between scan and kill (process had already exited)
    //   failed       — EPERM or other kill error (orphan is still alive)
    // Lock release gates on `failed === 0`; alreadyDead counts as resolved.
    let orphansSignaled = 0;
    let orphansAlreadyDead = 0;
    let orphansFailed = 0;
    for (const { pid, starttime } of orphans) {
      try {
        process.kill(pid, 'SIGTERM');
        orphansSignaled++;
        // SIGKILL fallback at +5s, gated on starttime match so we don't hit
        // an unrelated process that recycled the same PID. .unref() lets
        // the node process exit on SIGTERM without waiting for this timer —
        // worst case a half-stopped claude survives a server shutdown; that's
        // better than blocking shutdown indefinitely.
        setTimeout(() => {
          const still = procStarttime(pid);
          if (still && still === starttime) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          }
        }, 5000).unref();
      } catch (err) {
        if (err && err.code === 'ESRCH') {
          orphansAlreadyDead++;
          console.log(`[stop] ${pid} already exited before SIGTERM`);
        } else {
          orphansFailed++;
          console.warn(`[stop] SIGTERM ${pid} failed: ${err.code || '?'}: ${err.message || err}`);
        }
      }
    }

    // Release the code lock only when no orphan signal failed. `alreadyDead`
    // is a success — the process we wanted gone is gone — so it doesn't
    // block release. A partial `failed` (e.g. one of three EPERM'd) means a
    // survivor is still editing files; clearing the lock would let the next
    // run clobber its changes. Callers hitting that state can fall back to
    // /api/unlock once they've dealt with the stuck orphan.
    let lockReleased = false;
    const safeToReleaseLock = orphansFailed === 0;
    if (safeToReleaseLock) {
      try {
        lockReleased = await releaseLock(config._resolved.codeLock);
        if (lockReleased) emitter.emit('lock_released', { forced: true, reason: 'orphan_stop' });
      } catch (err) {
        console.warn(`[stop] releaseLock(${config._resolved.codeLock}) failed: ${err.code || '?'}: ${err.message || err}`);
      }
    } else {
      emitter.emit('lock_release_skipped', {
        reason: 'orphan_signal_failures',
        orphansSignaled,
        orphansAlreadyDead,
        orphansFailed,
      });
    }

    res.json({
      status: 'stopped',
      orphansFound: orphans.length,
      orphansSignaled,
      orphansAlreadyDead,
      orphansFailed,
      lockReleased,
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
      res.json({ count: results.length, tickets: results, project: config._activeProjectId || config.name || 'default' });
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

  // Bulk pipeline-state status for the sidebar's per-ticket color cue.
  // Returns { ticketId: { status, blocked_step? } } — slim payload, only
  // the fields the sidebar needs.
  //
  // PIPE-011 fixes:
  //   - async fs.readFile (parallel) instead of synchronous readFileSync
  //     (serial + blocks the event loop on every poll).
  //   - filename filter is explicit: ACTIVE state files only, where the
  //     filename matches the v1 ticket-id shape exactly + `.json`.
  //     Archive files (`{id}.failed-{date}.json`, `.salvaged-`, `.closed-`)
  //     are skipped because the dashboard wants the LIVE per-ticket
  //     status, not historical attempts.
  //   - JSON parse errors are logged (file name + first 200 chars of
  //     error) instead of silently swallowed; the entry is omitted but
  //     the corruption is visible.
  app.get('/api/pipeline-states', async (req, res) => {
    try {
      const dir = config._resolved.pipelineDir;
      const out = {};
      // Active state file = same shape as ticket id (BUG-261, T-359,
      // BUG-261A, PIPE-001, T-202v1) followed by `.json`. Archive
      // variants always have a `.` between the id and a suffix like
      // `failed-...`, so requiring exactly `<id>.json` excludes them.
      const ACTIVE_RE = /^([A-Z][A-Z0-9]*-\d+[A-Za-z0-9]*)\.json$/;
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        // pipeline-state dir doesn't exist yet for fresh projects.
        return res.json({});
      }
      const activeFiles = names.filter((f) => ACTIVE_RE.test(f));
      const results = await Promise.all(activeFiles.map(async (f) => {
        const ticketId = f.replace(/\.json$/, '');
        try {
          const raw = await readFile(resolve(dir, f), 'utf-8');
          const state = JSON.parse(raw);
          return [ticketId, { status: state.status || null, blocked_step: state.blocked_step || null }];
        } catch (err) {
          console.warn(`[pipeline-states] could not read ${f}: ${(err.message || String(err)).slice(0, 200)}`);
          return null;
        }
      }));
      for (const r of results) {
        if (r) out[r[0]] = r[1];
      }
      res.json(out);
    } catch (err) {
      console.error('[pipeline-states] route error:', err.stack || err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PIPE-010: bind with retry + fail-loud-on-give-up.
  //
  // The kernel can take up to a couple seconds to release a listening
  // socket after the previous server's parent exits — a common race
  // when start.sh restarts the server after a SIGKILL fallback.
  // Retry every 100ms for up to 2s before giving up.
  //
  // The previous fallback ("running without UI server") was actively
  // harmful: the process kept running but bound nothing, so MCP and the
  // dashboard were unreachable. Operators only noticed when other
  // sessions hit timeouts. Better to exit(1) loud and let the
  // supervisor (start.sh) handle the restart.
  return new Promise((resolvePromise, rejectPromise) => {
    const port = config.server.port;
    const host = config.server.host;
    const MAX_ATTEMPTS = 20;
    const RETRY_INTERVAL_MS = 100;
    let attempt = 0;
    const tryListen = () => {
      attempt++;
      const server = app.listen(port, host, () => {
        if (attempt > 1) console.log(`HTTP server bound on attempt ${attempt} (${(attempt - 1) * RETRY_INTERVAL_MS}ms after first try)`);
        resolvePromise({ emitter, server });
      });
      server.on('error', (err) => {
        if (err.code !== 'EADDRINUSE') {
          rejectPromise(err);
          return;
        }
        if (attempt < MAX_ATTEMPTS) {
          setTimeout(tryListen, RETRY_INTERVAL_MS);
          return;
        }
        // Exhausted retries — fail loud rather than running headless.
        // 2s should be enough for any sane SIGKILL → kernel-reap window;
        // beyond that, something else is genuinely holding the port and
        // the operator needs to know.
        console.error(`FATAL: port ${port} still bound after ${MAX_ATTEMPTS * RETRY_INTERVAL_MS}ms of retries. Aborting. Inspect with \`ss -tlnp | grep ${port}\`.`);
        process.exit(1);
      });
    };
    tryListen();
  });
}
