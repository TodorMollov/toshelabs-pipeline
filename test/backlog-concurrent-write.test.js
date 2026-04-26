// Regression suite for the 2026-04-25 backlog destruction incident.
//
// Three independent paths in the pipeline raced human edits to backlog.json:
//
//   Fix 1 — autoCommitPaths absorbs human ledger edits on the current branch
//           before DIRTY_TREE refuses (src/checkpoint.js).
//   Fix 2 — docs_update worker no longer told to write backlog.json /
//           closed-bugs.json; that's the orchestrator's job now (src/prompts.js).
//   Fix 3 — archiveTicket commits its ledger writes atomically so the next
//           ticket's checkpoint guard sees a clean tree (src/backlog.js).
//
// One test per fix.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoCommitPaths } from '../src/checkpoint.js';
import { archiveTicket } from '../src/backlog.js';
import { buildPrompt } from '../src/prompts.js';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-backlog-'));
  execSync('git init -q -b master', { cwd: dir });
  execSync('git config user.email t@t.t && git config user.name t && git config commit.gpgsign false', { cwd: dir });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  return dir;
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8' }).trim();
}

describe('Fix 1 — autoCommitPaths absorbs human ledger edits', () => {
  test('uncommitted backlog.json edit becomes a [human] commit', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'memory/backlog.json'), '{"tickets":[]}\n');
      execSync('git add . && git commit -q -m init', { cwd: repo });

      // Operator adds a ticket on disk without committing.
      writeFileSync(join(repo, 'memory/backlog.json'), '{"tickets":[{"id":"T-X"}]}\n');

      const sha = autoCommitPaths(repo, ['memory/backlog.json']);
      assert.ok(sha, 'expected a new commit sha');

      // Working tree must be clean afterwards.
      assert.equal(git('status --porcelain', repo), '');

      // HEAD's commit subject is the human-edits convention.
      const subject = git('log -1 --pretty=%s', repo);
      assert.match(subject, /^\[human\] backlog edits at /);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('does NOT commit dirty paths outside the allow-list', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'memory/backlog.json'), '{"tickets":[]}\n');
      writeFileSync(join(repo, 'src.js'), 'a\n');
      execSync('git add . && git commit -q -m init', { cwd: repo });

      writeFileSync(join(repo, 'memory/backlog.json'), '{"tickets":[{"id":"T-X"}]}\n');
      writeFileSync(join(repo, 'src.js'), 'b\n'); // unrelated WIP

      const sha = autoCommitPaths(repo, ['memory/backlog.json']);
      assert.ok(sha);

      // src.js is still dirty — only the ledger was absorbed.
      const status = git('status --porcelain', repo);
      assert.match(status, /src\.js/);
      assert.doesNotMatch(status, /backlog\.json/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('returns null when no allow-listed path is dirty', () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, 'memory/backlog.json'), '{"tickets":[]}\n');
      writeFileSync(join(repo, 'src.js'), 'a\n');
      execSync('git add . && git commit -q -m init', { cwd: repo });
      writeFileSync(join(repo, 'src.js'), 'b\n');

      const sha = autoCommitPaths(repo, ['memory/backlog.json']);
      assert.equal(sha, null);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Fix 2 — docs_update prompt does not tell worker to touch backlog', () => {
  // Minimal config shaped like loadConfig output.
  const config = {
    project_dir: '/tmp/x',
    _resolved: {
      backlog: '/tmp/x/memory/backlog.json',
      pipelineDir: '/tmp/x/memory/pipeline',
    },
    project_profile: { docs_check_files: [] },
  };
  const ticket = { id: 'T-X', title: 'sample', type: 'feature', description: 'd' };

  test('docs_update prompt does not instruct worker to update backlog status', async () => {
    const { prompt } = await buildPrompt({ name: 'docs_update' }, ticket, { steps: {} }, config);
    assert.doesNotMatch(prompt, /Update ticket status in/, 'prompt still tells worker to update backlog status');
    assert.doesNotMatch(prompt, /backlog_updated/, 'prompt still references backlog_updated field');
    assert.doesNotMatch(prompt, /\{\{backlog_path\}\}/, 'unrendered placeholder leaked into prompt');
  });

  test('docs_update prompt lists backlog files under ALREADY DONE', async () => {
    const { prompt } = await buildPrompt({ name: 'docs_update' }, ticket, { steps: {} }, config);
    assert.match(prompt, /ALREADY DONE/);
    assert.match(prompt, /memory\/backlog\.json/);
    assert.match(prompt, /memory\/backlog-archive\.json/);
  });
});

describe('Fix 3 — archiveTicket commits its ledger writes atomically', () => {
  test('working tree is clean after archiveTicket', async () => {
    const repo = makeRepo();
    try {
      writeFileSync(
        join(repo, 'memory/backlog.json'),
        JSON.stringify({ tickets: [{ id: 'T-X', title: 'a', type: 'feature' }] }, null, 2),
      );
      writeFileSync(join(repo, 'memory/backlog-archive.json'), JSON.stringify({ tickets: [] }, null, 2));
      execSync('git add . && git commit -q -m init', { cwd: repo });

      const config = {
        project_dir: repo,
        backlog_file: 'memory/backlog.json',
        archive_file: 'memory/backlog-archive.json',
        _resolved: {
          backlog: join(repo, 'memory/backlog.json'),
          archive: join(repo, 'memory/backlog-archive.json'),
        },
      };
      const archived = await archiveTicket('T-X', config);
      assert.ok(archived);
      assert.equal(archived.id, 'T-X');

      // Tree must be clean — the archiveTicket call should have committed.
      assert.equal(git('status --porcelain', repo), '');

      // HEAD subject identifies this as a pipeline archive commit.
      const subject = git('log -1 --pretty=%s', repo);
      assert.equal(subject, '[pipeline] archive T-X');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('archiveTicket leaves unrelated dirty files alone', async () => {
    const repo = makeRepo();
    try {
      writeFileSync(
        join(repo, 'memory/backlog.json'),
        JSON.stringify({ tickets: [{ id: 'T-X', title: 'a', type: 'feature' }] }, null, 2),
      );
      writeFileSync(join(repo, 'memory/backlog-archive.json'), JSON.stringify({ tickets: [] }, null, 2));
      writeFileSync(join(repo, 'unrelated.txt'), 'pre\n');
      execSync('git add . && git commit -q -m init', { cwd: repo });

      // Operator has an unrelated edit when archive runs.
      writeFileSync(join(repo, 'unrelated.txt'), 'post\n');

      const config = {
        project_dir: repo,
        backlog_file: 'memory/backlog.json',
        archive_file: 'memory/backlog-archive.json',
        _resolved: {
          backlog: join(repo, 'memory/backlog.json'),
          archive: join(repo, 'memory/backlog-archive.json'),
        },
      };
      await archiveTicket('T-X', config);

      // Ledger files committed, but unrelated.txt is still dirty.
      const status = git('status --porcelain', repo);
      assert.match(status, /unrelated\.txt/);
      assert.doesNotMatch(status, /backlog/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
