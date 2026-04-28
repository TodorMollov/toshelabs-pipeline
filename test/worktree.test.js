// Tests for src/worktree.js — git worktree lifecycle helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorktree, prepareWorktreeForTicket, cherryPickToMaster, resolveDefaultBranch } from '../src/worktree.js';

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wt-master-'));
  execSync('git init -q -b master', { cwd: dir });
  execSync(
    'git config user.email t@t.t && git config user.name t && git config commit.gpgsign false && git config core.hooksPath /dev/null',
    { cwd: dir },
  );
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('resolveDefaultBranch', () => {
  test('returns master when present', () => {
    const repo = makeRepo();
    try {
      assert.equal(resolveDefaultBranch(repo), 'master');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('falls back to main when only main exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-main-'));
    try {
      execSync('git init -q -b main', { cwd: dir });
      execSync('git config user.email t@t.t && git config user.name t && git config commit.gpgsign false && git config core.hooksPath /dev/null', { cwd: dir });
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      execSync('git add . && git commit -q -m init', { cwd: dir });
      assert.equal(resolveDefaultBranch(dir), 'main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureWorktree', () => {
  test('creates worktree on first call, no-ops on second', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      const r1 = ensureWorktree(master, wtDir, 'pipeline/wt-test');
      assert.equal(r1.worktreeDir, wtDir);
      assert.ok(existsSync(wtDir), 'worktree dir created');
      assert.equal(git('rev-parse --is-inside-work-tree', wtDir), 'true');
      assert.equal(git('rev-parse --abbrev-ref HEAD', wtDir), 'pipeline/wt-test');

      // No-op on second call
      const r2 = ensureWorktree(master, wtDir, 'pipeline/wt-test');
      assert.equal(r2.worktreeDir, wtDir);
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test('worktree shares git objects with master (commits visible immediately)', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');

      // Operator commits to master
      writeFileSync(join(master, 'new.txt'), 'master-side\n');
      execSync('git add . && git commit -q -m "master commit"', { cwd: master });
      const masterSha = git('rev-parse master', master);

      // Worktree sees that commit (shared refs)
      assert.equal(git('rev-parse master', wtDir), masterSha);
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });
});

describe('prepareWorktreeForTicket', () => {
  test('resets worktree to master, wiping prior worker edits', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');

      // Simulate a half-finished prior run: leftover edit in worktree
      writeFileSync(join(wtDir, 'README.md'), 'corrupted\n');
      writeFileSync(join(wtDir, 'orphan.txt'), 'leftover\n');

      prepareWorktreeForTicket(wtDir, 'master');

      // README is back to master content
      assert.equal(readFileSync(join(wtDir, 'README.md'), 'utf-8'), 'hello\n');
      // Untracked orphan removed
      assert.ok(!existsSync(join(wtDir, 'orphan.txt')), 'untracked file cleaned');
      // Working tree is clean
      assert.equal(git('status --porcelain', wtDir), '');
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test('picks up master commits made between ticket runs', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');

      // Operator advances master
      writeFileSync(join(master, 'op.txt'), 'op-edit\n');
      execSync('git add . && git commit -q -m "operator edit"', { cwd: master });

      // Worktree was at the original master sha — after prepare it sees op.txt
      assert.ok(!existsSync(join(wtDir, 'op.txt')), 'op.txt not in worktree yet');
      prepareWorktreeForTicket(wtDir, 'master');
      assert.equal(readFileSync(join(wtDir, 'op.txt'), 'utf-8'), 'op-edit\n');
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });
});

describe('cherryPickToMaster', () => {
  test('applies a clean ticket commit onto master', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');
      prepareWorktreeForTicket(wtDir, 'master');

      // Worker makes a change in the worktree and commits on side branch
      writeFileSync(join(wtDir, 'feature.txt'), 'new-feature\n');
      execSync('git add . && git commit -q -m "[T-X] feature"', { cwd: wtDir });
      const sha = git('rev-parse HEAD', wtDir);

      const result = cherryPickToMaster(master, sha, 'master');
      assert.equal(result.ok, true);
      assert.ok(result.headSha);

      // master in the primary checkout now has the file
      assert.equal(readFileSync(join(master, 'feature.txt'), 'utf-8'), 'new-feature\n');
      assert.match(git('log -1 --pretty=%s', master), /\[T-X\] feature/);
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test('refuses when primary checkout is dirty', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');
      prepareWorktreeForTicket(wtDir, 'master');
      writeFileSync(join(wtDir, 'feature.txt'), 'new-feature\n');
      execSync('git add . && git commit -q -m "[T-X] feature"', { cwd: wtDir });
      const sha = git('rev-parse HEAD', wtDir);

      // Operator has uncommitted WIP in the primary checkout
      writeFileSync(join(master, 'README.md'), 'operator WIP\n');

      const result = cherryPickToMaster(master, sha, 'master');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'DIRTY');

      // Master HEAD has not advanced; operator's WIP is intact.
      assert.equal(git('log -1 --pretty=%s', master), 'init');
      assert.equal(readFileSync(join(master, 'README.md'), 'utf-8'), 'operator WIP\n');
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test('refuses when primary checkout is on a non-default branch', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');
      prepareWorktreeForTicket(wtDir, 'master');
      writeFileSync(join(wtDir, 'feature.txt'), 'new-feature\n');
      execSync('git add . && git commit -q -m "[T-X] feature"', { cwd: wtDir });
      const sha = git('rev-parse HEAD', wtDir);

      // Operator switches to a feature branch in primary checkout.
      execSync('git checkout -q -b op-feature', { cwd: master });

      const result = cherryPickToMaster(master, sha, 'master');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'WRONG_BRANCH');
      assert.equal(result.head, 'op-feature');
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test('reports EMPTY when commit is already in master', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');
      prepareWorktreeForTicket(wtDir, 'master');
      writeFileSync(join(wtDir, 'feature.txt'), 'new-feature\n');
      execSync('git add . && git commit -q -m "[T-X] feature"', { cwd: wtDir });
      const sha = git('rev-parse HEAD', wtDir);

      // Operator independently makes the same change on master.
      writeFileSync(join(master, 'feature.txt'), 'new-feature\n');
      execSync('git add . && git commit -q -m "operator: same change"', { cwd: master });

      const result = cherryPickToMaster(master, sha, 'master');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'EMPTY');
      // Master has not advanced past the operator commit.
      assert.match(git('log -1 --pretty=%s', master), /operator: same change/);
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });

  test('aborts on conflict and leaves master unchanged', () => {
    const master = makeRepo();
    const wtParent = mkdtempSync(join(tmpdir(), 'wt-parent-'));
    const wtDir = join(wtParent, 'wt');
    try {
      ensureWorktree(master, wtDir, 'pipeline/wt-test');
      prepareWorktreeForTicket(wtDir, 'master');

      // Worker edits README.md in the worktree and commits.
      writeFileSync(join(wtDir, 'README.md'), 'worker version\n');
      execSync('git add . && git commit -q -m "[T-X] worker readme"', { cwd: wtDir });
      const sha = git('rev-parse HEAD', wtDir);

      // Meanwhile, operator commits a different change to README.md on master.
      writeFileSync(join(master, 'README.md'), 'operator version\n');
      execSync('git add . && git commit -q -m "operator readme"', { cwd: master });
      const masterShaBefore = git('rev-parse HEAD', master);

      const result = cherryPickToMaster(master, sha, 'master');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'CONFLICT');
      assert.ok(result.files.includes('README.md'), 'conflict files reported');

      // master HEAD unchanged — abort restored the tree.
      assert.equal(git('rev-parse HEAD', master), masterShaBefore);
      assert.equal(readFileSync(join(master, 'README.md'), 'utf-8'), 'operator version\n');
      // Working tree clean (no half-merged state).
      assert.equal(git('status --porcelain', master), '');
    } finally {
      rmSync(master, { recursive: true, force: true });
      rmSync(wtParent, { recursive: true, force: true });
    }
  });
});
