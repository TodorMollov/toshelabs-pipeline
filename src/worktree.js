// Worktree-per-pipeline-run isolation (post 2026-04-28).
//
// Pipeline runs in a git worktree of the project rather than in the
// project's primary checkout, so the operator can keep editing files in
// the primary checkout while a ticket is being processed. The worktree
// sits at {pipelineHome}/projects/{name}/worktree and is pinned to
// branch `pipeline/worktree-{name}`. At ticket start the side branch is
// reset to wherever master currently points; on success the ticket
// commit is cherry-picked back onto the primary checkout's master.
//
// Why git worktree (vs. a separate clone): worktrees share the .git
// object store and refs with the primary checkout, so master moves
// instantly become visible in the worktree, and the ticket commit's
// objects are already present in the primary repo by the time we try
// to cherry-pick. Zero network, no fetch races.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class WorktreeError extends Error {
  constructor(message, { code, conflictFiles } = {}) {
    super(message);
    this.name = 'WorktreeError';
    if (code) this.code = code;
    if (conflictFiles) this.conflictFiles = conflictFiles;
  }
}

function git(args, cwd, { tolerateFailure = false } = {}) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
  } catch (err) {
    if (tolerateFailure) return null;
    const stderr = err.stderr?.toString?.() ?? err.message;
    throw new WorktreeError(`git ${args} failed: ${stderr.trim()}`, { code: 'GIT_FAILED' });
  }
}

function isWorktreeDir(path) {
  if (!existsSync(path)) return false;
  // A registered worktree has a .git file (not directory) pointing at the
  // gitdir under the primary repo's worktrees/ folder.
  try {
    return execSync(`git -C ${JSON.stringify(path)} rev-parse --is-inside-work-tree`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

// Idempotent: creates the worktree the first time and is a no-op every
// run after. Pinned to `pipeline/worktree-{name}` (separate branch so
// master stays free in the primary checkout).
//
// Returns { worktreeDir, branch }.
export function ensureWorktree(masterDir, worktreeDir, branchName) {
  if (isWorktreeDir(worktreeDir)) {
    return { worktreeDir, branch: branchName };
  }
  // Create parent dir if missing — git worktree add does not mkdir -p.
  mkdirSync(dirname(worktreeDir), { recursive: true });
  // Use -B so a stale branch from a prior worktree gets reset to current
  // master. -f covers the case where the branch exists but the dir does
  // not (operator manually removed the dir).
  git(
    `worktree add -f -B ${JSON.stringify(branchName)} ${JSON.stringify(worktreeDir)} master`,
    masterDir,
  );
  return { worktreeDir, branch: branchName };
}

// Reset the worktree to master and wipe any leftover state from a prior
// run. Called at ticket start so each ticket begins from a clean copy
// of master, regardless of what the prior run left behind.
//
// Uses `git clean -fdx` (with -x) to nuke even gitignored caches that
// might confuse the next run. Master in the primary checkout is the
// source of truth.
export function prepareWorktreeForTicket(worktreeDir) {
  git('reset --hard master', worktreeDir);
  git('clean -fd', worktreeDir);
}

// Attempt to cherry-pick a single commit from the worktree's branch
// onto master in the primary checkout. Returns:
//   { ok: true, sha }                    — applied cleanly
//   { ok: false, code: 'DIRTY' }          — primary checkout has WIP
//   { ok: false, code: 'CONFLICT', files }— cherry-pick had merge conflicts
//
// On conflict, the primary checkout is restored to its pre-attempt
// state (`git cherry-pick --abort`) so the operator's tree is never
// left in a half-merged state. The ticket commit stays on the side
// branch so the operator can do a manual cherry-pick later.
export function cherryPickToMaster(masterDir, sha) {
  // Refuse if the operator has uncommitted work — cherry-pick on a
  // dirty tree mixes operator edits with the ticket commit.
  const status = execSync('git status --porcelain', { cwd: masterDir, encoding: 'utf-8' });
  if (status.length > 0) {
    return { ok: false, code: 'DIRTY' };
  }
  try {
    git(`cherry-pick ${sha}`, masterDir);
    const head = git('rev-parse HEAD', masterDir);
    return { ok: true, sha: head };
  } catch (err) {
    // Roll back to keep the operator's tree in its prior shape.
    const conflictFiles = listConflictFiles(masterDir);
    git('cherry-pick --abort', masterDir, { tolerateFailure: true });
    return { ok: false, code: 'CONFLICT', files: conflictFiles, message: err.message };
  }
}

function listConflictFiles(cwd) {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf-8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
