// Post-cherry-pick green-gate on master HEAD (T-376 class). After a clean
// cherry-pick, the gate re-runs the project's test suite ON master to catch
// reds that only appear when the fix sits on top of the current master tree
// (e.g. master moved between when the worker ran tests in the worktree and
// when the orchestrator cherry-picked).
//
// The unit under test is Pipeline._runPostMergeGreenGate. We stub
// runTestSuite to return crafted results — the wiring into the cherry-pick
// flow is exercised end-to-end manually against real tickets.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pipeline } from '../src/pipeline.js';

function makeGate(testSuiteResult) {
  const root = mkdtempSync(join(tmpdir(), 'post-merge-gate-'));
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
  // Stub the test runner — the gate's behavior is the focus, not the
  // suite-invocation plumbing.
  p.runTestSuite = async () => testSuiteResult;
  return { pipeline: p, root, workerOut, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeTestsGreen(workerOut, ticketId, payload) {
  const dir = join(workerOut, ticketId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tests_green.json'), JSON.stringify(payload, null, 2));
  return dir;
}

describe('_runPostMergeGreenGate', () => {
  test('PASS when master post-cherry-pick has zero reds', async () => {
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 1500, failed: 0, failedTests: [], analyzerErrors: 0, unitCrashed: false,
    });
    try {
      const tDir = writeTestsGreen(workerOut, 'T-OK', { preexisting_failures: [], analyzer_errors: 0 });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-OK' }, tDir, {});
      assert.equal(r.ok, true);
      assert.equal(r.passed, 1500);
    } finally { cleanup(); }
  });

  test('PASS when every red on master matches the worker-documented preexisting baseline', async () => {
    // BUG-1011 shape: worker truthfully reported 1 pre-existing red.
    // Post-merge master still has that 1 red; no regression.
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 1500, failed: 1, failedTests: ['backend:m007-backfill-next-fire-at'],
      analyzerErrors: 0, unitCrashed: false,
    });
    try {
      const tDir = writeTestsGreen(workerOut, 'T-BASE', {
        preexisting_failures: ['backend:m007-backfill-next-fire-at'],
        analyzer_errors: 0,
      });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-BASE' }, tDir, {});
      assert.equal(r.ok, true);
      assert.deepEqual(r.baselined, ['backend:m007-backfill-next-fire-at']);
    } finally { cleanup(); }
  });

  test('FAIL POST_MERGE_TESTS_RED when master has reds not in worker preexisting baseline (T-376 class)', async () => {
    // T-376 scenario: cherry-pick clean, but 5 new reds appeared in
    // deploy-gate.test.ts + smoke.test.ts that the worker had no way to know
    // about (master moved underneath the worktree).
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 1200, failed: 5, failedTests: [
        'deploy-gate.test.ts:cron-deploys', 'deploy-gate.test.ts:rules-deploys',
        'smoke.test.ts:cold-start', 'smoke.test.ts:health', 'smoke.test.ts:auth',
      ],
      analyzerErrors: 0, unitCrashed: false,
    });
    try {
      const tDir = writeTestsGreen(workerOut, 'T-376', { preexisting_failures: [], analyzer_errors: 0 });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-376' }, tDir, {});
      assert.equal(r.ok, false);
      assert.equal(r.code, 'POST_MERGE_TESTS_RED');
      assert.equal(r.new_reds.length, 5);
      assert.match(r.reason, /5 new failing tests/);
    } finally { cleanup(); }
  });

  test('FAIL POST_MERGE_ANALYZER_RED when analyzer errors exceed worker baseline', async () => {
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 1500, failed: 0, failedTests: [], analyzerErrors: 3, unitCrashed: false,
    });
    try {
      const tDir = writeTestsGreen(workerOut, 'T-LINT', { preexisting_failures: [], analyzer_errors: 0 });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-LINT' }, tDir, {});
      assert.equal(r.ok, false);
      assert.equal(r.code, 'POST_MERGE_ANALYZER_RED');
      assert.match(r.reason, /3 new analyzer errors/);
    } finally { cleanup(); }
  });

  test('PASS when post-merge analyzer errors equal worker-documented baseline (no regression)', async () => {
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 1500, failed: 0, failedTests: [], analyzerErrors: 2, unitCrashed: false,
    });
    try {
      const tDir = writeTestsGreen(workerOut, 'T-LINT2', { preexisting_failures: [], analyzer_errors: 2 });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-LINT2' }, tDir, {});
      assert.equal(r.ok, true);
    } finally { cleanup(); }
  });

  test('FAIL GATE_INFRA_FAIL when unit runner crashes — never treat as pass', async () => {
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 0, failed: 0, failedTests: [], analyzerErrors: 0, unitCrashed: true, unitExitCode: 139,
    });
    try {
      const tDir = writeTestsGreen(workerOut, 'T-CRASH', { preexisting_failures: [], analyzer_errors: 0 });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-CRASH' }, tDir, {});
      assert.equal(r.ok, false);
      assert.equal(r.code, 'GATE_INFRA_FAIL');
      assert.match(r.reason, /exit 139/);
    } finally { cleanup(); }
  });

  test('FAIL GATE_INFRA_FAIL when runTestSuite itself throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'post-merge-gate-'));
    const pipelineDir = join(root, 'state'), workerOut = join(root, 'worker-out');
    mkdirSync(pipelineDir, { recursive: true }); mkdirSync(workerOut, { recursive: true });
    try {
      const p = new Pipeline({
        project_dir: root,
        _resolved: { pipelineDir, workerOutputDir: workerOut },
        steps: [],
      });
      p.emit = () => {};
      p.runTestSuite = async () => { throw new Error('config missing'); };
      const tDir = writeTestsGreen(workerOut, 'T-THROW', { preexisting_failures: [], analyzer_errors: 0 });
      const r = await p._runPostMergeGreenGate({ id: 'T-THROW' }, tDir, {});
      assert.equal(r.ok, false);
      assert.equal(r.code, 'GATE_INFRA_FAIL');
      assert.match(r.reason, /config missing/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('missing tests_green.json is tolerated — baseline defaults to zero/empty (worker fault detected upstream)', async () => {
    // If the worker didn't emit tests_green.json the upstream phase-verify
    // already failed; this gate shouldn't compound the failure. With zero
    // baseline, any red is treated as new — which is the correct strict
    // behavior in the absence of evidence.
    const { pipeline, workerOut, cleanup } = makeGate({
      passed: 100, failed: 0, failedTests: [], analyzerErrors: 0, unitCrashed: false,
    });
    try {
      const tDir = join(workerOut, 'T-NOTG');
      mkdirSync(tDir, { recursive: true });
      const r = await pipeline._runPostMergeGreenGate({ id: 'T-NOTG' }, tDir, {});
      assert.equal(r.ok, true);
    } finally { cleanup(); }
  });
});
