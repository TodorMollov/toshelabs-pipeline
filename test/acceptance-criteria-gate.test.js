// Acceptance-criteria gate (criteria-before-code, CLAUDE.md Rule 14).
//
// A behavioural, non-trivial ticket must carry non-empty acceptance_criteria
// before it can enter the actionable queue or be marked done. This is the
// gate that would have stopped predictor T-004/T-008/T-009/T-016/T-036 from
// shipping "done" with acceptance_criteria=None.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTicket,
  validateAndPartition,
  needsAcceptanceCriteria,
  hasAcceptanceCriteria,
  checkDoneTransition,
} from '../src/ticket-schema.js';

function baseTicket(over = {}) {
  return {
    id: 'T-100',
    schema_version: 1,
    title: 'A sufficiently long ticket title here',
    status: 'requested',
    priority: 'P1',
    type: 'feature',
    complexity: 'medium',
    description: 'x'.repeat(60),
    ...over,
  };
}

describe('needsAcceptanceCriteria', () => {
  test('behavioural + non-trivial + workable status → true', () => {
    assert.equal(needsAcceptanceCriteria(baseTicket()), true);
    assert.equal(needsAcceptanceCriteria(baseTicket({ type: 'bug' })), true);
    assert.equal(needsAcceptanceCriteria(baseTicket({ type: 'ux', status: 'in_progress' })), true);
  });

  test('trivial complexity is exempt', () => {
    assert.equal(needsAcceptanceCriteria(baseTicket({ complexity: 'trivial' })), false);
  });

  test('non-behavioural types are exempt', () => {
    for (const type of ['ops', 'chore', 'docs', 'manual', 'refactor', 'test']) {
      assert.equal(needsAcceptanceCriteria(baseTicket({ type })), false, type);
    }
  });

  test('parked / terminal statuses are not gated', () => {
    for (const status of ['blocked', 'monitor', 'v2', 'done']) {
      assert.equal(needsAcceptanceCriteria(baseTicket({ status })), false, status);
    }
  });
});

describe('hasAcceptanceCriteria', () => {
  test('non-empty array of non-empty strings → true', () => {
    assert.equal(hasAcceptanceCriteria(baseTicket({ acceptance_criteria: ['Given X, when Y, then Z'] })), true);
  });
  test('missing / empty / blank-only → false', () => {
    assert.equal(hasAcceptanceCriteria(baseTicket()), false);
    assert.equal(hasAcceptanceCriteria(baseTicket({ acceptance_criteria: [] })), false);
    assert.equal(hasAcceptanceCriteria(baseTicket({ acceptance_criteria: ['', '   '] })), false);
  });
});

describe('validateTicket with requireAcceptanceCriteria', () => {
  test('flags a criteria-less behavioural ticket only when the option is on', () => {
    const t = baseTicket();
    assert.equal(validateTicket(t).ok, true, 'default: not enforced');
    const res = validateTicket(t, undefined, { requireAcceptanceCriteria: true });
    assert.equal(res.ok, false);
    assert.equal(res.violations[0].field, 'acceptance_criteria');
    assert.equal(res.violations[0].rule, 'required_before_work');
  });

  test('passes when criteria present', () => {
    const t = baseTicket({ acceptance_criteria: ['Given X, when Y, then Z'] });
    assert.equal(validateTicket(t, undefined, { requireAcceptanceCriteria: true }).ok, true);
  });

  test('exempt ticket passes even with the option on', () => {
    const t = baseTicket({ type: 'ops' });
    assert.equal(validateTicket(t, undefined, { requireAcceptanceCriteria: true }).ok, true);
  });
});

describe('validateAndPartition strict + requireAcceptanceCriteria', () => {
  test('criteria-less behavioural ticket is rejected from the actionable queue', async () => {
    const tickets = [
      baseTicket({ id: 'T-101' }), // no criteria → rejected
      baseTicket({ id: 'T-102', acceptance_criteria: ['Given X, when Y, then Z'] }), // ok
      baseTicket({ id: 'T-103', type: 'ops' }), // exempt
    ];
    const { accepted, rejected } = await validateAndPartition(tickets, {
      mode: 'strict',
      requireAcceptanceCriteria: true,
    });
    const acceptedIds = accepted.map((t) => t.id);
    assert.deepEqual(acceptedIds.sort(), ['T-102', 'T-103']);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].id, 'T-101');
  });

  test('with the option off, criteria-less tickets still pass schema', async () => {
    const { accepted } = await validateAndPartition([baseTicket({ id: 'T-104' })], {
      mode: 'strict',
      requireAcceptanceCriteria: false,
    });
    assert.equal(accepted.length, 1);
  });
});

describe('checkDoneTransition', () => {
  test('blocks behavioural non-trivial done without criteria, regardless of status', () => {
    const t = baseTicket({ status: 'done' });
    const gate = checkDoneTransition(t);
    assert.equal(gate.ok, false);
    assert.equal(gate.violation.field, 'acceptance_criteria');
  });
  test('allows when criteria present', () => {
    assert.equal(checkDoneTransition(baseTicket({ status: 'done', acceptance_criteria: ['a'] })).ok, true);
  });
  test('allows trivial and non-behavioural types', () => {
    assert.equal(checkDoneTransition(baseTicket({ complexity: 'trivial' })).ok, true);
    assert.equal(checkDoneTransition(baseTicket({ type: 'ops' })).ok, true);
  });
});
