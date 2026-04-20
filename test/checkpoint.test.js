// Pipeline checkpoint — per-step git snapshot + rollback.
// Tests run in isolated temp repos so we never touch the real project.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureBranch,
  commitStepSnapshot,
  revertToLastSnapshot,
  deleteBranch,
  listStepSnapshots,
  mergeToMaster,
  CheckpointError,
} from '../src/checkpoint.js';

let repoDir;

function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: repoDir, encoding: 'utf-8', ...opts }).trim();
}

function setupRepo() {
  repoDir = mkdtempSync(join(tmpdir(), 'pipeline-ckpt-'));
  git('init --initial-branch=master');
  git('config user.email "test@example.com"');
  git('config user.name "Test"');
  writeFileSync(join(repoDir, 'README.md'), '# initial\n');
  git('add README.md');
  git('commit -m "initial"');
}

beforeEach(() => setupRepo());
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

describe('ensureBranch', () => {
  test('creates pipeline/{id} from master when none exists', async () => {
    const result = await ensureBranch('TEST-1', repoDir);
    assert.equal(result.branch, 'pipeline/TEST-1');
    assert.equal(result.createdFromMaster, true);
    assert.equal(git('rev-parse --abbrev-ref HEAD'), 'pipeline/TEST-1');
  });

  test('refuses when working tree has tracked modifications', async () => {
    writeFileSync(join(repoDir, 'README.md'), '# dirty\n');
    await assert.rejects(() => ensureBranch('TEST-2', repoDir), CheckpointError);
    // Branch was not created
    assert.throws(() => git('rev-parse pipeline/TEST-2'));
  });

  test('refuses when working tree has untracked files', async () => {
    writeFileSync(join(repoDir, 'orphan.txt'), 'not-committed');
    await assert.rejects(() => ensureBranch('TEST-3', repoDir), CheckpointError);
  });

  test('recovers existing stale branch by resetting to master tip', async () => {
    // Simulate a crashed prior run
    git('checkout -b pipeline/TEST-4');
    writeFileSync(join(repoDir, 'stale.txt'), 'left over');
    git('add stale.txt');
    git('commit -m "stale crash state"');
    git('checkout master');

    const result = await ensureBranch('TEST-4', repoDir);
    assert.equal(result.branch, 'pipeline/TEST-4');
    assert.equal(result.recoveredFromExisting, true);
    // Stale commit must be gone — the branch was reset to master's head.
    assert.equal(git('rev-parse HEAD'), git('rev-parse master'));
    // And the stale file is no longer on disk.
    assert.equal(existsSync(join(repoDir, 'stale.txt')), false);
  });
});

