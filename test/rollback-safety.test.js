// Regression: 2026-04-25 incident.
//
// A ticket with a dirty working tree was refused at `checkpointEnsureBranch`
// (DIRTY_TREE). The catch block in run() then called `rollbackTicketFiles`
// with a freshly-created pipelineState that had no `dirty_at_start`.
// `collectTicketFiles` therefore attributed every currently-dirty file to the
// ticket, and `git checkout HEAD --` reverted the operator's uncommitted
// backlog edits — destroying 13 tickets' worth of work.
//
// Two guards must hold:
//   1. `rollbackTicketFiles` refuses to revert when `dirty_at_start` was
//      never captured (Array.isArray check on pipelineState.dirty_at_start).
//   2. The catch block in run() skips rollback entirely when the failure is
//      a CheckpointError (we never wrote anything; nothing to revert).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pipeline } from '../src/pipeline.js';
import { CheckpointError } from '../src/checkpoint.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-rollback-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t.t && git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'committed.txt'), 'original\n');
  execSync('git add . && git -c commit.gpgsign=false commit -q -m init', { cwd: dir });
  return dir;
}

function makePipeline(projectDir) {
  const pipelineDir = mkdtempSync(join(tmpdir(), 'pipeline-state-'));
  mkdirSync(pipelineDir, { recursive: true });
  // Minimal config — only the fields rollbackTicketFiles + savePipelineJson read.
  const p = new Pipeline({
    project_dir: projectDir,
    _resolved: { pipelineDir },
    steps: [],
  });
  // Suppress event noise.
  p.emit = () => {};
  return { pipeline: p, pipelineDir };
}

describe('rollbackTicketFiles — dirty_at_start guard', () => {
  test('refuses to revert when dirty_at_start was never captured', async () => {
    const repo = makeRepo();
    try {
      // Operator's pre-existing uncommitted edit — exactly the scenario that
      // destroyed the backlog on 2026-04-25.
      writeFileSync(join(repo, 'committed.txt'), 'OPERATOR EDIT — must survive\n');

      const { pipeline } = makePipeline(repo);
      const ticket = { id: 'BUG-TEST', title: 'x' };
      // Pipeline state with NO dirty_at_start field — same shape as the
      // freshly-created state when checkpointEnsureBranch refuses.
      const state = {
        schema: 'pipeline-v2',
        ticket: ticket.id,
        status: 'failed',
        steps: {},
      };

      await pipeline.rollbackTicketFiles(ticket, state);

      // The operator's edit MUST still be there.
      const after = readFileSync(join(repo, 'committed.txt'), 'utf-8');
      assert.equal(after, 'OPERATOR EDIT — must survive\n');

      // And the rollback record must say it was skipped, not reverted.
      assert.equal(state.rollback.skipped_reason, 'dirty_at_start not captured — refusing to revert');
      assert.deepEqual(state.rollback.reverted, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('still reverts normally when dirty_at_start IS present', async () => {
    const repo = makeRepo();
    try {
      const { pipeline } = makePipeline(repo);
      const ticket = { id: 'T-OK', title: 'x' };

      // Baseline: no dirty files at start.
      // Then "the ticket" writes a change to committed.txt.
      writeFileSync(join(repo, 'committed.txt'), 'ticket-written content\n');

      const state = {
        schema: 'pipeline-v2',
        ticket: ticket.id,
        status: 'failed',
        steps: {
          implement: {
            status: 'done',
            files_changed: [{ path: 'committed.txt', summary: 'ticket wrote this' }],
          },
        },
        dirty_at_start: [], // empty array — baseline WAS captured, tree was clean
      };

      await pipeline.rollbackTicketFiles(ticket, state);

      // The ticket's write should have been reverted.
      const after = readFileSync(join(repo, 'committed.txt'), 'utf-8');
      assert.equal(after, 'original\n');
      assert.deepEqual(state.rollback.reverted, ['committed.txt']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('CheckpointError import is reachable from pipeline', () => {
  // The catch-block guard `err instanceof CheckpointError` only works if the
  // class is imported in pipeline.js. Asserting the import directly here keeps
  // the regression test honest — refactoring the import out would break this.
  test('CheckpointError is exported from checkpoint.js', () => {
    const e = new CheckpointError('boom', { code: 'DIRTY_TREE' });
    assert.equal(e.code, 'DIRTY_TREE');
    assert.ok(e instanceof Error);
  });
});
