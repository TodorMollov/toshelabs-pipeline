// Wall-clock timeout in spawnClaude. Uses a fake claude binary (a shell
// script that sleeps) instead of the real CLI — we're testing the timer
// + signal path, not Claude itself.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { spawnClaude } from '../src/runner.js';

function makeFakeClaude(sleepSeconds) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-runner-test-'));
  const path = join(dir, 'claude');
  // Ignore stdin, print a session_id event so the runner has something to
  // parse, then sleep. Exit 0 is never reached if the runner kills us.
  // exec sleep so the parent bash is replaced — otherwise SIGTERM goes to
  // bash but `sleep` inherits and outlives its budget, defeating the test.
  writeFileSync(
    path,
    `#!/bin/bash\ncat > /dev/null\necho '{"type":"system","session_id":"test-session-123"}'\nif [ ${sleepSeconds} -gt 0 ]; then exec sleep ${sleepSeconds}; fi\necho '{"type":"result","result":"done"}'\n`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

describe('spawnClaude — wall-clock timeout', () => {
  test('kills the process and resolves timedOut:true when maxSeconds expires', async () => {
    const fakePath = makeFakeClaude(30);
    const origBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fakePath;
    const started = Date.now();
    try {
      const result = await spawnClaude({
        prompt: 'noop',
        maxSeconds: 1,
        maxTurns: 5,
        bare: false,
      });
      const elapsed = Date.now() - started;
      assert.equal(result.timedOut, true, 'timedOut flag should be set');
      // 1s budget + up to 5s grace before SIGKILL. Generous upper bound to
      // avoid CI flakes, but must be well under the fake's 30s sleep.
      assert.ok(elapsed < 10_000, `expected <10s, got ${elapsed}ms`);
    } finally {
      if (origBin) process.env.CLAUDE_BIN = origBin;
      else delete process.env.CLAUDE_BIN;
    }
  });

  test('no timeout configured → process runs to completion (no kill)', async () => {
    const fakePath = makeFakeClaude(0); // exit immediately
    const origBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = fakePath;
    try {
      const result = await spawnClaude({
        prompt: 'noop',
        maxTurns: 5,
        bare: false,
      });
      assert.equal(result.timedOut, undefined, 'timedOut should not be set when no budget given');
      assert.equal(result.exitCode, 0);
    } finally {
      if (origBin) process.env.CLAUDE_BIN = origBin;
      else delete process.env.CLAUDE_BIN;
    }
  });
});
