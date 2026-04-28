import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { resolve, dirname } from 'path';

// Pipeline working data ({tickets-state, worker-output, build-log}) lives
// under {pipelineHome}/projects/{config.name}/ — never inside the project
// being worked on. Pre-2026-04-28 these paths were relative to project_dir
// and polluted the project repo with pipeline-only state files. Now they
// follow the pipeline binary.
function resolveAll(absConfigPath, config) {
  const projectDir = config.project_dir;
  const pipelineHome = dirname(absConfigPath);
  const projectName = config.name || 'default';
  const projectWorkDir = resolve(pipelineHome, 'projects', projectName);
  return {
    configPath: absConfigPath,
    pipelineHome,
    projectWorkDir,
    // Project-owned (still resolved against the project being worked on).
    backlog: resolve(projectDir, config.backlog_file),
    archive: resolve(projectDir, config.archive_file),
    closedBugs: resolve(projectDir, config.closed_bugs_file),
    validationRules: resolve(projectDir, config.validation_rules),
    codeLock: resolve(projectDir, config.code_lock),
    contextFiles: (config.context_files || []).map((f) => resolve(projectDir, f)),
    // Pipeline-owned working data — under projectWorkDir, NOT in the
    // project being worked on. Operator never sees these in `git status`
    // because they're outside the project repo entirely.
    pipelineDir: resolve(projectWorkDir, 'pipeline-state'),
    workerOutputDir: resolve(projectWorkDir, 'worker-output'),
    buildLogDir: resolve(projectWorkDir, 'build-log'),
  };
}

export async function loadConfig(configPath) {
  const absPath = resolve(configPath);
  const raw = await readFile(absPath, 'utf-8');
  const config = parseYaml(raw);
  config._resolved = resolveAll(absPath, config);
  return config;
}

// Hot-reload: re-parse the source file and mutate the live config in
// place so closures holding the object (server.js, Pipeline instances
// created per run) see the new values without needing a process restart.
// Callers should pass the `config` returned from the initial loadConfig.
// Returns the updated config (same reference as input), or null on error.
export async function reloadConfig(config) {
  if (!config?._resolved?.configPath) return null;
  const absPath = config._resolved.configPath;
  const raw = await readFile(absPath, 'utf-8');
  const next = parseYaml(raw);
  next._resolved = resolveAll(absPath, next);
  // In-place mutation — drop old keys, copy new ones. This keeps the
  // object identity that closures depend on.
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, next);
  return config;
}
