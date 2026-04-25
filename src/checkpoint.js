// Per-step git snapshots for the pipeline.
//
// Each ticket runs on its own branch (`pipeline/{ticketId}`). After every
// successful step the pipeline commits a snapshot and tags it
// `pipeline/{ticketId}/step-{N}-{stepName}`. On step failure (after heal
// exhaustion) the orchestrator rewinds the working tree to the most recent
// snapshot — or to the branch base if the first step failed — so no
// partial work leaks onto disk.
//
// All operations are pure git shell-outs; no network, no global state.
import { execSync } from 'node:child_process';

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

function branchName(ticketId) {
  return `pipeline/${ticketId}`;
}

function tagName(ticketId, index, stepName) {
  return `pipeline/${ticketId}/step-${index}-${stepName}`;
}

// Compute next step index by counting existing step tags for the ticket.
function nextStepIndex(ticketId, cwd) {
  const out = git(`tag -l "pipeline/${ticketId}/step-*"`, cwd) || '';
  const tags = out.split('\n').filter(Boolean);
  return tags.length + 1;
}

// True if the working tree has any tracked modifications OR untracked files.
function isDirty(cwd) {
  const status = git('status --porcelain', cwd);
  return status.length > 0;
}

// Auto-commit dirty edits to a specific allow-list of paths on the current
// branch. Used at ticket start (and before squash-merge) to absorb the
// human session's pending edits to pipeline-managed ledgers (backlog.json,
// backlog-archive.json, closed-bugs.json) so DIRTY_TREE doesn't refuse.
//
// Code/doc dirties are intentionally NOT absorbed: those usually indicate
// WIP that shouldn't be bundled into pipeline history, and surfacing them
// via DIRTY_TREE forces the operator to handle them deliberately.
//
// Past attempts to "park" dirty edits on a side branch (autosave/{id})
// silently abandoned them when the next pipeline run reset the branch
// (2026-04-25 incident, 13 tickets lost). Committing on the current branch
// keeps the edits reachable through normal git history.
//
// Returns the new commit sha, or null if no matching dirty paths.
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

export async function ensureBranch(ticketId, cwd) {
  const branch = branchName(ticketId);
  const existed = git(`rev-parse --verify ${branch}`, cwd, { tolerateFailure: true }) !== null;

  // Refuse a dirty tree before any branch manipulation, so we never mix a
  // user's uncommitted changes into pipeline history.
  if (isDirty(cwd)) {
    throw new CheckpointError(
      `working tree has uncommitted changes — refusing to start pipeline. ` +
        `Commit or stash first (git status).`,
      { code: 'DIRTY_TREE' },
    );
  }

  if (existed) {
    // Detect operator commits sitting on this branch — they would be
    // silently abandoned by `reset --hard master`. Pipeline step commits
    // have a fixed subject shape (`[pipeline] {ticketId} step-N-{name}`)
    // so anything else ahead of master is the operator's own work.
    //
    // 2026-04-25: `1b68933` ([backlog] Recover 13 tickets …) was committed
    // by the operator onto pipeline/T-351 to recover from a separate
    // destruction incident. The next pipeline run reset that branch to
    // master and the recovery commit was orphaned (only reachable via
    // reflog). Refusing here keeps the operator's work reachable.
    const aheadSubjects = (
      git(`log master..${branch} --pretty=%s`, cwd, { tolerateFailure: true }) || ''
    ).split('\n').filter(Boolean);
    const pipelineSubject = new RegExp(`^\\[pipeline\\] ${ticketId} step-`);
    const nonPipelineCommits = aheadSubjects.filter((s) => !pipelineSubject.test(s));
    if (nonPipelineCommits.length > 0) {
      throw new CheckpointError(
        `branch ${branch} has ${nonPipelineCommits.length} non-pipeline ` +
          `commit(s) ahead of master — refusing to reset. ` +
          `Inspect with: git log master..${branch}. ` +
          `Either merge those commits to master or delete the branch ` +
          `(git branch -D ${branch}) before retrying this ticket.`,
        { code: 'STALE_BRANCH_HAS_COMMITS' },
      );
    }

    // Pure pipeline step commits (or already at master) — safe to reset.
    git(`checkout ${branch}`, cwd);
    git('reset --hard master', cwd);
    // Clean any untracked files left over from a crashed run.
    git('clean -fd', cwd);
    return { branch, createdFromMaster: false, recoveredFromExisting: true };
  }

  git(`checkout -b ${branch}`, cwd);
  return { branch, createdFromMaster: true, recoveredFromExisting: false };
}

export async function commitStepSnapshot(ticketId, stepName, cwd) {
  // Stage everything under the project root — tracked modifications AND
  // untracked files added by this step.
  git('add -A', cwd);
  const staged = git('diff --cached --name-only', cwd);
  if (!staged) {
    // No-op step — return null so callers know nothing was recorded.
    return null;
  }

  const index = nextStepIndex(ticketId, cwd);
  const subject = `[pipeline] ${ticketId} step-${index}-${stepName}`;
  // Use -m + -m to produce subject + empty body. Heredoc is overkill for
  // a one-line message.
  git(`commit -m "${subject}"`, cwd);
  const sha = git('rev-parse HEAD', cwd);
  const tag = tagName(ticketId, index, stepName);
  git(`tag ${tag}`, cwd);
  return sha;
}

export async function revertToLastSnapshot(ticketId, cwd) {
  const snapshots = await listStepSnapshots(ticketId, cwd);
  const target = snapshots.length > 0
    ? snapshots[snapshots.length - 1].sha
    : git('rev-parse master', cwd);
  git(`reset --hard ${target}`, cwd);
  // Clean any untracked files the failed step may have written.
  git('clean -fd', cwd);
}

