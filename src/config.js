import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'path';

export async function loadConfig(configPath) {
  const absPath = resolve(configPath);
  const raw = await readFile(absPath, 'utf-8');
  const config = parseYaml(raw);

  // Resolve paths relative to project_dir
  const dir = config.project_dir;
  config._resolved = {
    configPath: absPath,
    backlog: resolve(dir, config.backlog_file),
    archive: resolve(dir, config.archive_file),
    closedBugs: resolve(dir, config.closed_bugs_file),
    validationRules: resolve(dir, config.validation_rules),
    pipelineDir: resolve(dir, config.pipeline_dir),
    buildLogDir: resolve(dir, config.build_log_dir),
    codeLock: resolve(dir, config.code_lock),
    contextFiles: config.context_files.map((f) => resolve(dir, f)),
  };

  return config;
}

// Hot-reload: re-parse the source file and mutate the live config in
// place so closures holding the object (server.js, Pipeline instances
// created per run) see the new values without needing a process restart.
// Callers should pass the `config` returned from the initial loadConfig.
// Returns the updated config (same reference as input), or null on error.
export async function reloadConfig(config) {
  if (!config?._resolved?.configPath) return null;
  const raw = await readFile(config._resolved.configPath, 'utf-8');
  const next = parseYaml(raw);
  // Preserve _resolved since its entries are re-derived below.
  const dir = next.project_dir;
  next._resolved = {
    configPath: config._resolved.configPath,
    backlog: resolve(dir, next.backlog_file),
    archive: resolve(dir, next.archive_file),
    closedBugs: resolve(dir, next.closed_bugs_file),
    validationRules: resolve(dir, next.validation_rules),
    pipelineDir: resolve(dir, next.pipeline_dir),
    buildLogDir: resolve(dir, next.build_log_dir),
    codeLock: resolve(dir, next.code_lock),
    contextFiles: (next.context_files || []).map((f) => resolve(dir, f)),
  };
  // In-place mutation — drop old keys, copy new ones. This keeps the
  // object identity that closures depend on.
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, next);
  return config;
}
