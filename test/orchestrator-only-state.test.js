// Architectural fix 2026-04-27: workers write to per-step output files, not
// the canonical pipeline state. Orchestrator validates against a per-step
// schema and merges only allowed fields. Anything else the worker writes
// — including writes to OTHER steps' slots — is silently dropped.
//
// Two test surfaces:
//   1. Pipeline.ingestWorkerOutput: schema gate + slot scoping.
//   2. scripts/state-write-protect.sh: PreToolUse hook denies writes to the
//      canonical state directory when PIPELINE_STATE_PROTECTED is set.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Pipeline } from '../src/pipeline.js';

const HOOK = resolve('scripts/state-write-protect.sh');

function makePipeline() {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-arch-'));
  const pipelineDir = join(root, 'state');
  const workerOut = join(root, 'worker-out');
  mkdirSync(pipelineDir, { recursive: true });
  mkdirSync(workerOut, { recursive: true });
  const p = new Pipeline({
    project_dir: root,
    _resolved: { pipelineDir, workerOutputDir: workerOut },
    steps: [],
  });
  p.emit = () => {};
  return { pipeline: p, root, pipelineDir, workerOut };
}

describe('Pipeline.ingestWorkerOutput — schema gate', () => {
  test('accepts schema-allowed fields and merges into named step slot', async () => {
    const { pipeline, workerOut, pipelineDir } = makePipeline();
    try {
      // Worker writes a per-step output file with allowed fields.
      mkdirSync(join(workerOut, 'T-X'), { recursive: true });
      writeFileSync(join(workerOut, 'T-X', 'plan.json'), JSON.stringify({
        status: 'done',
        files_to_change: [{ path: 'a.dart' }],
        edge_cases: ['null input'],
        risk: 'low',
      }));

      const state = { ticket: 'T-X', steps: { plan: { status: 'pending' } } };
      const ok = await pipeline.ingestWorkerOutput('T-X', 'plan', state);
      assert.equal(ok, true);
      assert.equal(state.steps.plan.status, 'done');
      assert.deepEqual(state.steps.plan.files_to_change, [{ path: 'a.dart' }]);
      assert.equal(state.steps.plan.risk, 'low');
    } finally {
      rmSync(pipelineDir, { recursive: true, force: true });
      rmSync(workerOut, { recursive: true, force: true });
    }
  });

  test('drops fields outside the per-step schema', async () => {
    const { pipeline, workerOut } = makePipeline();
    try {
      mkdirSync(join(workerOut, 'T-X'), { recursive: true });
      // Worker tries to inject a non-whitelisted field.
      writeFileSync(join(workerOut, 'T-X', 'plan.json'), JSON.stringify({
        status: 'done',
        risk: 'low',
        completed_at: '2030-01-01', // not in plan schema
        _selfHealed: true,           // orchestrator-only
        random_garbage: 'banana',
      }));

      const state = { ticket: 'T-X', steps: { plan: {} } };
      await pipeline.ingestWorkerOutput('T-X', 'plan', state);
      assert.equal(state.steps.plan.status, 'done');
      assert.equal(state.steps.plan.risk, 'low');
      assert.equal(state.steps.plan.completed_at, undefined, 'worker timestamp dropped');
      assert.equal(state.steps.plan._selfHealed, undefined, 'orchestrator-only field protected');
      assert.equal(state.steps.plan.random_garbage, undefined, 'unknown field dropped');
    } finally {
      rmSync(workerOut, { recursive: true, force: true });
    }
  });

  test('cannot poison other steps\' slots', async () => {
    const { pipeline, workerOut } = makePipeline();
    try {
      // Worker for tests_red writes to its own file but tries to set
      // implement.status='done' INSIDE the payload. Schema scoping should
      // drop everything not in tests_red's whitelist.
      mkdirSync(join(workerOut, 'T-X'), { recursive: true });
      writeFileSync(join(workerOut, 'T-X', 'tests_red.json'), JSON.stringify({
        status: 'done',
        outcome: 'new_test_fails',
        // Forgery attempt — these aren't tests_red fields.
        implement: { status: 'done' },
        tests_green: { status: 'done', all_pass: true },
      }));

      const state = {
        ticket: 'T-X',
        steps: {
          tests_red: {},
          implement: { status: 'pending' },
          tests_green: { status: 'pending' },
        },
      };
      await pipeline.ingestWorkerOutput('T-X', 'tests_red', state);
      assert.equal(state.steps.tests_red.status, 'done');
      assert.equal(state.steps.tests_red.outcome, 'new_test_fails');
      // Other steps untouched.
      assert.equal(state.steps.implement.status, 'pending');
      assert.equal(state.steps.tests_green.status, 'pending');
    } finally {
      rmSync(workerOut, { recursive: true, force: true });
    }
  });

  test('returns false when no worker output file exists', async () => {
    const { pipeline } = makePipeline();
    const state = { ticket: 'T-X', steps: {} };
    const ok = await pipeline.ingestWorkerOutput('T-X', 'plan', state);
    assert.equal(ok, false);
  });

  test('preserves orchestrator-set fields (metrics, _selfHealed) across ingest', async () => {
    const { pipeline, workerOut } = makePipeline();
    try {
      mkdirSync(join(workerOut, 'T-X'), { recursive: true });
      writeFileSync(join(workerOut, 'T-X', 'plan.json'), JSON.stringify({
        status: 'done',
        risk: 'medium',
      }));

      const state = {
        ticket: 'T-X',
        steps: {
          plan: {
            metrics: { attempts: 1, durationMs: 1234 },
            _selfHealed: true,
          },
        },
      };
      await pipeline.ingestWorkerOutput('T-X', 'plan', state);
      assert.equal(state.steps.plan.status, 'done');
      assert.equal(state.steps.plan.risk, 'medium');
      // Orchestrator-set fields survive merge.
      assert.deepEqual(state.steps.plan.metrics, { attempts: 1, durationMs: 1234 });
      assert.equal(state.steps.plan._selfHealed, true);
    } finally {
      rmSync(workerOut, { recursive: true, force: true });
    }
  });
});

