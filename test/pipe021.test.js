// PIPE-021: bounded cherry-pick retry + archive reconciliation invariant.
// The cherry-pick mechanics seam (ok/EMPTY/CONFLICT/DIRTY/WRONG_BRANCH) is
// already covered by worktree.test.js; this covers the NEW pieces:
//   - setBacklogTicketStatus (the park that bounds the infinite re-queue)
//   - reconcileArchiveInvariant (false-done detection)
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setBacklogTicketStatus } from '../src/backlog.js';
import { Pipeline } from '../src/pipeline.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pipe021-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('setBacklogTicketStatus (PIPE-021 park)', () => {
  test('parks the ticket with status + machine reason, leaves others intact', async () => {
    const backlog = join(dir, 'backlog.json');
    writeFileSync(backlog, JSON.stringify({ tickets: [
      { id: 'T-1', status: 'requested', title: 'a' },
      { id: 'T-2', status: 'requested', title: 'b' },
    ] }));
    const config = { _resolved: { backlog } };
    const t = await setBacklogTicketStatus('T-1', config, 'manual', 'cherry-pick keeps failing after 3 attempts');
    assert.equal(t.status, 'manual');
    const after = JSON.parse(readFileSync(backlog, 'utf-8'));
    assert.equal(after.tickets[0].status, 'manual');
    assert.match(after.tickets[0].blocked_reason, /cherry-pick keeps failing/);
    assert.ok(after.tickets[0].blocked_at);
    assert.equal(after.tickets[1].status, 'requested', 'other tickets untouched');
  });

  test('absent ticket is a no-op (returns null), file unchanged', async () => {
    const backlog = join(dir, 'backlog.json');
    const orig = JSON.stringify({ tickets: [{ id: 'T-1', status: 'requested' }] });
    writeFileSync(backlog, orig);
    const r = await setBacklogTicketStatus('T-NOPE', { _resolved: { backlog } }, 'manual', 'x');
    assert.equal(r, null);
    assert.equal(readFileSync(backlog, 'utf-8'), orig);
  });
});

describe('reconcileArchiveInvariant (PIPE-021 false-done detection)', () => {
  function gitRepo() {
    const repo = join(dir, 'proj');
    mkdirSync(repo);
    execSync('git init -q -b master', { cwd: repo });
    execSync('git config user.email t@t.t && git config user.name t && git config commit.gpgsign false && git config core.hooksPath /dev/null', { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), '1\n');
    execSync('git add . && git commit -q -m c1', { cwd: repo });
    return repo;
  }
  // Bind the real method onto a minimal stub (avoids constructing a full
  // Pipeline; the method only touches config + emit + git).
  function runReconcile(repo, archiveTickets) {
    const archive = join(dir, 'archive.json');
    writeFileSync(archive, JSON.stringify({ tickets: archiveTickets }));
    const events = [];
    const stub = {
      config: { project_dir: repo, _resolved: { archive } },
      emit: (e, p) => events.push({ e, p }),
      reconcileArchiveInvariant: Pipeline.prototype.reconcileArchiveInvariant,
    };
    return stub.reconcileArchiveInvariant().then((v) => ({ violations: v, events }));
  }

  test('landed_commit that IS an ancestor of HEAD → no violation', async () => {
    const repo = gitRepo();
    const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
    const { violations, events } = await runReconcile(repo, [
      { id: 'T-OK', status: 'done', landed_commit: sha },
    ]);
    assert.equal(violations.length, 0);
    assert.ok(events.find((x) => x.e === 'archive_invariant_ok'));
  });

  test('done ticket whose landed_commit is NOT an ancestor → flagged loud', async () => {
    const repo = gitRepo();
    // A sha that does not exist in this repo at all.
    const { violations, events } = await runReconcile(repo, [
      { id: 'T-STRAND', status: 'done', landed_commit: '0000000000000000000000000000000000000000' },
      { id: 'T-NOCOMMIT', status: 'done' }, // no landed_commit → skipped, not a violation
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, 'T-STRAND');
    assert.ok(events.find((x) => x.e === 'archive_invariant_violation'));
  });
});
