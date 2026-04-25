// Regression: 2026-04-25 incident, third bug.
//
// `ensureBranch` previously did `git reset --hard master` whenever a
// `pipeline/{id}` branch already existed, on the assumption that any
// commits there were stale pipeline step commits from a crashed run.
// That assumption was wrong: the operator had committed `1b68933`
// ([backlog] Recover 13 tickets…) onto pipeline/T-351 to recover from
// an earlier destruction. The next pipeline run reset that branch to
// master and orphaned the commit (still reachable via reflog, but no
// longer on any branch).
//
// New behaviour:
//   - branch ahead of master with ONLY [pipeline] step- commits → reset OK.
//   - branch ahead of master with any other subject               → refuse.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureBranch, CheckpointError } from '../src/checkpoint.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-branch-'));
  execSync('git init -q -b master', { cwd: dir });
  execSync('git config user.email t@t.t && git config user.name t && git config commit.gpgsign false', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'init\n');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();
}

describe('ensureBranch — refuses to reset over non-pipeline commits', () => {
  test('refuses when stale branch has an operator commit', async () => {
    const repo = makeRepo();
    try {
      // Create pipeline/T-X with one operator-style commit that the
      // pipeline regex would not recognise.
      execSync('git checkout -q -b pipeline/T-X', { cwd: repo });
      writeFileSync(join(repo, 'a.txt'), 'operator edit\n');
      execSync('git commit -q -am "[backlog] operator recovery"', { cwd: repo });
      const operatorSha = git('rev-parse HEAD', repo);
      execSync('git checkout -q master', { cwd: repo });

      await assert.rejects(
        () => ensureBranch('T-X', repo),
        (err) => err instanceof CheckpointError && err.code === 'STALE_BRANCH_HAS_COMMITS',
      );

      // Operator commit must still be reachable on the branch.
      assert.equal(git('rev-parse pipeline/T-X', repo), operatorSha);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('resets cleanly when stale branch only has [pipeline] step commits', async () => {
    const repo = makeRepo();
    try {
      execSync('git checkout -q -b pipeline/T-Y', { cwd: repo });
      writeFileSync(join(repo, 'b.txt'), 'step\n');
      execSync('git add . && git commit -q -m "[pipeline] T-Y step-1-tests_red"', { cwd: repo });
      writeFileSync(join(repo, 'c.txt'), 'step\n');
      execSync('git add . && git commit -q -m "[pipeline] T-Y step-2-implement"', { cwd: repo });
      execSync('git checkout -q master', { cwd: repo });

      const res = await ensureBranch('T-Y', repo);
      assert.equal(res.branch, 'pipeline/T-Y');
      assert.equal(res.recoveredFromExisting, true);

      // After reset, branch tip equals master tip.
      assert.equal(
        git('rev-parse pipeline/T-Y', repo),
        git('rev-parse master', repo),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('refuses when branch mixes step commits and one operator commit', async () => {
    const repo = makeRepo();
    try {
      execSync('git checkout -q -b pipeline/T-Z', { cwd: repo });
      writeFileSync(join(repo, 'b.txt'), 'step\n');
      execSync('git add . && git commit -q -m "[pipeline] T-Z step-1-tests_red"', { cwd: repo });
      writeFileSync(join(repo, 'c.txt'), 'op\n');
      execSync('git add . && git commit -q -m "manual fix on top of step"', { cwd: repo });
      execSync('git checkout -q master', { cwd: repo });

      await assert.rejects(
        () => ensureBranch('T-Z', repo),
        (err) => err instanceof CheckpointError && err.code === 'STALE_BRANCH_HAS_COMMITS',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('creates fresh branch when none exists', async () => {
    const repo = makeRepo();
    try {
      const res = await ensureBranch('T-NEW', repo);
      assert.equal(res.branch, 'pipeline/T-NEW');
      assert.equal(res.createdFromMaster, true);
      assert.equal(res.recoveredFromExisting, false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