export async function deleteBranch(ticketId, cwd) {
  const branch = branchName(ticketId);
  const existed = git(`rev-parse --verify ${branch}`, cwd, { tolerateFailure: true }) !== null;
  if (!existed) return;

  // Delete all step tags for this ticket first (they anchor the commits).
  const tagsOut = git(`tag -l "pipeline/${ticketId}/step-*"`, cwd) || '';
  for (const tag of tagsOut.split('\n').filter(Boolean)) {
    git(`tag -d ${tag}`, cwd);
  }
  git(`branch -D ${branch}`, cwd);
}

// Squash-merge the ticket branch into master. Intended to run at the end
// of a successful ticket, replacing the external graveyard reconciliation
// script. Produces ONE commit on master with a message that keeps the
// ticket-id provenance and lists the step tags for audit.
//
// On conflict or dirty master the merge is aborted and a CheckpointError
// is thrown with code MERGE_CONFLICT or DIRTY_TREE. Master and the ticket
// branch are left untouched so the operator can resolve manually.
//
// opts:
//   title          — human ticket title (appears in commit subject/body)
//   cwd            — project git root
//   masterBranch   — name of the trunk branch (default 'master')
export async function mergeToMaster(ticketId, opts) {
  const { title = '', cwd, masterBranch = 'master', ledgerPaths = [] } = opts || {};
  if (!cwd) throw new CheckpointError('mergeToMaster: cwd is required');

  const branch = branchName(ticketId);
  const branchExists = git(`rev-parse --verify ${branch}`, cwd, { tolerateFailure: true }) !== null;
  if (!branchExists) return null;

  // Move to master before checking dirtiness so we don't flag the ticket
  // branch's own in-progress state as "dirty master".
  git(`checkout ${masterBranch}`, cwd);
  // Absorb any human ledger edits made on master during the run before the
  // dirty-master check fires. Same allow-list as ticket-start auto-commit.
  if (ledgerPaths.length) autoCommitPaths(cwd, ledgerPaths);
  if (isDirty(cwd)) {
    throw new CheckpointError(
      `master has uncommitted changes — refusing to squash-merge ${ticketId}. ` +
        `Commit or stash first (git status).`,
      { code: 'DIRTY_TREE' },
    );
  }

  // If the ticket branch points at the same commit as master, nothing to do.
  const branchSha = git(`rev-parse ${branch}`, cwd);
  const masterSha = git(`rev-parse ${masterBranch}`, cwd);
  if (branchSha === masterSha) return null;

  // Attempt squash merge. `git merge --squash` stages changes but doesn't
  // commit — so we can inspect the result before committing. On conflict,
  // `git merge --squash` exits non-zero and leaves conflict markers in the
  // index; we abort immediately to keep master pristine.
  const mergeResult = git(`merge --squash ${branch}`, cwd, { tolerateFailure: true });
  if (mergeResult === null) {
    // Merge failed — could be conflict. Abort to restore clean state.
    git('merge --abort', cwd, { tolerateFailure: true });
    // Also reset the index in case --abort didn't handle it (shouldn't happen,
    // but merge --squash sometimes leaves unstaged conflicts differently).
    git('reset --hard HEAD', cwd, { tolerateFailure: true });
    throw new CheckpointError(
      `squash-merge of ${branch} into ${masterBranch} conflicted. ` +
        `Ticket branch preserved for manual resolution. ` +
        `Run: git checkout ${branch} && git rebase ${masterBranch} to integrate.`,
      { code: 'MERGE_CONFLICT' },
    );
  }

  const staged = git('diff --cached --name-only', cwd);
  if (!staged) {
    // Squash-merge of a branch whose changes are already in master (e.g.
    // same commits cherry-picked earlier). Nothing to commit.
    return null;
  }

  const snapshots = await listStepSnapshots(ticketId, cwd);
  const stepSummary = snapshots.length > 0
    ? snapshots.map((s) => `  - step-${s.index}-${s.step}`).join('\n')
    : '  (no step snapshots — direct commit)';
  const subject = title
    ? `[${ticketId}] ${title}`
    : `[${ticketId}]`;
  const body = `Pipeline steps committed:\n${stepSummary}`;

  // Use a temp file for the commit message to avoid shell-escaping hazards
  // when the title contains quotes, backticks, or other special chars.
  const msgPath = `/tmp/.pipeline-commit-msg-${ticketId}-${Date.now()}`;
  execSync(`printf %s ${JSON.stringify(`${subject}\n\n${body}\n`)} > ${msgPath}`, { cwd });
  try {
    git(`commit -F ${msgPath}`, cwd);
  } finally {
    execSync(`rm -f ${msgPath}`, { cwd });
  }

  return git('rev-parse HEAD', cwd);
}

export async function listStepSnapshots(ticketId, cwd) {
  const out = git(`tag -l "pipeline/${ticketId}/step-*"`, cwd) || '';
  const tags = out.split('\n').filter(Boolean);
  // Tag name format: pipeline/{ticketId}/step-{index}-{stepName}
  const parsed = tags
    .map((tag) => {
      const m = tag.match(/^pipeline\/[^/]+\/step-(\d+)-(.+)$/);
      if (!m) return null;
      const index = parseInt(m[1], 10);
      const step = m[2];
      const sha = git(`rev-list -1 ${tag}`, cwd);
      return { index, step, tag, sha };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  return parsed;
}
