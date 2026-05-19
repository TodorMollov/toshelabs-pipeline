// Baseline-tag rollback model (post 2026-04-28).
// Tests run in isolated temp repos so we never touch the real project.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setupTicketBaseline,
  revertToBaseline,
  commitTicketAsOne,
  cleanupBaseline,
  CheckpointError,
} from '../src/checkpoint.js';

let repoDir;

function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: repoDir, encoding: 'utf-8', ...opts }).trim();
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'pipeline-checkpoint-'));
  execSync('git init -q -b master', { cwd: repoDir });
  // Override every global git surface that could slow/block a commit:
  //   - user.email/name: avoid prompt
  //   - commit.gpgsign false: skip signing prompt
  //   - core.hooksPath /dev/null: bypass the operator's global post-commit
  //     hooks (e.g. ~/.git-hooks/post-commit triggering a code-review run).
  //     Without this, each test commit waits ~20s on the review subprocess.
  execSync(
    'git config user.email t@t.t && git config user.name t && git config commit.gpgsign false && git config core.hooksPath /dev/null',
    { cwd: repoDir },
  );
  writeFileSync(join(repoDir, 'init.txt'), 'init\n');
  execSync('git add . && git commit -q -m init', { cwd: repoDir });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('setupTicketBaseline', () => {
  test('tags HEAD as the baseline and returns the tag + sha', () => {
    const headSha = git('rev-parse HEAD');
    const res = setupTicketBaseline('T-X', repoDir);
    assert.equal(res.baselineTag, 'pipeline/T-X/baseline');
    assert.equal(res.baselineSha, headSha);
    // Tag exists.
    assert.equal(git(`rev-parse pipeline/T-X/baseline`), headSha);
  });

  test('refuses with DIRTY_TREE when working tree has tracked modifications', () => {
    writeFileSync(join(repoDir, 'init.txt'), 'changed\n');
    assert.throws(
      () => setupTicketBaseline('T-Y', repoDir),
      (err) => err instanceof CheckpointError && err.code === 'DIRTY_TREE',
    );
  });

  test('refuses with DIRTY_TREE on untracked tracked-shape files', () => {
    writeFileSync(join(repoDir, 'new.txt'), 'untracked\n');
    assert.throws(
      () => setupTicketBaseline('T-Z', repoDir),
      (err) => err instanceof CheckpointError && err.code === 'DIRTY_TREE',
    );
  });

  // PIPE-026 regression: an untracked declared context_file must NOT
  // freeze the queue, but stray uncommitted code still must.
  test('PIPE-026: untracked declared context_file is absorbed → run starts', () => {
    writeFileSync(join(repoDir, 'PINNED_API.md'), '# pinned reference\n');
    const res = setupTicketBaseline('T-CTX', repoDir, ['PINNED_API.md']);
    assert.equal(res.baselineTag, 'pipeline/T-CTX/baseline');
    // The doc was committed (absorbed), not left dirty.
    assert.equal(git('status --porcelain'), '');
    assert.match(git('log -1 --format=%s'), /\[human\] backlog edits at /);
  });

  test('PIPE-026: stray uncommitted CODE still hard-blocks even with absorb list', () => {
    writeFileSync(join(repoDir, 'PINNED_API.md'), '# pinned\n');
    writeFileSync(join(repoDir, 'src.js'), 'console.log("WIP")\n'); // not in absorb list
    assert.throws(
      () => setupTicketBaseline('T-CTX2', repoDir, ['PINNED_API.md']),
      (err) => err instanceof CheckpointError && err.code === 'DIRTY_TREE',
    );
  });

  test('PIPE-026: empty/absent absorb list = unchanged legacy behaviour', () => {
    writeFileSync(join(repoDir, 'new.txt'), 'untracked\n');
    assert.throws(
      () => setupTicketBaseline('T-CTX3', repoDir, []),
      (err) => err instanceof CheckpointError && err.code === 'DIRTY_TREE',
    );
  });

  test('idempotent: rerunning replaces the baseline tag at current HEAD', () => {
    setupTicketBaseline('T-X', repoDir);
    // Make a new commit, advancing HEAD.
    writeFileSync(join(repoDir, 'second.txt'), 'second\n');
    execSync('git add . && git commit -q -m second', { cwd: repoDir });
    const newHead = git('rev-parse HEAD');
    const res = setupTicketBaseline('T-X', repoDir);
    assert.equal(res.baselineSha, newHead, 'tag should follow HEAD on rerun');
  });
});