describe('state-write-protect.sh — PreToolUse hook', () => {
  function runHook({ input, env = {} }) {
    try {
      const out = execSync(`bash ${HOOK}`, {
        input,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        cwd: '/tmp',
      });
      return { stdout: out.trim(), exitCode: 0 };
    } catch (err) {
      return {
        stdout: (err.stdout || '').toString().trim(),
        exitCode: err.status,
      };
    }
  }

  test('no-op when PIPELINE_STATE_PROTECTED unset', () => {
    const r = runHook({
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/anything.json' } }),
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('blocks Write to protected directory', () => {
    const r = runHook({
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/memory/pipeline/T-X.json' } }),
      env: { PIPELINE_STATE_PROTECTED: '/repo/memory/pipeline' },
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
    assert.match(r.stdout, /canonical pipeline state/);
  });

  test('blocks Edit to protected directory', () => {
    const r = runHook({
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/repo/memory/pipeline/T-X.json' } }),
      env: { PIPELINE_STATE_PROTECTED: '/repo/memory/pipeline' },
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
  });

  test('allows writes outside protected directory', () => {
    const r = runHook({
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/.pipeline-worker-out/T-X/plan.json' } }),
      env: { PIPELINE_STATE_PROTECTED: '/repo/memory/pipeline' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('mentions PIPELINE_WORKER_OUT in the deny reason when set', () => {
    const r = runHook({
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/repo/memory/pipeline/T-X.json' } }),
      env: {
        PIPELINE_STATE_PROTECTED: '/repo/memory/pipeline',
        PIPELINE_WORKER_OUT: '/repo/.pipeline-worker-out/T-X',
      },
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /PIPELINE_WORKER_OUT/);
  });

  test('does not gate Read or Bash', () => {
    const r = runHook({
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/repo/memory/pipeline/T-X.json' } }),
      env: { PIPELINE_STATE_PROTECTED: '/repo/memory/pipeline' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });
});
