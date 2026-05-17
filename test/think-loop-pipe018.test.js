// PIPE-018 regression: an accepted critique must be APPLIED to the step's
// real output artifact, not left as a findings list the next step ignores.
//
// Source incident (predictor T-001): plan_critic prescribed `rm -rf app/`
// before `flutter create`; COMPARE ruled it BETTER; but think-loop set
// bestResult = the findings array, the plan.json on disk was never revised,
// and the executed plan never got the pre-step. This test pins the fix:
// after a BETTER verdict the artifact file itself carries the prescribed
// change and the loop reports `revised: true`.
//
// spawnClaude is out of scope for unit tests (see pipeline-retry.test.js);
// we use think-loop's `spawn` DI seam with a deterministic fake.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { thinkLoop } from '../src/think-loop.js';

const PRESCRIBED_FIX = 'rm -rf app/';

function makeFakeSpawn(artifactPath) {
  // Classifies the call by prompt content and drives a single
  // improve-then-converge cycle.
  let challengeCalls = 0;
  return async ({ prompt }) => {
    if (prompt.startsWith('Challenge the')) {
      challengeCalls++;
      if (challengeCalls === 1) {
        return {
          result: JSON.stringify([
            {
              file: 'plan.json',
              line: 1,
              issue: 'flutter create will fail because app/ already exists',
              fix: `add a pre-step: ${PRESCRIBED_FIX}`,
            },
          ]),
        };
      }
      // Round 2: the revised artifact is clean → converge.
      return { result: 'NO_IMPROVEMENT' };
    }
    if (prompt.startsWith('Compare these two versions')) {
      return { result: 'BETTER: the pre-step prevents a guaranteed failure' };
    }
    if (prompt.startsWith('Apply these accepted review findings')) {
      // Simulate the revise worker: actually rewrite the JSON artifact,
      // incorporating the prescribed fix while keeping the schema.
      const cur = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      cur.pre_steps = [PRESCRIBED_FIX];
      writeFileSync(artifactPath, JSON.stringify(cur, null, 2));
      return { result: 'applied' };
    }
    throw new Error(`unexpected spawn prompt: ${prompt.slice(0, 40)}`);
  };
}

describe('PIPE-018 — accepted critique is applied to the artifact', () => {
  test('prescribed plan fix appears in the finalized plan.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipe018-'));
    const artifactPath = join(dir, 'plan.json');
    writeFileSync(
      artifactPath,
      JSON.stringify({ status: 'done', files_to_change: [], risk: 'medium' }, null, 2),
    );

    try {
      const res = await thinkLoop({
        initialResult: 'initial plan text',
        stepName: 'plan',
        challengeQuestion: 'Any blocking issues?',
        config: {
          think_loop: { max_rounds: 5, max_discards: 1 },
          session: { model: 'opus' },
          project_dir: dir,
        },
        ticket: { id: 'T-001', title: 'Scaffold Flutter project' },
        emitter: null,
        reviseTarget: { kind: 'json', artifactPath },
        spawn: makeFakeSpawn(artifactPath),
      });

      // 1. The loop reports it actually applied the change.
      assert.equal(res.revised, true, 'think-loop should report revised:true');
      assert.equal(res.reviseKind, 'json');
      assert.ok(res.improvements >= 1, 'one accepted improvement expected');

      // 2. The fix is in the ON-DISK artifact the next step consumes.
      const finalized = JSON.parse(readFileSync(artifactPath, 'utf-8'));
      assert.deepEqual(finalized.pre_steps, [PRESCRIBED_FIX]);
      assert.equal(finalized.status, 'done', 'schema fields preserved');

      // 3. bestResult reflects the revised artifact, not the findings list.
      assert.ok(
        res.result.includes(PRESCRIBED_FIX),
        'bestResult must be the revised artifact, not the findings array',
      );
      assert.ok(
        !res.result.trim().startsWith('['),
        'bestResult must not be the raw findings JSON array',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kind:"none" keeps legacy advisory behaviour (no artifact write)', async () => {
    // review-style step: no consumable artifact → bestResult stays the
    // findings text and nothing is "revised".
    const res = await thinkLoop({
      initialResult: 'review output',
      stepName: 'review',
      challengeQuestion: 'Missed anything?',
      config: {
        think_loop: { max_rounds: 5, max_discards: 1 },
        session: { model: 'opus' },
        project_dir: tmpdir(),
      },
      ticket: { id: 'T-002', title: 'x' },
      emitter: null,
      reviseTarget: { kind: 'none' },
      spawn: async ({ prompt }) => {
        if (prompt.startsWith('Challenge the')) {
          return { result: JSON.stringify([{ file: 'a', line: 1, issue: 'x', fix: 'y' }]) };
        }
        if (prompt.startsWith('Compare')) return { result: 'BETTER: x' };
        return { result: 'NO_IMPROVEMENT' };
      },
    });
    assert.equal(res.revised, false);
    assert.ok(res.result.trim().startsWith('['), 'legacy: bestResult is the findings array');
  });
});
