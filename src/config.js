import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'path';

export async function loadConfig(configPath) {
  const raw = await readFile(resolve(configPath), 'utf-8');
  const config = parseYaml(raw);

  // Resolve paths relative to project_dir
  const dir = config.project_dir;
  config._resolved = {
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
