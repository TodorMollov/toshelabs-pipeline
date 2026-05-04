/**
 * Post-step write-zone enforcement.
 *
 * Detects when a worker step has written outside its declared write zones.
 * Catches two failure classes:
 *
 *   1. Worktree-internal misroute — worker edited a file inside the worktree
 *      but outside the step's allowed write zones. Example: docs_update step
 *      touched `app/lib/foo.dart` instead of staying inside `docs/`.
 *
 *   2. Canonical-project leak — worker edited a file in the operator's
 *      primary checkout (config.project_dir) instead of the worktree. This
 *      is the docs_update class of leaks observed weeks of the pipeline run
 *      (the worker followed a CLAUDE.md absolute-path reference and wrote to
 *      canonical busydad/memory/code_validation.md). The 2026-05-03 busydad
 *      reorg removed the *causal* mechanism, but this check makes recurrence
 *      impossible regardless of project conventions.
 *
 * This is post-hoc detection (the writes already happened). For a true
 * sandbox we'd need a Claude Code PreToolUse hook intercepting Edit/Write
 * before the file changes — heavier, can come later. Post-hoc detection is
 * enough to (a) flag every leak with a clear event, (b) optionally fail
 * the step in strict mode so the next attempt sees the boundary, and
 * (c) prevent the violation from being committed (the orchestrator can
 * reset the worktree before the commit step).
 *
 * Per-step config in pipeline.config.yaml:
 *
 *   write_zones:
 *     mode: off | warn | strict          # default: off (backwards-compat)
 *     allow:                              # globs relative to worktree root
 *       - app/**
 *       - backend/**
 *       - docs/**
 *
 * When mode is strict, a violation throws so the step fails and the
 * orchestrator's normal failure-handling kicks in.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Match a path against a glob pattern. Supports:
 *   *      — any chars except `/`
 *   **     — any chars including `/`
 *   ?      — single char except `/`
 * Anchored: pattern must match the full path (no implicit prefix).
 */
function globMatch(pattern, path) {
  // Translate glob → regex
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // consume the trailing slash for **/
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+()[]{}^$|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$').test(path);
}

/**
 * List files modified or newly added since `snapshotBefore` was captured.
 * Returns relative-to-cwd paths.
 *
 * snapshotBefore: newline-joined list of `git diff --name-only HEAD` +
 * `git ls-files --others --exclude-standard` captured before the step ran.
 * Files in snapshotBefore are excluded — only NEW dirty files are returned.
 */
function dirtyFilesSince(cwd, snapshotBefore) {
  if (!existsSync(cwd)) return [];
  let trackedNow = '';
  let untrackedNow = '';
  try {
    trackedNow = execSync('git diff --name-only HEAD', { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch { /* not a git repo or HEAD missing — ignore */ }
  try {
    untrackedNow = execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch { /* ignore */ }
  const allDirty = [trackedNow, untrackedNow].filter(Boolean).join('\n').split('\n').filter(Boolean);
  const beforeSet = new Set((snapshotBefore || '').split('\n').filter(Boolean));
  return allDirty.filter((f) => !beforeSet.has(f));
}

/**
 * Check that every file the step wrote is inside an allowed glob.
 * Returns array of { path, kind } violations. kind is 'outside_zones' or
 * 'canonical_leak'.
 *
 * worktreeCwd:        the directory the step ran in (= pipeline.cwd)
 * canonicalProjectDir: the operator's primary checkout (= config.project_dir
 *                     pre-rewrite; may equal worktreeCwd if the worktree
 *                     fallback fired). When equal, canonical-leak detection
 *                     is skipped (everything's in the same place anyway).
 * worktreeSnapshotBefore: snapshot of worktree dirty files captured before
 *                     the step ran. Used to filter out pre-existing churn.
 * canonicalSnapshotBefore: same, for canonical project dir. When omitted
 *                     (caller didn't capture it), every dirty file in
 *                     canonical is flagged — appropriate for projects where
 *                     canonical is expected to be clean during pipeline runs.
 * allowGlobs:         array of globs the step is allowed to write into,
 *                     relative to the worktree root.
 */
export function checkWriteZones({
  worktreeCwd,
  canonicalProjectDir,
  worktreeSnapshotBefore,
  canonicalSnapshotBefore,
  allowGlobs,
}) {
  const violations = [];

  // Worktree-internal violations: dirty files outside allowed globs.
  const worktreeDirty = dirtyFilesSince(worktreeCwd, worktreeSnapshotBefore);
  for (const path of worktreeDirty) {
    if (!allowGlobs.some((g) => globMatch(g, path))) {
      violations.push({ path, kind: 'outside_zones', location: 'worktree' });
    }
  }

  // Canonical-leak violations: ANY dirty file in canonical project dir
  // that wasn't there before the step ran. Worker should never touch
  // canonical during a step.
  if (canonicalProjectDir && canonicalProjectDir !== worktreeCwd) {
    const canonicalDirty = dirtyFilesSince(canonicalProjectDir, canonicalSnapshotBefore);
    for (const path of canonicalDirty) {
      violations.push({ path, kind: 'canonical_leak', location: 'canonical' });
    }
  }

  return violations;
}

/**
 * Render a violations array as a human-readable multi-line string for use
 * in error messages, log lines, and event payloads. Caps line count to
 * keep huge diffs from drowning the output.
 */
export function formatViolations(violations, maxLines = 20) {
  if (violations.length === 0) return '(no violations)';
  const lines = violations.slice(0, maxLines).map((v) => {
    if (v.kind === 'canonical_leak') {
      return `  • LEAK to canonical: ${v.path}`;
    }
    return `  • OUTSIDE write_zones: ${v.path}`;
  });
  if (violations.length > maxLines) {
    lines.push(`  • … and ${violations.length - maxLines} more`);
  }
  return lines.join('\n');
}
