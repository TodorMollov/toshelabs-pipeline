// PIPE-025: deterministic review gate — net-new non-trivial pure-logic
// source file shipped with zero test coverage must hard-fail; plumbing,
// [no-test], refactors, covered files, and non-behavioural ticket types
// must NOT be blocked (no over-block regression).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pipeline } from '../src/pipeline.js';

let repo;
const LOGIC = `class Scorer {
  int compute(int a, int b) {
    if (a < 0) return 0;
    for (var i = 0; i < b; i++) { a += i; }
    while (a > 100) { a -= 10; }
    switch (a % 3) { case 0: return a; case 1: return a + 1; }
    return a > 50 ? a * 2 : a && b ? 1 : 0;
  }
  int other(int x) { return x > 0 ? x : -x; }
}
`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'pipe025-'));
  execSync('git init -q -b master', { cwd: repo });
  execSync('git config user.email t@t.t && git config user.name t && git config commit.gpgsign false && git config core.hooksPath /dev/null', { cwd: repo });
  writeFileSync(join(repo, 'seed.txt'), 'x\n');
  execSync('git add . && git commit -q -m seed', { cwd: repo });
  // Per-ticket baseline tag the netNew check probes.
  execSync('git tag -f pipeline/T-1/baseline HEAD', { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function check(state, ticket) {
  const stub = { cwd: repo, checkBehaviouralTestCoverage: Pipeline.prototype.checkBehaviouralTestCoverage };
  return stub.checkBehaviouralTestCoverage(state, ticket);
}
function writeImpl(rel, body = LOGIC) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
}

describe('checkBehaviouralTestCoverage (PIPE-025)', () => {
  test('net-new non-trivial logic file with no test → flagged', () => {
    writeImpl('lib/scorer.dart');
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/scorer.dart', what_to_do: 'NEW pure scorer' }] },
        implement: { files_changed: [{ path: 'lib/scorer.dart' }] },
        tests_red: { test_files: [], criteria_to_test_map: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'feature' }), ['lib/scorer.dart']);
  });

  test('same file but a test references the module → NOT flagged', () => {
    writeImpl('lib/scorer.dart');
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/scorer.dart', what_to_do: 'NEW' }] },
        implement: { files_changed: [{ path: 'lib/scorer.dart' }] },
        tests_red: { test_files: ['test/scorer_test.dart'], criteria_to_test_map: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'feature' }), []);
  });

  test('plumbing file (index.dart) → NOT flagged', () => {
    writeImpl('lib/index.dart');
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/index.dart', what_to_do: 'NEW barrel' }] },
        implement: { files_changed: [{ path: 'lib/index.dart' }] },
        tests_red: { test_files: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'feature' }), []);
  });

  test('[no-test] plan bullet → NOT flagged', () => {
    writeImpl('lib/scorer.dart');
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/scorer.dart', what_to_do: '[no-test] pure data table' }] },
        implement: { files_changed: [{ path: 'lib/scorer.dart' }] },
        tests_red: { test_files: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'feature' }), []);
  });

  test('bug ticket type → gate does not apply', () => {
    writeImpl('lib/scorer.dart');
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/scorer.dart', what_to_do: 'NEW' }] },
        implement: { files_changed: [{ path: 'lib/scorer.dart' }] },
        tests_red: { test_files: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'bug' }), []);
  });

  test('trivial file (few lines / no branching) → NOT flagged', () => {
    writeImpl('lib/tiny.dart', 'int two() => 2;\n');
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/tiny.dart', what_to_do: 'NEW' }] },
        implement: { files_changed: [{ path: 'lib/tiny.dart' }] },
        tests_red: { test_files: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'feature' }), []);
  });

  test('file that existed at baseline (modification, not net-new) → NOT flagged', () => {
    writeImpl('lib/scorer.dart');
    execSync('git add . && git commit -q -m pre', { cwd: repo });
    execSync('git tag -f pipeline/T-1/baseline HEAD', { cwd: repo }); // exists at baseline
    const state = {
      steps: {
        plan: { files_to_change: [{ path: 'lib/scorer.dart', what_to_do: 'modify scorer' }] },
        implement: { files_changed: [{ path: 'lib/scorer.dart' }] },
        tests_red: { test_files: [] },
      },
    };
    assert.deepEqual(check(state, { type: 'feature', id: 'T-1' }), []);
  });
});