describe('revertToBaseline', () => {
  test('restores working tree to baseline state and removes worker edits', () => {
    setupTicketBaseline('T-X', repoDir);
    writeFileSync(join(repoDir, 'worker-output.txt'), 'worker wrote this\n');
    writeFileSync(join(repoDir, 'init.txt'), 'modified by worker\n');
    revertToBaseline('T-X', repoDir);
    // Modified file restored.
    assert.equal(execSync('cat init.txt', { cwd: repoDir, encoding: 'utf-8' }), 'init\n');
    // Untracked worker file removed.
    assert.equal(existsSync(join(repoDir, 'worker-output.txt')), false);
  });

  test('preserves gitignored files (no -x flag on clean)', () => {
    writeFileSync(join(repoDir, '.gitignore'), 'local-state.json\n');
    execSync('git add . && git commit -q -m gitignore', { cwd: repoDir });
    setupTicketBaseline('T-X', repoDir);
    // Operator's gitignored file written before/during pipeline run.
    writeFileSync(join(repoDir, 'local-state.json'), '{"x":1}\n');
    revertToBaseline('T-X', repoDir);
    // Ignored file survives — what the operator's parallel session needs.
    assert.equal(existsSync(join(repoDir, 'local-state.json')), true);
  });

  test('throws NO_BASELINE when no baseline tag exists', () => {
    assert.throws(
      () => revertToBaseline('NEVER-SET-UP', repoDir),
      (err) => err instanceof CheckpointError && err.code === 'NO_BASELINE',
    );
  });

  test('idempotent: can be called twice in a row', () => {
    setupTicketBaseline('T-X', repoDir);
    writeFileSync(join(repoDir, 'init.txt'), 'edited\n');
    revertToBaseline('T-X', repoDir);
    revertToBaseline('T-X', repoDir);
    assert.equal(execSync('cat init.txt', { cwd: repoDir, encoding: 'utf-8' }), 'init\n');
  });
});

describe('commitTicketAsOne', () => {
  test('commits all working-tree changes with [ticket] subject', () => {
    setupTicketBaseline('T-X', repoDir);
    writeFileSync(join(repoDir, 'a.dart'), 'class A {}\n');
    writeFileSync(join(repoDir, 'b.dart'), 'class B {}\n');
    const sha = commitTicketAsOne('T-X', 'Add A and B', repoDir);
    assert.match(sha, /^[0-9a-f]{40}$/);
    const subject = git('log -1 --pretty=%s');
    assert.equal(subject, '[T-X] Add A and B');
    const fileList = git('show --name-only --pretty= HEAD').trim().split('\n').sort();
    assert.deepEqual(fileList, ['a.dart', 'b.dart']);
  });

  test('returns null when working tree has no diff', () => {
    setupTicketBaseline('T-X', repoDir);
    const sha = commitTicketAsOne('T-X', 'Empty ticket', repoDir);
    assert.equal(sha, null);
  });

  test('handles ticket titles with shell-special characters', () => {
    setupTicketBaseline('T-X', repoDir);
    writeFileSync(join(repoDir, 'a.dart'), 'class A {}\n');
    const sha = commitTicketAsOne('T-X', 'Fix `bash` "quotes" + $vars', repoDir);
    assert.ok(sha);
    const subject = git('log -1 --pretty=%s');
    assert.equal(subject, '[T-X] Fix `bash` "quotes" + $vars');
  });

  test('truncates very long titles to 72 chars', () => {
    setupTicketBaseline('T-X', repoDir);
    writeFileSync(join(repoDir, 'a.dart'), 'class A {}\n');
    const longTitle = 'A'.repeat(200);
    commitTicketAsOne('T-X', longTitle, repoDir);
    const subject = git('log -1 --pretty=%s');
    // [T-X] + space + 72 A's
    assert.equal(subject, `[T-X] ${'A'.repeat(72)}`);
  });
});

describe('cleanupBaseline', () => {
  test('removes the baseline tag', () => {
    setupTicketBaseline('T-X', repoDir);
    cleanupBaseline('T-X', repoDir);
    const exists = execSync(`git tag -l pipeline/T-X/baseline`, { cwd: repoDir, encoding: 'utf-8' }).trim();
    assert.equal(exists, '');
  });

  test('idempotent — no error if tag already missing', () => {
    cleanupBaseline('NEVER-SET-UP', repoDir);
    // No throw.
  });
});

describe('end-to-end happy path', () => {
  test('setup → edit → commit → cleanup', () => {
    const baselineSha = git('rev-parse HEAD');
    const res = setupTicketBaseline('T-FLOW', repoDir);
    assert.equal(res.baselineSha, baselineSha);

    writeFileSync(join(repoDir, 'feature.dart'), 'feature code\n');
    writeFileSync(join(repoDir, 'feature_test.dart'), 'feature test\n');

    const ticketSha = commitTicketAsOne('T-FLOW', 'Add feature', repoDir);
    assert.match(ticketSha, /^[0-9a-f]{40}$/);

    cleanupBaseline('T-FLOW', repoDir);

    // Master has one new commit; baseline tag is gone.
    assert.equal(git('rev-parse HEAD'), ticketSha);
    assert.notEqual(ticketSha, baselineSha);
    assert.equal(execSync('git tag -l pipeline/T-FLOW/baseline', { cwd: repoDir, encoding: 'utf-8' }).trim(), '');
  });
});

describe('end-to-end failure path', () => {
  test('setup → edit → revert restores master tip exactly', () => {
    const baselineSha = git('rev-parse HEAD');
    setupTicketBaseline('T-FAIL', repoDir);

    writeFileSync(join(repoDir, 'broken.dart'), 'syntax error\n');
    writeFileSync(join(repoDir, 'init.txt'), 'corrupted\n');

    revertToBaseline('T-FAIL', repoDir);
    cleanupBaseline('T-FAIL', repoDir);

    // Tree is back to baseline state.
    assert.equal(git('rev-parse HEAD'), baselineSha);
    assert.equal(existsSync(join(repoDir, 'broken.dart')), false);
    assert.equal(execSync('cat init.txt', { cwd: repoDir, encoding: 'utf-8' }), 'init\n');
  });
});
