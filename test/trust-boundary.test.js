// Regression tests for F1+F2+F3 (audit 2026-04-26):
//
// F1 — scoped step state reload. After a worker runs, the orchestrator
//      reloads ONLY that step's slot from disk, preserving other steps
//      from the in-memory state. A worker writing `done` for unrelated
//      steps can't make them get skipped on the next loop iteration.
//
// F2 — squash-merge guard. Steps marked `done` must either have actually
//      executed in this run OR have a step tag from a prior run. A worker
//      forging `done` is now caught at merge time.
//
// F3 — tests_green specifically must have all_pass:true to ship even when
//      it executed (in case a self-heal worker rewrote the artifact).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pipeline } from '../src/pipeline.js';

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-trust-'));
  execSync('git init -q -b master', { cwd: dir });
  execSync('git config user.email t@t.t && git config user.name t && git config commit.gpgsign false', { cwd: dir });
  writeFileSync(join(dir, 'init.txt'), 'init\n');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

function makePipeline(projectDir) {
  const pipelineDir = mkdtempSync(join(tmpdir(), 'pipeline-state-'));
  mkdirSync(pipelineDir, { recursive: true });
  const p = new Pipeline({
    project_dir: projectDir,
    _resolved: { pipelineDir },
    steps: [],
  });
  p.emit = () => {};
  return { pipeline: p, pipelineDir };
}

describe('F1 — reloadStepFromDisk', () => {
  test('takes only the named step from disk; preserves other steps from prevState', async () => {
    const repo = makeProject();
    const { pipeline, pipelineDir } = makePipeline(repo);
    try {
      // Disk says everything is done (simulating a worker forgery).
      const onDisk = {
        ticket: 'T-X',
        status: 'in_progress',
        steps: {
          plan: { status: 'done', completed_at: 'disk' },
          tests_red: { status: 'done', completed_at: 'disk' },
          implement: { status: 'done', completed_at: 'disk' },
          tests_green: { status: 'done', completed_at: 'disk' },
        },
      };
      writeFileSync(join(pipelineDir, 'T-X.json'), JSON.stringify(onDisk));

      // In-memory state: only plan and tests_red were actually run.
      const prevState = {
        ticket: 'T-X',
        status: 'in_progress',
        steps: {
          plan: { status: 'done', completed_at: 'orchestrator' },
          tests_red: { status: 'done', completed_at: 'orchestrator' },
          implement: { status: 'pending', completed_at: null },
          tests_green: { status: 'pending', completed_at: null },
        },
      };

      // Reload only tests_red — disk's done-ish should land for tests_red,
      // but implement and tests_green stay pending.
      const merged = await pipeline.reloadStepFromDisk('T-X', 'tests_red', prevState);
      assert.equal(merged.steps.plan.completed_at, 'orchestrator', 'plan untouched');
      assert.equal(merged.steps.tests_red.completed_at, 'disk', 'tests_red taken from disk');
      assert.equal(merged.steps.implement.status, 'pending', 'implement protected from worker forgery');
      assert.equal(merged.steps.tests_green.status, 'pending', 'tests_green protected from worker forgery');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(pipelineDir, { recursive: true, force: true });
    }
  });

  test('returns prevState unchanged when no file on disk', async () => {
    const repo = makeProject();
    const { pipeline, pipelineDir } = makePipeline(repo);
    try {
      const prevState = { steps: { plan: { status: 'pending' } } };
      const merged = await pipeline.reloadStepFromDisk('T-NONE', 'plan', prevState);
      assert.deepEqual(merged, prevState);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(pipelineDir, { recursive: true, force: true });
    }
  });

  test('handles missing step on disk gracefully (no merge happens for that step)', async () => {
    const repo = makeProject();
    const { pipeline, pipelineDir } = makePipeline(repo);
    try {
      // Disk file exists but has no entry for the step we're reloading.
      writeFileSync(join(pipelineDir, 'T-Y.json'), JSON.stringify({
        ticket: 'T-Y',
        steps: { plan: { status: 'done' } },
      }));
      const prevState = { ticket: 'T-Y', steps: { plan: { status: 'pending' }, tests_red: { status: 'pending' } } };
      const merged = await pipeline.reloadStepFromDisk('T-Y', 'tests_red', prevState);
      // tests_red wasn't on disk → keep prev value.
      assert.equal(merged.steps.tests_red.status, 'pending');
      // plan wasn't asked for → keep prev value (NOT taken from disk).
      assert.equal(merged.steps.plan.status, 'pending');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(pipelineDir, { recursive: true, force: true });
    }
  });
});
