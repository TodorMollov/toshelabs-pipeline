// PIPE-020: hard dependency-ordering gate. A ticket only runs when every
// depends_on prerequisite has SHIPPED (archive done + landed_commit, or
// backlog done). No depends_on = unchanged behaviour (zero regression).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pipeline } from '../src/pipeline.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pipe020-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(archiveTickets, backlogTickets) {
  const archive = join(dir, 'archive.json');
  const backlog = join(dir, 'backlog.json');
  writeFileSync(archive, JSON.stringify({ tickets: archiveTickets }));
  writeFileSync(backlog, JSON.stringify({ tickets: backlogTickets }));
  return {
    config: { _resolved: { archive, backlog } },
    dependenciesSatisfied: Pipeline.prototype.dependenciesSatisfied,
  };
}

describe('dependenciesSatisfied (PIPE-020)', () => {
  test('no depends_on → satisfied (no regression)', async () => {
    const r = await ctx([], []).dependenciesSatisfied({ id: 'T-9' });
    assert.deepEqual(r, { ok: true, unsatisfied: [] });
  });

  test('empty depends_on → satisfied', async () => {
    const r = await ctx([], []).dependenciesSatisfied({ id: 'T-9', depends_on: [] });
    assert.equal(r.ok, true);
  });

  test('dep archived done WITH landed_commit → satisfied', async () => {
    const r = await ctx([{ id: 'A', status: 'done', landed_commit: 'abc' }], [])
      .dependenciesSatisfied({ id: 'B', depends_on: ['A'] });
    assert.equal(r.ok, true);
  });

  test('dep archived done WITHOUT landed_commit → NOT satisfied (false-done)', async () => {
    const r = await ctx([{ id: 'A', status: 'done' }], [])
      .dependenciesSatisfied({ id: 'B', depends_on: ['A'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unsatisfied, [{ id: 'A', status: 'done' }]);
  });

  test('dep done in backlog → satisfied', async () => {
    const r = await ctx([], [{ id: 'A', status: 'done' }])
      .dependenciesSatisfied({ id: 'B', depends_on: ['A'] });
    assert.equal(r.ok, true);
  });

  test('dep still requested → NOT satisfied, names id+status', async () => {
    const r = await ctx([], [{ id: 'A', status: 'requested' }])
      .dependenciesSatisfied({ id: 'B', depends_on: ['A'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unsatisfied, [{ id: 'A', status: 'requested' }]);
  });

  test('dep absent entirely → NOT satisfied (status=absent)', async () => {
    const r = await ctx([], []).dependenciesSatisfied({ id: 'B', depends_on: ['GHOST'] });
    assert.equal(r.ok, false);
    assert.equal(r.unsatisfied[0].status, 'absent');
  });

  test('multi-dep: one satisfied, one not → blocked on the unmet one only', async () => {
    const r = await ctx(
      [{ id: 'A', status: 'done', landed_commit: 'x' }],
      [{ id: 'C', status: 'requested' }],
    ).dependenciesSatisfied({ id: 'B', depends_on: ['A', 'C'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unsatisfied, [{ id: 'C', status: 'requested' }]);
  });

  test('dep satisfied on a later check (re-queue path) → runs', async () => {
    const c = ctx([{ id: 'A', status: 'done', landed_commit: 'sha' }], []);
    const r = await c.dependenciesSatisfied({ id: 'B', depends_on: ['A'] });
    assert.equal(r.ok, true);
  });
});
