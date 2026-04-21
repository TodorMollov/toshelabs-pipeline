// acquireLock auto-registers the lock file in .git/info/exclude so the
// Phase 3 checkpoint's dirty-tree guard doesn't see it. Each test spins
// up a fresh repo in /tmp — the real project tree is never touched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { acquireLock, releaseLock } from '../src/lock.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-lock-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  // Seed a commit so HEAD resolves.
  execSync('touch README && git add README && git commit -q -m initial', { cwd: dir });
  return dir;
}

describe('acquireLock — auto-ignore via .git/info/exclude', () => {
  test('adds lock name to .git/info/exclude on first acquire', async () => {
    const repo = makeRepo();
    const lockPath = join(repo, 'code.lock');
    const result = await acquireLock(lockPath, 'test run');
    assert.equal(result.acquired, true);
    const excl = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    assert.match(excl, /code\.lock/);
    // And status --porcelain should NOT see the lock file now.
    const porcelain = execSync('git status --porcelain', { cwd: repo, encoding: 'utf-8' });
    assert.equal(porcelain.trim(), '');
    await releaseLock(lockPath);
  });

  test('second acquire is a no-op — no duplicate lines in exclude', async () => {
    const repo = makeRepo();
    const lockPath = join(repo, 'code.lock');
    await acquireLock(lockPath, 'first');
    await releaseLock(lockPath);
    await acquireLock(lockPath, 'second');
    const excl = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    const occurrences = (excl.match(/^code\.lock$/gm) || []).length;
    assert.equal(occurrences, 1);
    await releaseLock(lockPath);
  });

  test('existing unrelated exclude entries are preserved', async () => {
    const repo = makeRepo();
    execSync('printf "some-other-thing\\n" >> .git/info/exclude', { cwd: repo, shell: '/bin/bash' });
    const lockPath = join(repo, 'code.lock');
    await acquireLock(lockPath, 'test');
    const excl = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');
    assert.match(excl, /some-other-thing/);
    assert.match(excl, /code\.lock/);
    await releaseLock(lockPath);
  });

  test('no-op silently when path is not in a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipeline-lock-nogit-'));
    const lockPath = join(dir, 'code.lock');
    // Must not throw and must still create the lock.
    const result = await acquireLock(lockPath, 'test');
    assert.equal(result.acquired, true);
    assert.equal(existsSync(lockPath), true);
    await releaseLock(lockPath);
  });

  test('acquire returns holder when lock already held', async () => {
    const repo = makeRepo();
    const lockPath = join(repo, 'code.lock');
    await acquireLock(lockPath, 'first-holder');
    const second = await acquireLock(lockPath, 'second');
    assert.equal(second.acquired, false);
    assert.match(second.holder, /first-holder/);
    await releaseLock(lockPath);
  });

  test('acquire steals a stale lock whose pid is dead', async () => {
    // Regression for the 2026-04-21 SIGKILL path: pipeline gets killed
    // ungracefully, code.lock persists, next start reports "Code lock held"
    // forever. Now a dead PID means the lock is stolen transparently.
    const repo = makeRepo();
    const lockPath = join(repo, 'code.lock');
    // Write a lock file claiming PID 1 (kernel, definitely alive) — should NOT be stolen.
    const { writeFileSync, readFileSync } = await import('fs');
    writeFileSync(lockPath, 'toshelabs-pipeline: live run pid=1\n');
    const blocked = await acquireLock(lockPath, 'me');
    assert.equal(blocked.acquired, false, 'live pid=1 should block');
    // Now replace with a pid that can never be alive (max int).
    writeFileSync(lockPath, 'toshelabs-pipeline: zombie run pid=2147483647\n');
    const stolen = await acquireLock(lockPath, 'me');
    assert.equal(stolen.acquired, true, 'dead pid should be stolen');
    const contents = readFileSync(lockPath, 'utf-8');
    assert.match(contents, new RegExp(`pid=${process.pid}`));
    await releaseLock(lockPath);
  });

  test('new locks write the current process pid into the file', async () => {
    const repo = makeRepo();
    const lockPath = join(repo, 'code.lock');
    await acquireLock(lockPath, 'test');
    const { readFileSync } = await import('fs');
    const contents = readFileSync(lockPath, 'utf-8');
    assert.match(contents, new RegExp(`pid=${process.pid}`));
    await releaseLock(lockPath);
  });
});
