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
    // Reset the stale branch back to master's tip so the ticket starts clean.
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
