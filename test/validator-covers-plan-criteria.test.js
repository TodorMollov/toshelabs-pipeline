// covers_plan_criteria should match plan deliverables to test criteria
// using keyword overlap — not the old 30-char prefix match that made
// BUG-216 loop. Each case runs the real validator with a minimal step
// config + synthetic plan/tests_red artifacts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateStep } from '../src/validator.js';

const stepConfig = {
  validation: [{ field: 'criteria_to_test_map', rule: 'covers_plan_criteria' }],
};

function run(plan, map) {
  return validateStep({ criteria_to_test_map: map }, stepConfig, plan);
}

describe('covers_plan_criteria — keyword overlap matching', () => {
  test('BUG-216 regression: procedural plan bullet matches semantic test criterion', () => {
    // This is the shape the real BUG-216 plan had. Under the old 30-char
    // prefix match, no test criterion containing less than the literal
    // "1) Add `custom` value to _RangeMode enum. 2)" prefix would count.
    // Keyword overlap: {add, custom, value, rangemode, enum, todayscreenstate, ...}
    // versus test criterion {label, next, week, routes, custom, mode, rangemode}
    // → custom, rangemode overlap ≥ 30%.
    const plan = {
      files_to_change: [
        {
          path: 'app/lib/features/today/today_screen.dart',
          what_to_do: '1) Add `custom` value to _RangeMode enum. 2) In _TodayScreenState add DateTime? _customFrom; DateTime? _customTo;',
        },
      ],
    };
    const map = [
      { criterion: "label 'next week' routes to _RangeMode.custom with correct from/to", test_name: 'next_week_custom' },
    ];
    const result = run(plan, map);
    assert.equal(result.pass, true, `expected pass, got failures: ${result.failures.join(' | ')}`);
  });

  test('[no-test] bullets are skipped entirely', () => {
    const plan = {
      files_to_change: [
        { path: 'lib/util.dart', what_to_do: '[no-test] pass the label field through to the provider' },
      ],
    };
    const result = run(plan, []);
    assert.equal(result.pass, true);
  });

  test('genuinely uncovered deliverable fails (no keyword overlap)', () => {
    const plan = {
      files_to_change: [
        { path: 'lib/payment.dart', what_to_do: 'implement Stripe webhook signature verification' },
        { path: 'lib/email.dart', what_to_do: 'send receipt email on purchase confirmation' },
        { path: 'lib/invoice.dart', what_to_do: 'generate PDF invoice attachment' },
      ],
    };
    const map = [
      { criterion: 'clicking the button opens the menu', test_name: 'menu_opens' },
    ];
    const result = run(plan, map);
    assert.equal(result.pass, false);
    assert.match(result.failures[0], /criteria_to_test_map/);
  });

  test('stopwords alone do not count as matches', () => {
    // 3 deliverables, tolerance = max(2, ceil(3*0.2)) = 2. None covered by
    // a criterion whose non-stopword overlap is zero → 3 > 2 → fails.
    const plan = {
      files_to_change: [
        { path: 'lib/a.dart', what_to_do: 'implement stripe webhook authenticator' },
        { path: 'lib/b.dart', what_to_do: 'render invoice pdf via receipt generator' },
        { path: 'lib/c.dart', what_to_do: 'persist warehouse inventory to firestore' },
      ],
    };
    // Criterion that matches only on stopwords — should NOT be considered covered.
    const map = [
      { criterion: 'the new values for is a to and', test_name: 'junk' },
    ];
    const result = run(plan, map);
    assert.equal(result.pass, false);
  });

  test('path-only match still works for tooling tickets', () => {
    const plan = {
      files_to_change: [
        { path: 'scripts/deploy.sh', what_to_do: 'add canary cohort check before prod rollout' },
      ],
    };
    const map = [
      { criterion: 'scripts/deploy.sh emits canary gate output', test_name: 'deploy_canary' },
    ];
    const result = run(plan, map);
    assert.equal(result.pass, true);
  });

  test('tolerance still allows small shortfalls on large plans', () => {
    // 10 deliverables, 2 uncovered → tolerance = max(2, ceil(10*0.2)) = 2.
    // 2 ≤ 2 → passes with warning.
    const files = [];
    for (let i = 0; i < 10; i++) {
      files.push({ path: `lib/f${i}.dart`, what_to_do: `deliverable number ${i} concerning widget alpha beta gamma` });
    }
    const plan = { files_to_change: files };
    const map = [];
    for (let i = 0; i < 8; i++) {
      // Each map entry covers one deliverable via keyword overlap (widget + alpha).
      map.push({ criterion: `widget alpha covers deliverable ${i} aspect`, test_name: `t_${i}` });
    }
    const result = run(plan, map);
    assert.equal(result.pass, true, `expected pass within tolerance, got: ${result.failures.join(' | ')}`);
  });
});
