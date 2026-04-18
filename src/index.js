#!/usr/bin/env node

import { program } from 'commander';
import { loadConfig } from './config.js';
import { startServer } from './server.js';
import { Pipeline } from './pipeline.js';

program
  .name('toshelabs-pipeline')
  .description('External pipeline orchestrator for Claude Code')
  .option('-c, --config <path>', 'Config file path', 'pipeline.config.yaml')
  .option('--dry-run', 'Plan phase only — no implementation')
  .option('--ticket <id>', 'Only work on a specific ticket')
  .option('--pause', 'Pause between tickets for manual review')
  .option('--no-ui', 'Run without web UI')
  .option('--server', 'Start web UI only — no pipeline run')
  .option('-p, --port <number>', 'Web UI port override')
  .parse();

const opts = program.opts();

async function main() {
  const config = await loadConfig(opts.config);
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
