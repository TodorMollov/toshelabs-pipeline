// Worktree-per-pipeline-run isolation.
//
// Pipeline runs in a git worktree of the project rather than in the
// project's primary checkout, so the operator can keep editing files in
// the primary checkout while a ticket is being processed. The worktree
// sits at {pipelineHome}/projects/{name}/worktree and is pinned to a
// dedicated side branch (e.g. `pipeline/worktree-{name}`). At ticket
// start the side branch is reset to wherever the project's default
// branch points; on success the ticket commit is cherry-picked back
// onto the default branch in the primary checkout.
//
// Why git worktree (vs. a separate clone): worktrees share the .git
// object store and refs with the primary checkout, so default-branch
// updates instantly become visible in the worktree, and the ticket
// commit's objects are already present in the primary repo by the
// time we try to cherry-pick. Zero network, no fetch races.
//
// Concurrency: this module presumes external locking. Two pipeline
// runs against the same worktree dir will race; the orchestrator's
// per-project lock is what serializes them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class WorktreeError extends Error {
  constructor(message, { code, conflictFiles, cause } = {}) {
    super(message);
    this.name = 'WorktreeError';
    if (code) this.code = code;
    if (conflictFiles) this.conflictFiles = conflictFiles;
    if (cause) this.cause = cause;
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;

function git(args, cwd, { tolerateFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
    }).trim();
  } catch (err) {
    if (tolerateFailure) return null;
    const stderr = err.stderr?.toString?.() ?? '';
    const stdout = err.stdout?.toString?.() ?? '';
    const detail = (stderr + stdout).trim() || err.message;
    throw new WorktreeError(`git ${args.join(' ')} failed: ${detail}`, {
      code: 'GIT_FAILED',
      cause: err,
    });
  }
}

// Resolve the default branch of `cwd` — the branch we treat as the
// canonical pipeline target. Falls back to `master` then `main` because
// we can't always rely on origin/HEAD being set in CI clones. Throws
// only if neither branch exists.
export function resolveDefaultBranch(cwd) {
  for (const candidate of ['master', 'main']) {
    const sha = git(['rev-parse', '--verify', `refs/heads/${candidate}`], cwd, { tolerateFailure: true });
    if (sha) return candidate;
  }
  throw new WorktreeError(`no master/main branch in ${cwd}`, { code: 'NO_DEFAULT_BRANCH' });
}

// True iff `cwd` is the registered worktree for `branchName`. We can't
// just check "is this any git worktree" — that would be true for the
// primary checkout itself, which is dangerous: an accidental config
// pointing the worktree dir at the primary checkout would bypass
// ensureWorktree's create step and let prepareWorktreeForTicket reset
// the operator's tree.
function isRegisteredWorktreeFor(masterDir, worktreeDir, branchName) {
  if (!existsSync(worktreeDir)) return false;
  const out = git(['worktree', 'list', '--porcelain'], masterDir, { tolerateFailure: true });
  if (!out) return false;
  // Porcelain blocks: "worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n"
  const blocks = out.split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    if (path && branch && samePath(path, worktreeDir) && branch === `refs/heads/${branchName}`) {
      return true;
    }
  }
  return false;
}

