#!/usr/bin/env node

import { program } from 'commander';
import { loadConfig, loadAllConfigs } from './config.js';
import { startServer } from './server.js';
import { Pipeline } from './pipeline.js';

program
  .name('toshelabs-pipeline')
  .description('External pipeline orchestrator for Claude Code')
  .option('-c, --config <path>', 'Config file path', 'pipeline.config.yaml')
  .option('--project <id>', 'Project id to activate (PIPE-003 multi-project mode). When set, --config is ignored and the project is loaded from ~/.toshelabs/projects/{id}.yaml. When unset, falls back to legacy single-config behaviour using --config.')
  .option('--dry-run', 'Plan phase only — no implementation')
  .option('--ticket <id>', 'Only work on a specific ticket')
  .option('--pause', 'Pause between tickets for manual review')
  .option('--no-ui', 'Run without web UI')
  .option('--server', 'Start web UI only — no pipeline run')
  .option('-p, --port <number>', 'Web UI port override')
  .parse();

const opts = program.opts();

async function main() {
  // PIPE-003: multi-project loader. Combines the legacy single config
  // (--config / pipeline.config.yaml) with per-project files under
  // ~/.toshelabs/projects/. When --project is set, that project is
  // activated. Otherwise the active project is the legacy config (if
  // present) or the first registry entry by alphabetical filename.
  const projects = await loadAllConfigs({ legacyConfigPath: opts.config });
  if (projects.size === 0) {
    console.error(`[fatal] no projects loaded. Provide a config at ${opts.config} or place files under ~/.toshelabs/projects/.`);
    process.exit(1);
  }

  let activeId;
  if (opts.project) {
    if (!projects.has(opts.project)) {
      console.error(`[fatal] --project ${opts.project} not found. Loaded: ${[...projects.keys()].join(', ')}`);
      process.exit(1);
    }
    activeId = opts.project;
  } else {
    // Prefer the legacy config's project (loaded under its `name` field or 'default')
    activeId = [...projects.keys()][0];
  }
  // CRITICAL: shallow-clone the active project's config into a NEW
  // mutable holder. The `projects` Map stores the canonical configs
  // loaded from disk; mutating one of them in place (when switching
  // projects via /api/projects/:id/activate) would corrupt the Map
  // entry too, since the variable would have shared identity. The
  // holder gets identity-preserved (so closures keep working); the
  // Map entries stay intact for re-activation.
  const config = { ...projects.get(activeId) };
  Object.defineProperty(config, '_projects', { value: projects, enumerable: false });
  Object.defineProperty(config, '_activeProjectId', { value: activeId, enumerable: false, writable: true });

  if (opts.port) config.server.port = parseInt(opts.port);

  // Start web UI
  let emitter;
  if (opts.ui !== false || opts.server) {
    const result = await startServer(config);
    emitter = result.emitter;
    if (result.server) {
      console.log(`Pipeline UI: http://${config.server.host}:${config.server.port}`);
    }
  }

  // Server-only mode — just serve the UI, no pipeline
  if (opts.server) {
    console.log('Server mode — waiting for connections. Ctrl+C to stop.');
    await new Promise(() => {}); // hang forever
    return;
  }

  // Create and run pipeline
  const pipeline = new Pipeline(config, {
    dryRun: opts.dryRun,
    ticketId: opts.ticket,
    pause: opts.pause,
    emitter,
  });

  // Handle graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n${signal} received — releasing code lock...`);
    await pipeline.releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await pipeline.run();
}

main().catch((err) => {
  console.error('Pipeline fatal error:', err);
  process.exit(1);
});
