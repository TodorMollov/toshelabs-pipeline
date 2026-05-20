// Baseline-tag rollback model (post 2026-04-28).
//
// Each ticket runs directly on master's working tree — no per-ticket branch.
// At run start we tag the master tip as `pipeline/{ticketId}/baseline`.
// Steps edit the working tree without intermediate commits. On step failure
// after heal exhaustion the orchestrator does:
//   git reset --hard pipeline/{ticketId}/baseline
//   git clean -fd
// reverting all worker edits in one atomic op. On success the orchestrator
// makes a single commit:
//   git add -A
//   git commit -m "[{ticketId}] {title}"
// then deletes the baseline tag.
//
// Why this replaces the previous per-ticket branch model:
//   - branch + state file were two sources of truth that desynced (T-359,
//     BUG-253 mis-merges). working tree on master is one source of truth.
//   - per-step commit tags pointed to commits that became orphaned when
//     `ensureBranch` reset the branch — silently destroyed the work.
//   - merge-to-master with squash had a dirty-tree class of failure modes.
//     a single commit at success has none.
//
// All operations are pure git shell-outs; no network, no global state.
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

export class CheckpointError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'CheckpointError';
    if (code) this.code = code;
  }
}

function git(args, cwd, { tolerateFailure = false } = {}) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
  } catch (err) {
    if (tolerateFailure) return null;
    const stderr = err.stderr?.toString?.() ?? err.message;
    throw new CheckpointError(`git ${args} failed: ${stderr.trim()}`, { code: 'GIT_FAILED' });
  }
}

function baselineTagName(ticketId) {
  return `pipeline/${ticketId}/baseline`;
}

// True if the working tree has any tracked modifications OR untracked files
// (gitignored files don't appear here, so backlog edits don't count).
function isDirty(cwd) {
  const status = git('status --porcelain', cwd);
  return status.length > 0;
}

// Auto-commit dirty edits to a specific allow-list of paths on the current
// branch. Pre-2026-04-28 this absorbed dirty backlog/build-log edits before
// the pipeline started a ticket. After the gitignore migration the backlog
// is invisible to git, so this function is rarely called — kept exported in
// case a future tracked-ledger needs the same shape of pre-run absorption.
export function autoCommitPaths(cwd, paths) {
  // Use execSync directly so we keep the leading space that `git status
  // --porcelain` emits for unstaged-only changes (` M path`). The shared
  // git() helper trims the full output, which would shift paths by one
  // column on the first line.
  const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' });
  if (!status) return null;
  const allowed = new Set(paths);
  const matched = [];
  for (const line of status.split('\n')) {
    if (!line) continue;
    // Porcelain v1: cols 0-1 = status, col 2 = space, col 3+ = path.
    const path = line.slice(3);
    if (allowed.has(path)) matched.push(path);
  }
  if (matched.length === 0) return null;
  for (const p of matched) git(`add ${JSON.stringify(p)}`, cwd);
  const staged = git('diff --cached --name-only', cwd);
  if (!staged) return null;
  const iso = new Date().toISOString();
  git(`commit -m ${JSON.stringify(`[human] backlog edits at ${iso}`)}`, cwd);
  return git('rev-parse HEAD', cwd);
}

// Set up the baseline tag at run start. Refuses if the working tree has
// any tracked modifications — operator's WIP must be committed/stashed
// first; the pipeline will not run alongside dirty code (its rollback
// would clobber the WIP).
//
// Idempotent: rerunning replaces the tag at HEAD.
//
// PIPE-026: `absorbPaths` is an allow-list of declared non-code pinned paths
// (project `context_files` — pinned API/reference docs). These are an
// intended, common setup and are frequently untracked. isDirty() counts
// untracked files, so without this an untracked pinned doc makes EVERY
// ticket fail at startup with DIRTY_TREE and freezes the whole queue with
// no obvious cause. We auto-commit ONLY those declared paths before the
// dirty check; genuine uncommitted CODE/WIP still hard-blocks as before.
//
// Returns { baselineTag, baselineSha }.
export function setupTicketBaseline(ticketId, cwd, absorbPaths = []) {
  if (Array.isArray(absorbPaths) && absorbPaths.length > 0) {
    try {
      autoCommitPaths(cwd, absorbPaths);
    } catch {
      // Best-effort: a failed absorption must not be more fatal than the
      // DIRTY_TREE it was trying to prevent. Fall through to isDirty.
    }
  }
  if (isDirty(cwd)) {
    throw new CheckpointError(
      `working tree has uncommitted changes — refusing to start pipeline. ` +
        `Commit or stash first (git status).`,
      { code: 'DIRTY_TREE' },
    );
  }
  const tag = baselineTagName(ticketId);
  // -f overwrites if a stale baseline tag exists from a prior run.
  git(`tag -f ${tag} HEAD`, cwd);
  const sha = git(`rev-parse ${tag}`, cwd);
  return { baselineTag: tag, baselineSha: sha };
}

