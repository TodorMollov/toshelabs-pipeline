// Phase-verify escape hatches for legitimate worker shapes that the strict
// rules previously false-failed (2026-05-27):
//   - checkTestsGreenPhase: all_pass:true alongside a documented pre-existing
//     baseline red (BUG-1011 shape).
//   - checkImplementPhase: empty files_changed when the fix was already
//     shipped by a prior ticket and the deliverable is test-only (BUG-1017
//     shape) — justified via reasoned files_skipped entries.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyCheckpoint } from '../src/phase-verify.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'phase-verify-'));
  const ticketDir = join(dir, 'worker-output');
  const worktree = join(dir, 'worktree');
  mkdirSync(ticketDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { dir, ticketDir, worktree, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writePhase(ticketDir, phase, payload) {
  writeFileSync(join(ticketDir, `${phase}.json`), JSON.stringify(payload, null, 2));
}

describe('checkTestsGreenPhase — documented-baseline escape hatch', () => {
  test('all_pass:true alongside unit_tests.failed>0 ACCEPTS when preexisting_failures is documented (BUG-1011 shape)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 3127, failed: 1, skipped: 0 },
        analyzer_errors: 0,
        regression_introduced: false,
        preexisting_failures: ['backend:m007-backfill-next-fire-at'],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'match', `expected match, got ${r.status}: ${r.reason}`);
    } finally { cleanup(); }
  });

  test('all_pass:true alongside unit_tests.failed>0 REJECTS when no preexisting baseline documented', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 100, failed: 1, skipped: 0 },
        analyzer_errors: 0,
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence');
      assert.match(r.reason, /all_pass but unit_tests.failed=1/);
    } finally { cleanup(); }
  });

  test('all_pass:true alongside unit_tests.failed>0 REJECTS when preexisting_failures is empty', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 100, failed: 1, skipped: 0 },
        analyzer_errors: 0,
        regression_introduced: false,
        preexisting_failures: [],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence');
    } finally { cleanup(); }
  });

  test('all_pass:true + unit_tests.failed:0 still matches (unchanged happy path)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 100, failed: 0, skipped: 0 },
        analyzer_errors: 0,
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'match');
    } finally { cleanup(); }
  });

  // PIPE-029: the documented baseline must COVER the failing count — a single
  // documented red must not excuse N actual reds.
  test('all_pass:true + failed:3 REJECTS when only 1 red is documented (under-covered baseline)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 100, failed: 3, skipped: 0 },
        analyzer_errors: 0,
        regression_introduced: false,
        preexisting_failures: ['only-one-documented'],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence', `expected divergence, got ${r.status}`);
      assert.match(r.reason, /only 1 red\(s\) itemised/);
    } finally { cleanup(); }
  });

  test('all_pass:true + failed:3 ACCEPTS when all 3 reds are itemised as pre-existing (T-179 shape, fixed)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 508, failed: 3, skipped: 11 },
        analyzer_errors: 0,
        regression_introduced: false,
        preexisting_failures: [
          'createLeague:app-check-deferral',
          'joinLeagueByCode:app-check-deferral',
          'deleteAccount:app-check-deferral',
        ],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'feature' } });
      assert.equal(r.status, 'match', `expected match, got ${r.status}: ${r.reason}`);
    } finally { cleanup(); }
  });

  test('preexisting_failures nested under full_suite is accepted defensively', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'tests_green', {
        all_pass: true,
        unit_tests: { passed: 10, failed: 2, skipped: 0 },
        analyzer_errors: 0,
        regression_introduced: false,
        full_suite: { preexisting_failures: ['red-a', 'red-b'] },
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'tests_green', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'match', `expected match, got ${r.status}: ${r.reason}`);
    } finally { cleanup(); }
  });
});

describe('checkImplementPhase — no-source-change escape hatch', () => {
  test('empty files_changed ACCEPTS when files_skipped has reasoned entries (BUG-1017 shape)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'implement', {
        files_changed: [],
        files_skipped: [{
          path: 'app/lib/core/routing/shell_screen.dart',
          reason: 'No production source change required. BUG-1017s fix_plan called for replacing the unsafe while-canPop-pop loop, but that pattern was already removed by BUG-1018 (commit 867919c) which switched to goBranch(initialLocation: true). The literal fix would be strictly inferior.',
        }],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'implement', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'match', `expected match, got ${r.status}: ${r.reason}`);
    } finally { cleanup(); }
  });

  test('empty files_changed REJECTS when files_skipped is empty', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'implement', { files_changed: [], files_skipped: [] });
      const r = verifyCheckpoint({ ticketDir, phase: 'implement', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence');
      assert.match(r.reason, /zero files_changed/);
    } finally { cleanup(); }
  });

  test('empty files_changed REJECTS when files_skipped entries lack reason field', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'implement', {
        files_changed: [],
        files_skipped: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'implement', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence');
    } finally { cleanup(); }
  });

  test('empty files_changed REJECTS when reason is a stub string (< 20 chars)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'implement', {
        files_changed: [],
        files_skipped: [{ path: 'src/foo.ts', reason: 'too short' }],
      });
      const r = verifyCheckpoint({ ticketDir, phase: 'implement', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence');
    } finally { cleanup(); }
  });

  test('non-empty files_changed still validates existence (unchanged behavior)', () => {
    const { ticketDir, worktree, cleanup } = tmp();
    try {
      writePhase(ticketDir, 'implement', { files_changed: ['nonexistent/file.ts'] });
      const r = verifyCheckpoint({ ticketDir, phase: 'implement', worktree, ticket: { type: 'bug' } });
      assert.equal(r.status, 'divergence');
      assert.match(r.reason, /does not exist in worktree/);
    } finally { cleanup(); }
  });
});
