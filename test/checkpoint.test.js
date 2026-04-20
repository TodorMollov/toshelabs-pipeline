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
