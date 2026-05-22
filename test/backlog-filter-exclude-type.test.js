// filterAndSort exclude_type: human-only ticket types (e.g. manual) must
// never enter the actionable queue, so the pipeline doesn't spend tokens
// attempting work it can't finish (Play console submission, marketing).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { filterAndSort } from '../src/backlog.js';

const baseFilter = {
  exclude_status: ['done', 'monitor'],
  priority_order: ['P0', 'P1', 'P2', 'P3'],
  type_order: ['bug', 'feature', 'ux', 'ops', 'manual'],
};

function t(over) {
  return { id: 'T-1', status: 'requested', priority: 'P1', type: 'feature', ...over };
}

describe('filterAndSort exclude_type', () => {
  test('drops tickets whose type is excluded', () => {
    const tickets = [
      t({ id: 'T-1', type: 'bug' }),
      t({ id: 'T-2', type: 'manual' }),
      t({ id: 'T-3', type: 'ops' }),
    ];
    const out = filterAndSort(tickets, { ticket_filter: { ...baseFilter, exclude_type: ['manual'] } });
    assert.deepEqual(out.map((x) => x.id).sort(), ['T-1', 'T-3']);
  });

  test('excludes by type even when status is actionable and priority is high', () => {
    const tickets = [t({ id: 'T-9', type: 'manual', priority: 'P0', status: 'requested' })];
    const out = filterAndSort(tickets, { ticket_filter: { ...baseFilter, exclude_type: ['manual'] } });
    assert.equal(out.length, 0);
  });

  test('no exclude_type configured → behaves as before (manual stays)', () => {
    const tickets = [t({ id: 'T-5', type: 'manual' })];
    const out = filterAndSort(tickets, { ticket_filter: { ...baseFilter } });
    assert.equal(out.length, 1);
  });

  test('exclude_type composes with exclude_status', () => {
    const tickets = [
      t({ id: 'A', type: 'manual' }),       // excluded by type
      t({ id: 'B', status: 'done' }),        // excluded by status
      t({ id: 'C', type: 'feature' }),       // kept
    ];
    const out = filterAndSort(tickets, { ticket_filter: { ...baseFilter, exclude_type: ['manual'] } });
    assert.deepEqual(out.map((x) => x.id), ['C']);
  });
});
