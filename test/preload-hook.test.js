// scripts/preload-soft-hook.sh — Read-tool gate that nudges the worker
// back to the pre-loaded <file> blocks instead of issuing redundant Reads.
//
// We drive the script directly with simulated PreToolUse JSON input and
// verify decision shape for each branch.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const HOOK = resolve('scripts/preload-soft-hook.sh');

function runHook({ input, env = {} }) {
  try {
    const out = execSync(`bash ${HOOK}`, {
      input,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      cwd: '/tmp',
    });
    return { stdout: out.trim(), exitCode: 0 };
  } catch (err) {
    return {
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || '').toString().trim(),
      exitCode: err.status,
    };
  }
}

describe('preload-soft-hook.sh', () => {
  test('no-op when PIPELINE_PRELOADED_FILES unset', () => {
    const r = runHook({
      input: JSON.stringify({ tool_input: { file_path: '/tmp/anything.dart' } }),
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('no-op when path not in preload list', () => {
    const r = runHook({
      input: JSON.stringify({ tool_input: { file_path: '/tmp/unrelated.dart' } }),
      env: { PIPELINE_PRELOADED_FILES: 'app/lib/foo.dart,app/lib/bar.dart' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('blocks Read on a pre-loaded path', () => {
    const r = runHook({
      input: JSON.stringify({ tool_input: { file_path: '/tmp/app/lib/foo.dart' } }),
      env: { PIPELINE_PRELOADED_FILES: 'app/lib/foo.dart' },
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
    assert.match(r.stdout, /already pre-loaded/);
    assert.match(r.stdout, /app\/lib\/foo\.dart/);
  });

  test('allows Read with explicit offset (escape hatch)', () => {
    const r = runHook({
      input: JSON.stringify({
        tool_input: { file_path: '/tmp/app/lib/foo.dart', offset: 200, limit: 50 },
      }),
      env: { PIPELINE_PRELOADED_FILES: 'app/lib/foo.dart' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });

  test('matches project-relative path even without ./ prefix', () => {
    const r = runHook({
      input: JSON.stringify({ tool_input: { file_path: 'app/lib/foo.dart' } }),
      env: { PIPELINE_PRELOADED_FILES: 'app/lib/foo.dart' },
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
  });

  test('does not match a different file with similar name', () => {
    const r = runHook({
      input: JSON.stringify({ tool_input: { file_path: 'app/lib/foo_test.dart' } }),
      env: { PIPELINE_PRELOADED_FILES: 'app/lib/foo.dart' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });
});
