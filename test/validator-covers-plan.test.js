// covers_plan must judge `implement` on the SOURCE slice of the plan only.
// The plan's files_to_change bundles test files, but those are written by
// `tests_red`; implement correctly never touches them. Pre-fix, the gate
// diffed implement's files_changed against the whole plan list incl. tests
// → "N/M unaccounted" → false full re-run (measured 66% on predictor).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateStep, isTestPath } from '../src/validator.js';

const stepConfig = {
  validation: [{ field: 'files_changed', rule: 'covers_plan' }],
};

function run(plan, filesChanged, filesSkipped = []) {
  return validateStep(
    { files_changed: filesChanged, files_skipped: filesSkipped },
    stepConfig,
    plan
  );
}

describe('covers_plan — test paths are tests_red\'s domain, not implement\'s', () => {
  test('T-013 regression: implement passes having changed only the 4 source files', () => {
    // Exact shape of the real T-013 phantom-fail. plan listed 4 prod + 2 test
    // files; tests_red wrote the 2 tests; implement changed only the 4 prod
    // files (correctly). Pre-fix: "2/6 planned files unaccounted for".
    const plan = {
      files_to_change: [
        { path: 'app/lib/core/widgets/confidence_colors.dart' },
        { path: 'app/lib/core/widgets/confidence_pill.dart' },
        { path: 'app/lib/core/widgets/confidence_bar.dart' },
        { path: 'app/lib/core/widgets/confidence_ring.dart' },
        { path: 'app/test/unit/confidence_colors_test.dart' },
        { path: 'app/test/widget/design_system_widgets_test.dart' },
      ],
    };
    const implementChanged = [
      { path: 'app/lib/core/widgets/confidence_colors.dart' },
      { path: 'app/lib/core/widgets/confidence_pill.dart' },
      { path: 'app/lib/core/widgets/confidence_bar.dart' },
      { path: 'app/lib/core/widgets/confidence_ring.dart' },
    ];
    const result = run(plan, implementChanged);
    assert.equal(
      result.pass,
      true,
      `expected pass (source slice fully covered), got: ${result.failures.join(' | ')}`
    );
  });

  test('a genuinely missed SOURCE file still fails the gate', () => {
    const plan = {
      files_to_change: [
        { path: 'app/lib/a.dart' },
        { path: 'app/lib/b.dart' },
        { path: 'app/test/unit/a_test.dart' },
      ],
    };
    // implement changed a.dart but not b.dart → real miss, must fail.
    const result = run(plan, [{ path: 'app/lib/a.dart' }]);
    assert.equal(result.pass, false);
    assert.match(result.failures[0], /1\/2 planned source files unaccounted/);
    assert.match(result.failures[0], /b\.dart/);
    // The test file must NOT appear in the unaccounted list.
    assert.doesNotMatch(result.failures[0], /a_test\.dart/);
  });

  test('an all-tests plan slice trivially passes (nothing for implement to own)', () => {
    const plan = {
      files_to_change: [
        { path: 'app/test/unit/x_test.dart' },
        { path: 'backend/functions/test/y.test.ts' },
      ],
    };
    const result = run(plan, []);
    assert.equal(result.pass, true);
  });

  test('source file accounted for via files_skipped still passes', () => {
    const plan = {
      files_to_change: [
        { path: 'app/lib/a.dart' },
        { path: 'app/test/unit/a_test.dart' },
      ],
    };
    const result = run(plan, [], [{ path: 'app/lib/a.dart' }]);
    assert.equal(result.pass, true);
  });
});

describe('isTestPath', () => {
  for (const p of [
    'app/test/unit/confidence_colors_test.dart',
    'app/test/widget/design_system_widgets_test.dart',
    'backend/functions/test/scoringEngine.test.ts',
    'src/__tests__/foo.js',
    'lib/foo_test.dart',
    'pkg/bar.spec.ts',
    'tests/integration/x.py',
  ]) {
    test(`test path: ${p}`, () => assert.equal(isTestPath(p), true));
  }
  for (const p of [
    'app/lib/core/widgets/confidence_colors.dart',
    'backend/functions/src/index.ts',
    'scripts/deploy.sh',
    'lib/contestant.dart', // contains "test" substring but not a test file
    null,
    undefined,
  ]) {
    test(`source path: ${p}`, () => assert.equal(isTestPath(p), false));
  }
});
