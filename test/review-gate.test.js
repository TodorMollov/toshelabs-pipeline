// T-053: the review phase must apply the rubric and must never ship an
// unreviewed ticket as "clean".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { loadCodeValidationRubric, decideReviewGate } from '../src/review-gate.js';

describe('loadCodeValidationRubric', () => {
  test('returns the rubric contents when docs/code_validation.md exists', () => {
    const wt = mkdtempSync(resolve(tmpdir(), 'wt-'));
    try {
      mkdirSync(resolve(wt, 'docs'), { recursive: true });
      writeFileSync(resolve(wt, 'docs/code_validation.md'), '# Rules\nRule 9 — Never swallow errors\n');
      const out = loadCodeValidationRubric(wt);
      assert.match(out, /Rule 9 — Never swallow errors/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test('returns a sentinel (never throws) when the file is missing', () => {
    const wt = mkdtempSync(resolve(tmpdir(), 'wt-'));
    try {
      const out = loadCodeValidationRubric(wt);
      assert.match(out, /no docs\/code_validation\.md/);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test('returns a sentinel when no worktree is provided', () => {
    assert.match(loadCodeValidationRubric(null), /worktree path/);
  });
});

describe('decideReviewGate', () => {
  test('BLOCKS when review.json could not be validated (the silent-pass bug)', () => {
    const g = decideReviewGate({ status: 'mismatch', reason: 'missing review.json' });
    assert.equal(g.block, true);
    assert.match(g.reason, /unreviewed/);
  });

  test('BLOCKS on a null verify result', () => {
    assert.equal(decideReviewGate(null).block, true);
  });

  test('BLOCKS on a blocked verdict', () => {
    const g = decideReviewGate({ status: 'match', payload: { verdict: 'blocked', findings: [] } });
    assert.equal(g.block, true);
    assert.match(g.reason, /blocked/);
  });

  test('PROCEEDS on a clean verdict', () => {
    assert.equal(decideReviewGate({ status: 'match', payload: { verdict: 'clean', findings: [] } }).block, false);
  });

  test('PROCEEDS on a findings verdict (worker-apply fixes them downstream)', () => {
    assert.equal(decideReviewGate({ status: 'match', payload: { verdict: 'findings', findings: [{ id: 'F-1' }] } }).block, false);
  });
});

describe('reviewer prompt injects the rubric', () => {
  test('reviewer.md contains the {{CODE_VALIDATION}} placeholder', () => {
    const tmpl = readFileSync(resolve(import.meta.dirname, '..', 'prompts', 'reviewer.md'), 'utf-8');
    assert.ok(tmpl.includes('{{CODE_VALIDATION}}'), 'reviewer.md must inject the code_validation rubric');
  });
});