describe('commitStepSnapshot', () => {
  test('stages and commits all changes; returns SHA; tags the commit', async () => {
    await ensureBranch('TEST-5', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'alpha');
    writeFileSync(join(repoDir, 'b.txt'), 'beta');

    const sha = await commitStepSnapshot('TEST-5', 'plan', repoDir);
    assert.match(sha, /^[0-9a-f]{40}$/);
    // Commit message contains step name
    const msg = git(`log -1 --format=%B ${sha}`);
    assert.match(msg, /plan/);
    // Both files committed
    const tree = git(`show --stat ${sha} --format=`);
    assert.match(tree, /a\.txt/);
    assert.match(tree, /b\.txt/);
    // Tag exists
    assert.equal(git(`tag -l pipeline/TEST-5/step-1-plan`), 'pipeline/TEST-5/step-1-plan');
  });

  test('returns null when no changes to commit (step was a no-op)', async () => {
    await ensureBranch('TEST-6', repoDir);
    const sha = await commitStepSnapshot('TEST-6', 'plan', repoDir);
    assert.equal(sha, null);
  });

  test('increments step index across successive commits', async () => {
    await ensureBranch('TEST-7', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    await commitStepSnapshot('TEST-7', 'plan', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'a-modified');
    await commitStepSnapshot('TEST-7', 'implement', repoDir);

    assert.ok(git('tag -l pipeline/TEST-7/step-1-plan'));
    assert.ok(git('tag -l pipeline/TEST-7/step-2-implement'));
  });
});

describe('revertToLastSnapshot', () => {
  test('resets working tree to the last step snapshot', async () => {
    await ensureBranch('TEST-8', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'step1');
    await commitStepSnapshot('TEST-8', 'plan', repoDir);
    // Simulate a failing step that wrote garbage
    writeFileSync(join(repoDir, 'a.txt'), 'step2-garbage');
    writeFileSync(join(repoDir, 'new-orphan.txt'), 'also-garbage');

    await revertToLastSnapshot('TEST-8', repoDir);

    assert.equal(readFileSync(join(repoDir, 'a.txt'), 'utf-8'), 'step1');
    assert.equal(existsSync(join(repoDir, 'new-orphan.txt')), false);
    // History is intact — plan snapshot still tagged
    assert.ok(git('tag -l pipeline/TEST-8/step-1-plan'));
  });

  test('resets to branch base when no step snapshots exist', async () => {
    await ensureBranch('TEST-9', repoDir);
    writeFileSync(join(repoDir, 'orphan.txt'), 'garbage');

    await revertToLastSnapshot('TEST-9', repoDir);

    assert.equal(existsSync(join(repoDir, 'orphan.txt')), false);
    assert.equal(git('rev-parse HEAD'), git('rev-parse master'));
  });
});

describe('deleteBranch', () => {
  test('removes the pipeline branch and all its step tags', async () => {
    await ensureBranch('TEST-10', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    await commitStepSnapshot('TEST-10', 'plan', repoDir);
    // Need to be on another branch to delete the current one
    git('checkout master');

    await deleteBranch('TEST-10', repoDir);

    assert.throws(() => git('rev-parse pipeline/TEST-10'));
    assert.equal(git('tag -l pipeline/TEST-10/step-1-plan'), '');
  });

  test('no-op when branch does not exist', async () => {
    // Should not throw
    await deleteBranch('TEST-11-nonexistent', repoDir);
  });
});

describe('listStepSnapshots', () => {
  test('returns step tags in order for a ticket', async () => {
    await ensureBranch('TEST-12', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    await commitStepSnapshot('TEST-12', 'plan', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'aa');
    await commitStepSnapshot('TEST-12', 'tests_red', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'aaa');
    await commitStepSnapshot('TEST-12', 'implement', repoDir);

    const snapshots = await listStepSnapshots('TEST-12', repoDir);
    assert.deepEqual(
      snapshots.map((s) => s.step),
      ['plan', 'tests_red', 'implement'],
    );
    assert.deepEqual(
      snapshots.map((s) => s.index),
      [1, 2, 3],
    );
  });

  test('returns empty array when ticket has no snapshots', async () => {
    const snapshots = await listStepSnapshots('TEST-13-no-work', repoDir);
    assert.deepEqual(snapshots, []);
  });
});

describe('mergeToMaster', () => {
  test('squashes all step commits into one commit on master', async () => {
    await ensureBranch('TEST-14', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'alpha');
    await commitStepSnapshot('TEST-14', 'plan', repoDir);
    writeFileSync(join(repoDir, 'b.txt'), 'beta');
    await commitStepSnapshot('TEST-14', 'implement', repoDir);

    const masterBeforeSha = git('rev-parse master');
    const sha = await mergeToMaster('TEST-14', { title: 'Test ticket', cwd: repoDir });

    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(git('rev-parse --abbrev-ref HEAD'), 'master');
    assert.notEqual(git('rev-parse master'), masterBeforeSha);
    // Master advanced by exactly one commit
    const masterLog = git('log master --format=%H').split('\n');
    const beforeLog = git(`log ${masterBeforeSha} --format=%H`).split('\n');
    assert.equal(masterLog.length, beforeLog.length + 1);
    // Both files landed in the squash
    assert.equal(readFileSync(join(repoDir, 'a.txt'), 'utf-8'), 'alpha');
    assert.equal(readFileSync(join(repoDir, 'b.txt'), 'utf-8'), 'beta');
  });

  test('commit message contains ticket id, title, and step tag list', async () => {
    await ensureBranch('TEST-15', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    await commitStepSnapshot('TEST-15', 'plan', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'aa');
    await commitStepSnapshot('TEST-15', 'implement', repoDir);

    await mergeToMaster('TEST-15', { title: 'Some ticket title', cwd: repoDir });

    const msg = git('log master -1 --format=%B');
    assert.match(msg, /TEST-15/);
    assert.match(msg, /Some ticket title/);
    assert.match(msg, /plan/);
    assert.match(msg, /implement/);
  });

  test('returns null when branch has no commits beyond master', async () => {
    await ensureBranch('TEST-16', repoDir);
    // No commitStepSnapshot calls — branch tip == master tip.
    const masterBefore = git('rev-parse master');
    const sha = await mergeToMaster('TEST-16', { title: 'Empty', cwd: repoDir });

    assert.equal(sha, null);
    assert.equal(git('rev-parse master'), masterBefore);
    assert.equal(git('rev-parse --abbrev-ref HEAD'), 'master');
  });

  test('aborts cleanly on conflict; master unchanged; working tree clean', async () => {
    await ensureBranch('TEST-17', repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'branch-version\n');
    await commitStepSnapshot('TEST-17', 'implement', repoDir);

    // Move master forward with a conflicting edit
    git('checkout master');
    writeFileSync(join(repoDir, 'README.md'), 'master-version\n');
    git('add README.md');
    git('commit -m "master conflicting edit"');
    const masterAfterConflict = git('rev-parse master');

    await assert.rejects(
      () => mergeToMaster('TEST-17', { title: 'Conflict case', cwd: repoDir }),
      (err) => err instanceof CheckpointError && err.code === 'MERGE_CONFLICT',
    );

    // Master tip unchanged (abort worked)
    assert.equal(git('rev-parse master'), masterAfterConflict);
    // Working tree clean — not stuck in a half-merge
    assert.equal(git('status --porcelain'), '');
    // Ticket branch preserved for manual resolution
    assert.ok(git('rev-parse pipeline/TEST-17'));
  });

  test('refuses when master has uncommitted local changes', async () => {
    await ensureBranch('TEST-18', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'branch-work');
    await commitStepSnapshot('TEST-18', 'implement', repoDir);

    git('checkout master');
    writeFileSync(join(repoDir, 'README.md'), 'uncommitted-local-change\n');

    await assert.rejects(
      () => mergeToMaster('TEST-18', { title: 'Dirty master', cwd: repoDir }),
      (err) => err instanceof CheckpointError && err.code === 'DIRTY_TREE',
    );
  });

  test('full lifecycle: merge then delete branch leaves master with squashed commit and no ticket branch', async () => {
    await ensureBranch('TEST-19', repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'a');
    await commitStepSnapshot('TEST-19', 'plan', repoDir);

    const masterBefore = git('rev-parse master');
    await mergeToMaster('TEST-19', { title: 'Lifecycle', cwd: repoDir });
    await deleteBranch('TEST-19', repoDir);

    assert.notEqual(git('rev-parse master'), masterBefore);
    assert.throws(() => git('rev-parse pipeline/TEST-19'));
    assert.equal(git('tag -l "pipeline/TEST-19/*"'), '');
  });
});
