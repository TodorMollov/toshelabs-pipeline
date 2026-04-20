// Phase 5 — escalation ladder + restart-from-N-1 policy.
//
// Pure-function tests. The orchestrator's spawnClaude layer is out of
// scope for unit testing; instead we extract the two policy decisions
// (model selection per attempt, restart eligibility) into helpers and
// cover them here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pickAttemptModel, decideRestart, shouldHeal } from '../src/retry-policy.js';

const DEFAULT_LADDER = ['haiku', 'sonnet', 'opus'];

describe('pickAttemptModel — escalation ladder', () => {
  test('attempt 1 uses stepConfig.model when set', () => {
    const model = pickAttemptModel(
      { name: 'plan', model: 'opus' },
      1,
      DEFAULT_LADDER,
    );
    assert.equal(model, 'opus');
  });

  test('attempt 1 falls back to ladder[0] when stepConfig.model is absent', () => {
    const model = pickAttemptModel({ name: 'tests_red' }, 1, DEFAULT_LADDER);
    assert.equal(model, 'haiku');
  });

  test('attempt 2 uses ladder[1] regardless of stepConfig.model', () => {
    const model = pickAttemptModel(
      { name: 'implement', model: 'sonnet' },
      2,
      DEFAULT_LADDER,
    );
    assert.equal(model, 'sonnet');
  });

  test('attempt 3 uses ladder[2] (top of ladder)', () => {
    const model = pickAttemptModel({ name: 'implement' }, 3, DEFAULT_LADDER);
    assert.equal(model, 'opus');
  });

  test('attempt beyond ladder length clamps to top of ladder', () => {
    const model = pickAttemptModel({ name: 'implement' }, 99, DEFAULT_LADDER);
    assert.equal(model, 'opus');
  });

  test('custom ladder is honored', () => {
    const customLadder = ['haiku', 'opus'];
    assert.equal(
      pickAttemptModel({ name: 'plan' }, 1, customLadder),
      'haiku',
    );
    assert.equal(
      pickAttemptModel({ name: 'plan' }, 2, customLadder),
      'opus',
    );
    assert.equal(
      pickAttemptModel({ name: 'plan' }, 3, customLadder),
      'opus',
    );
  });

  test('empty ladder + no stepConfig.model defaults to opus (safety net)', () => {
    const model = pickAttemptModel({ name: 'plan' }, 1, []);
    assert.equal(model, 'opus');
  });
});

describe('decideRestart — walk back to step N-1 on heal exhaustion', () => {
  test('step 0 (plan) never restarts — no N-1 exists', () => {
    const result = decideRestart({
      currentStepIndex: 0,
      restartCount: 0,
      maxRestarts: 2,
    });
    assert.equal(result.shouldRestart, false);
    assert.match(result.reason, /plan|first step|no prior/i);
  });

  test('current>0 and restartCount<max walks back one step', () => {
    const result = decideRestart({
      currentStepIndex: 3,
      restartCount: 0,
      maxRestarts: 2,
    });
    assert.equal(result.shouldRestart, true);
    assert.equal(result.newStepIndex, 2);
    assert.equal(result.nextRestartCount, 1);
  });

  test('restartCount at max returns shouldRestart=false', () => {
    const result = decideRestart({
      currentStepIndex: 3,
      restartCount: 2,
      maxRestarts: 2,
    });
    assert.equal(result.shouldRestart, false);
    assert.match(result.reason, /max|exhausted/i);
  });

  test('maxRestarts=0 disables restart entirely', () => {
    const result = decideRestart({
      currentStepIndex: 3,
      restartCount: 0,
      maxRestarts: 0,
    });
    assert.equal(result.shouldRestart, false);
  });

  test('currentStepIndex=1 walks back to 0 (re-runs plan)', () => {
    const result = decideRestart({
      currentStepIndex: 1,
      restartCount: 0,
      maxRestarts: 1,
    });
    assert.equal(result.shouldRestart, true);
    assert.equal(result.newStepIndex, 0);
  });

  test('restartCount below max but currentStepIndex=0 still refuses', () => {
    // Even with budget, step 0 has no N-1 to walk back to.
    const result = decideRestart({
      currentStepIndex: 0,
      restartCount: 1,
      maxRestarts: 5,
    });
    assert.equal(result.shouldRestart, false);
  });

  test('decision is a plain object with stable field names', () => {
    const result = decideRestart({
      currentStepIndex: 2,
      restartCount: 0,
      maxRestarts: 1,
    });
    // Contract: callers depend on these exact fields.
    assert.ok('shouldRestart' in result);
    assert.ok('newStepIndex' in result);
    assert.ok('nextRestartCount' in result);
  });
});

describe('shouldHeal — non-convergence is not healable', () => {
  test('clean gate failure with tool calls → heal allowed', () => {
    const d = shouldHeal({ maxTurnsHit: false, timedOut: false, toolCalls: 5 });
    assert.equal(d.shouldHeal, true);
    assert.equal(d.reason, 'gate_failed');
  });

  test('wall-clock timeout → refuse heal (spawning again would also time out)', () => {
    const d = shouldHeal({ maxTurnsHit: false, timedOut: true, toolCalls: 42 });
    assert.equal(d.shouldHeal, false);
    assert.equal(d.reason, 'timeout');
  });

  test('max turns hit with tool calls → refuse (budget doubled would not converge either)', () => {
    const d = shouldHeal({ maxTurnsHit: true, timedOut: false, toolCalls: 30 });
    assert.equal(d.shouldHeal, false);
    assert.equal(d.reason, 'max_turns');
  });

  test('max turns hit with 0 tool calls → refuse (step never got started)', () => {
    const d = shouldHeal({ maxTurnsHit: true, timedOut: false, toolCalls: 0 });
    assert.equal(d.shouldHeal, false);
    assert.equal(d.reason, 'no_tool_calls');
  });

  test('timeout wins over max_turns when both are set', () => {
    // If we killed for wall-clock, that's the more accurate reason to log.
    const d = shouldHeal({ maxTurnsHit: true, timedOut: true, toolCalls: 1 });
    assert.equal(d.shouldHeal, false);
    assert.equal(d.reason, 'timeout');
  });

  test('missing toolCalls treated as 0', () => {
    const d = shouldHeal({ maxTurnsHit: true, timedOut: false });
    assert.equal(d.shouldHeal, false);
    assert.equal(d.reason, 'no_tool_calls');
  });
});