// Revert all worker edits made since the baseline was set. Used on step
// failure after heal exhaustion. The baseline tag itself is left in place
// so the same rollback can be repeated idempotently.
//
// `git clean -fd` removes untracked files but NOT ignored ones (no -x), so
// the gitignored backlog files survive intact.
//
// 2026-05-20 (post-T-045 incident): before the destructive reset we tag the
// pre-revert HEAD as `pipeline/{ticketId}/failed-{ts}` and dump a patch to
// `worker-output/{ticketId}/diff-{ts}.patch`. Either survives the reset;
// the operator can `git checkout pipeline/{ticketId}/failed-*` to inspect
// the wiped work or `git apply` the patch into a fresh branch. Tag count
// is bounded by the number of times revert fires (≤ a few per ticket).
export function revertToBaseline(ticketId, cwd, { workerOutputDir } = {}) {
  const tag = baselineTagName(ticketId);
  const exists = git(`rev-parse --verify ${tag}`, cwd, { tolerateFailure: true }) !== null;
  if (!exists) {
    throw new CheckpointError(
      `baseline tag ${tag} not found — cannot revert`,
      { code: 'NO_BASELINE' },
    );
  }
  // Preserve the diff before nuking it. Best-effort — failure to preserve
  // is logged but does not block the revert (the revert is load-bearing,
  // the preservation is diagnostic).
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const status = git('status --porcelain', cwd, { tolerateFailure: true }) || '';
    if (status.length > 0) {
      // 1. Lightweight tag of current HEAD (covers committed-but-not-merged
      //    state, unusual for the pipeline but possible if a step committed).
      git(`tag pipeline/${ticketId}/failed-${ts} HEAD`, cwd, { tolerateFailure: true });
      // 2. Patch of the actual working-tree diff (incl. untracked files via
      //    --no-prefix would be nice but git diff doesn't do untracked; we
      //    cover untracked via `git add -N` so they show up as new files).
      if (workerOutputDir) {
        try {
          execSync('git add -N .', { cwd, encoding: 'utf-8' });
          const diff = execSync('git diff HEAD', { cwd, encoding: 'utf-8' });
          if (diff && diff.length > 0) {
            writeFileSync(`${workerOutputDir}/diff-${ts}.patch`, diff);
          }
          // Undo the -N intent-to-add so reset --hard is clean.
          execSync('git reset', { cwd, encoding: 'utf-8' });
        } catch {
          // Patch preservation is best-effort.
        }
      }
    }
  } catch {
    // Never let preservation failure block the revert.
  }
  git(`reset --hard ${tag}`, cwd);
  git('clean -fd', cwd);
}

// Make the single ticket commit at success. Stages everything in the
// working tree (including new files the worker created) — the
// commit IS the ticket's output. Returns the new commit sha.
//
// On a dirty index that's actually empty (no real changes), commits a
// no-op may not be possible; we return null in that case.
export function commitTicketAsOne(ticketId, title, cwd) {
  git('add -A', cwd);
  const staged = git('diff --cached --name-only', cwd);
  if (!staged) return null;
  const subject = title
    ? `[${ticketId}] ${String(title).slice(0, 72)}`
    : `[${ticketId}]`;
  // Pipe the message via a temp file (written by Node, not shell) so
  // titles with quotes/backticks/dollars can't break the shell command.
  const msgPath = `/tmp/.pipeline-ticket-msg-${ticketId}-${Date.now()}`;
  writeFileSync(msgPath, `${subject}\n`);
  try {
    git(`commit -F ${msgPath}`, cwd);
  } finally {
    try { unlinkSync(msgPath); } catch { /* best effort */ }
  }
  return git('rev-parse HEAD', cwd);
}

// Drop the baseline tag at end of ticket (success path or after a clean
// failure rollback). Idempotent — silent if the tag is already gone.
export function cleanupBaseline(ticketId, cwd) {
  const tag = baselineTagName(ticketId);
  git(`tag -d ${tag}`, cwd, { tolerateFailure: true });
}
