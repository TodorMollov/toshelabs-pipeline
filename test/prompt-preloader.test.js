// Pre-loader for the plan step: extracts file paths from the ticket's
// description + fix_plan and injects file content directly into the prompt
// so the worker doesn't burn LLM round-trips re-Reading them.
//
// Evidence from 2026-04-25: T-359 plan re-read parse-input.test.ts 3 times
// and onboarding_screen.dart 8 times across BUG-250 — each re-read = one
// wasted LLM round-trip. Pre-loading collapses those into the initial prompt.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPrompt } from '../src/prompts.js';

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-prompt-'));
  mkdirSync(join(dir, 'app/lib/features/foo'), { recursive: true });
  mkdirSync(join(dir, 'backend/src'), { recursive: true });
  writeFileSync(
    join(dir, 'app/lib/features/foo/widget.dart'),
    Array.from({ length: 50 }, (_, i) => `line ${i + 1}: code`).join('\n'),
  );
  writeFileSync(
    join(dir, 'backend/src/api.ts'),
    'export function api() { return 42; }\n',
  );
  return dir;
}

const baseConfig = (projectDir) => ({
  project_dir: projectDir,
  _resolved: { pipelineDir: '/tmp/x', backlog: '/tmp/x/backlog.json' },
  project_profile: { docs_check_files: [] },
});

describe('plan prompt — referenced file pre-loader', () => {
  test('injects files mentioned in description', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-X', title: 't', type: 'feature',
        description: 'Modify backend/src/api.ts to return 43.',
      };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      assert.match(prompt, /FILES REFERENCED IN THIS TICKET/);
      assert.match(prompt, /<file path="backend\/src\/api\.ts">/);
      assert.match(prompt, /export function api/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injects only the requested line range when specified', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-Y', title: 't', type: 'feature',
        description: 'See app/lib/features/foo/widget.dart:10-12 for the bug location.',
      };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      assert.match(prompt, /<file path="app\/lib\/features\/foo\/widget\.dart" lines="10-12">/);
      assert.match(prompt, /line 10: code/);
      assert.match(prompt, /line 12: code/);
      assert.doesNotMatch(prompt, /line 1: code\n/); // out of range, not included
      assert.doesNotMatch(prompt, /line 50: code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('extracts paths from fix_plan items too', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-Z', title: 't', type: 'feature',
        description: 'Bug fix.',
        fix_plan: [
          'Update backend/src/api.ts to handle the new case.',
          'Test app/lib/features/foo/widget.dart for regression.',
        ],
      };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      assert.match(prompt, /<file path="backend\/src\/api\.ts">/);
      assert.match(prompt, /<file path="app\/lib\/features\/foo\/widget\.dart">/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does NOT inject files for non-plan steps', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-A', title: 't', type: 'feature',
        description: 'Change backend/src/api.ts.',
      };
      const prompt = await buildPrompt(
        { name: 'tests_red' }, ticket, { steps: {} }, baseConfig(dir),
      );
      assert.doesNotMatch(prompt, /FILES REFERENCED IN THIS TICKET/);
      assert.doesNotMatch(prompt, /<file path=/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('silently skips missing files', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-B', title: 't', type: 'feature',
        description: 'Modify nonexistent/path.dart and backend/src/api.ts.',
      };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      // Existing file shows up; missing file is silently dropped from the
      // pre-loaded blocks (path may still appear in the description).
      assert.match(prompt, /<file path="backend\/src\/api\.ts">/);
      assert.doesNotMatch(prompt, /<file path="nonexistent/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plan prompt mentions PARALLEL TOOL CALLS rule prominently', async () => {
    const dir = makeProject();
    try {
      const ticket = { id: 'T-P', title: 't', type: 'feature', description: 'd' };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      assert.match(prompt, /CRITICAL RULE — PARALLEL TOOL CALLS/);
      // The rule must be ahead of the OUTPUT RULES block to be the first
      // efficiency directive the worker sees.
      assert.ok(
        prompt.indexOf('CRITICAL RULE — PARALLEL TOOL CALLS') < prompt.indexOf('OUTPUT RULES'),
        'parallel rule should come before OUTPUT RULES',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multi-range syntax injects every range, not just the first', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-MR', title: 't', type: 'feature',
        description: 'See app/lib/features/foo/widget.dart:5-7, 20-22 for both spots.',
      };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      // First range present.
      assert.match(prompt, /lines="5-7"/);
      assert.match(prompt, /line 5: code/);
      // Second range AFTER the comma also present.
      assert.match(prompt, /lines="20-22"/);
      assert.match(prompt, /line 20: code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bare filename references backfill ranges onto full-path entries', async () => {
    const dir = makeProject();
    try {
      const ticket = {
        id: 'T-BF', title: 't', type: 'feature',
        description: 'Modify app/lib/features/foo/widget.dart:5-7.',
        fix_plan: [
          'Look at widget.dart:30-32 too — same file, different section.',
        ],
      };
      const prompt = await buildPrompt(
        { name: 'plan' }, ticket, { steps: {} }, baseConfig(dir),
      );
      // The bare "widget.dart:30-32" mention should backfill onto the same
      // full-path entry, producing a second <file> block for those lines.
      assert.match(prompt, /lines="5-7"/);
      assert.match(prompt, /lines="30-32"/);
      assert.match(prompt, /line 30: code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