function samePath(a, b) {
  // Trailing-slash and trivial normalization tolerance.
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

// Idempotent: creates the worktree the first time and is a no-op every
// run after. Pinned to `branchName` so the project's default branch
// stays free in the primary checkout.
//
// Returns { worktreeDir, branch, defaultBranch }.
export function ensureWorktree(masterDir, worktreeDir, branchName) {
  const defaultBranch = resolveDefaultBranch(masterDir);
  if (isRegisteredWorktreeFor(masterDir, worktreeDir, branchName)) {
    return { worktreeDir, branch: branchName, defaultBranch };
  }
  mkdirSync(dirname(worktreeDir), { recursive: true });
  // -B resets a stale branch from a prior worktree to the default
  // branch tip. -f covers the case where the branch ref exists but the
  // dir does not (operator removed it manually).
  git(
    ['worktree', 'add', '-f', '-B', branchName, worktreeDir, defaultBranch],
    masterDir,
  );
  return { worktreeDir, branch: branchName, defaultBranch };
}

// Reset the worktree to the default branch and wipe any leftover state
// from a prior run. Called at ticket start so each ticket begins from
// a clean copy of the default branch, regardless of what the prior run
// left behind.
//
// `git clean -fdx` (with -x) removes gitignored caches too, so a prior
// ticket's build artifacts don't leak in. The default branch in the
// primary checkout is the source of truth.
export function prepareWorktreeForTicket(worktreeDir, defaultBranch) {
  git(['reset', '--hard', defaultBranch], worktreeDir);
  git(['clean', '-fdx'], worktreeDir);
}

// Attempt to cherry-pick a single commit from the worktree's branch
// onto the default branch in the primary checkout. Returns:
//   { ok: true, headSha }                 — applied cleanly
//   { ok: false, code: 'WRONG_BRANCH' }   — primary not on default branch
//   { ok: false, code: 'DIRTY' }          — primary has uncommitted WIP
//   { ok: false, code: 'EMPTY' }          — commit is no-op vs. primary
//   { ok: false, code: 'CONFLICT', files }— merge conflicts
//   { ok: false, code: 'ROLLBACK_FAILED' }— conflict + abort itself failed
//
// On conflict we run `git cherry-pick --abort` to restore the primary
// checkout to its pre-attempt state. The ticket commit stays on the
// side branch in the worktree so the operator can manually cherry-pick
// it later.
export function cherryPickToMaster(masterDir, sha, defaultBranch) {
  // Refuse if HEAD isn't pointed at the default branch — we'd silently
  // land the ticket commit on whatever branch the operator happens to
  // be on, which is the opposite of what the function name promises.
  const head = git(['symbolic-ref', '--short', 'HEAD'], masterDir, { tolerateFailure: true });
  if (head !== defaultBranch) {
    return { ok: false, code: 'WRONG_BRANCH', head };
  }
  // Refuse if the operator has uncommitted work — cherry-pick on a
  // dirty tree mixes operator edits with the ticket commit.
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: masterDir,
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
  });
  if (status.length > 0) {
    return { ok: false, code: 'DIRTY' };
  }
  let cherryErr = null;
  try {
    execFileSync('git', ['cherry-pick', sha], {
      cwd: masterDir,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
    });
    const headSha = git(['rev-parse', 'HEAD'], masterDir);
    return { ok: true, headSha };
  } catch (err) {
    cherryErr = err;
  }
  {
    // Distinguish empty/no-op from real conflicts. cherry-pick prints
    // "previous cherry-pick is now empty" to stdout (not stderr) when
    // the commit's diff is already in master, so check both streams.
    const stderr = cherryErr.stderr?.toString?.() ?? '';
    const stdout = cherryErr.stdout?.toString?.() ?? '';
    const combined = `${stdout}\n${stderr}` || cherryErr.message || '';
    const isEmpty = /nothing to commit|now empty|--allow-empty/i.test(combined);
    // Always try to abort so the tree never lingers in a half-merged
    // state. Track abort failure separately — it's a different class
    // of failure from a normal conflict.
    const abortRes = git(['cherry-pick', '--abort'], masterDir, { tolerateFailure: true });
    if (abortRes === null) {
      return {
        ok: false,
        code: 'ROLLBACK_FAILED',
        message: stderr.trim().slice(0, 500),
      };
    }
    if (isEmpty) {
      return { ok: false, code: 'EMPTY', message: stderr.trim().slice(0, 500) };
    }
    return {
      ok: false,
      code: 'CONFLICT',
      files: listConflictFilesAfterAbort(masterDir, sha),
      message: stderr.trim().slice(0, 500),
    };
  }
}

// After abort, the conflict files are no longer marked as such — but
// we can recover the list by diffing the source commit against HEAD.
function listConflictFilesAfterAbort(masterDir, sha) {
  const out = git(['show', '--name-only', '--pretty=format:', sha], masterDir, { tolerateFailure: true });
  if (!out) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
