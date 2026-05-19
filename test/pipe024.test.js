// PIPE-024: think-loop caps after a round whose findings are all
// explicitly non-blocking — UNLESS the ticket is high-risk (then the
// full round budget runs). A blocking/unknown-severity finding never caps.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { thinkLoop } from '../src/think-loop.js';

const config = {
  think_loop: { max_rounds: 3, max_discards: 2 },
  session: { model: 'sonnet' },
  project_dir: '/tmp',
};
const ticket = { id: 'T-1', title: 'x' };

// Fake spawn: every challenge round returns the given findings; compare
// always says BETTER. Counts challenge invocations so we can prove the
// loop stopped early.
function spawnWith(severity) {
  let challenges = 0;
  const fn = async ({ prompt }) => {
    if (prompt.startsWith('Challenge the')) {
      challenges++;
      // Unique issue each round so the non-convergence guard (re-raised
      // identical issue) doesn't fire — we are isolating the PIPE-024 cap.
      const f = { file: `f${challenges}`, line: challenges, issue: `distinct issue ${challenges}`, fix: 'x' };
      if (severity) f.severity = severity;
      return { result: JSON.stringify([f]) };
    }
    if (prompt.startsWith('Compare these two versions')) {
      return { result: 'BETTER: improves it' };
    }
    return { result: 'applied' };
  };
  fn.count = () => challenges;
  return fn;
}

describe('think-loop PIPE-024 risk cap', () => {
  test('medium risk + only low-severity findings → caps after round 1', async () => {
    const spawn = spawnWith('low');
    const r = await thinkLoop({
      initialResult: 'plan', stepName: 'plan', challengeQuestion: 'q',
      config, ticket, risk: 'medium', reviseTarget: { kind: 'none' }, spawn,
    });
    assert.equal(r.rounds, 1, 'should stop after the first non-blocking round');
    assert.equal(spawn.count(), 1, 'no second challenge cycle');
    assert.ok(r.history.some((h) => h.outcome === 'risk_capped'));
  });

  test('high risk + only low-severity findings → NOT capped (full budget)', async () => {
    const spawn = spawnWith('low');
    const r = await thinkLoop({
      initialResult: 'plan', stepName: 'plan', challengeQuestion: 'q',
      config, ticket, risk: 'high', reviseTarget: { kind: 'none' }, spawn,
    });
    assert.equal(r.rounds, 3, 'high risk runs the full round budget');
    assert.ok(!r.history.some((h) => h.outcome === 'risk_capped'));
  });

  test('medium risk + a high-severity finding → NOT capped, keeps iterating', async () => {
    const spawn = spawnWith('high');
    const r = await thinkLoop({
      initialResult: 'plan', stepName: 'plan', challengeQuestion: 'q',
      config, ticket, risk: 'medium', reviseTarget: { kind: 'none' }, spawn,
    });
    assert.ok(r.rounds > 1, 'a blocking finding must not trigger the cap');
    assert.ok(!r.history.some((h) => h.outcome === 'risk_capped'));
  });

  test('medium risk + UNKNOWN severity → treated as blocking, not capped', async () => {
    const spawn = spawnWith(null); // no severity
    const r = await thinkLoop({
      initialResult: 'plan', stepName: 'plan', challengeQuestion: 'q',
      config, ticket, risk: 'medium', reviseTarget: { kind: 'none' }, spawn,
    });
    assert.ok(r.rounds > 1, 'unknown severity must not cap (ambiguity = blocking)');
  });
});
