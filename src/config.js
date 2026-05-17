import { readFile, readdir } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// Pipeline working data ({tickets-state, worker-output, build-log}) lives
// under {pipelineHome}/projects/{config.name}/ — never inside the project
// being worked on. Pre-2026-04-28 these paths were relative to project_dir
// and polluted the project repo with pipeline-only state files. Now they
// follow the pipeline binary.
//
// PIPE-012 fix (2026-05-05): pipelineHome is derived from THIS file's
// location, not from the config file's location. Pre-fix: it was
// `dirname(absConfigPath)`, which worked when configs lived at
// ~/toshelabs-pipeline/pipeline.config.yaml (legacy single-config mode)
// but broke under PIPE-003 multi-project — registry configs at
// ~/.toshelabs/projects/*.yaml gave pipelineHome=~/.toshelabs/projects,
// then projectWorkDir=~/.toshelabs/projects/projects/{name} (duplicate
// 'projects/' segment). Result: every registry-loaded project leaked
// pipeline-state, worker-output, and worktree into the registry dir.
// Override via PIPELINE_HOME env var if you want pipeline working data
// to live elsewhere (e.g. on a separate disk).
const PIPELINE_HOME = process.env.PIPELINE_HOME
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveAll(absConfigPath, config) {
  const projectDir = config.project_dir;
  const pipelineHome = PIPELINE_HOME;
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
    // Worktree path: where the pipeline runs each ticket. The
    // operator's primary checkout (project_dir) stays untouched while
    // a ticket is in progress. Pinned to side branch
    // `pipeline/worktree-{name}`.
    projectWorktree: resolve(projectWorkDir, 'worktree'),
    projectWorktreeBranch: `pipeline/worktree-${projectName}`,
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

/**
 * PIPE-003: multi-project loader. Returns a Map<projectId, config> covering:
 *
 *   1. The legacy single config at `legacyConfigPath` (typically
 *      pipeline.config.yaml in the pipeline repo root). Loaded under the
 *      project id from its `name` field, or 'default' if missing. Skipped
 *      silently when the file doesn't exist.
 *   2. Every YAML file under `registryDir` (default ~/.toshelabs/projects/).
 *      Project id = filename without .yaml. Skipped silently when the
 *      directory doesn't exist.
 *
 * Both sources can coexist during the migration window — operators can
 * gradually move projects from the legacy single-config file into the
 * registry directory at their own pace. A registry entry with the same
 * id as the legacy config wins (registry is canonical).
 *
 * Returns at minimum an empty Map if neither source has content; callers
 * should error if they need at least one project loaded.
 */
export async function loadAllConfigs({ legacyConfigPath = 'pipeline.config.yaml', registryDir = null } = {}) {
  const projects = new Map();
  const effectiveRegistry = registryDir || resolve(homedir(), '.toshelabs', 'projects');

  // 1. Legacy single config (backwards-compat).
  if (legacyConfigPath && existsSync(resolve(legacyConfigPath))) {
    try {
      const cfg = await loadConfig(legacyConfigPath);
      const id = cfg.name || 'default';
      projects.set(id, cfg);
    } catch (err) {
      console.error(`[config] failed to load legacy ${legacyConfigPath}: ${err.message}`);
    }
  }

  // 2. Registry directory (per-project files).
  if (existsSync(effectiveRegistry)) {
    let files = [];
    try {
      files = (await readdir(effectiveRegistry)).filter((f) => /\.ya?ml$/i.test(f));
    } catch (err) {
      console.error(`[config] failed to read registry ${effectiveRegistry}: ${err.message}`);
    }
    for (const f of files) {
      const id = basename(f).replace(/\.ya?ml$/i, '');
      try {
        const cfg = await loadConfig(resolve(effectiveRegistry, f));
        projects.set(id, cfg); // registry wins if id collides with legacy
      } catch (err) {
        console.error(`[config] failed to load ${f}: ${err.message}`);
      }
    }
  }

  return projects;
}

// Persisted active-project preference. A hard restart (start.sh, not a
// PIPE-019 exit-75 relaunch) re-runs index.js with no --project, which
// previously defaulted to the first non-template id alphabetically —
// silently switching the active project out from under a multi-day run
// (observed 2026-05-17: predictor run resumed as busydad). Persist the
// last activated id here and prefer it on startup. Best-effort: a missing
// or unreadable file just falls back to the alphabetical default.
export function activeProjectFilePath() {
  return resolve(homedir(), '.toshelabs', 'active-project');
}

export function readPersistedActiveProject() {
  try {
    const id = readFileSync(activeProjectFilePath(), 'utf-8').trim();
    return id || null;
  } catch {
    return null;
  }
}

export function persistActiveProject(id) {
  try {
    writeFileSync(activeProjectFilePath(), String(id), 'utf-8');
    return true;
  } catch {
    return false; // best-effort — never block activation on a write failure
  }
}
