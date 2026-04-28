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
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
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
  // Symmetric: if either side fails to resolve, both sides use the
  // raw fallback. Asymmetric normalization produced false negatives
  // when one path existed and the other did not.
  const strip = (p) => p.replace(/\r$/, '').replace(/\/+$/, '');
  let na;
  let nb;
  try {
    na = realpathSync(a);
    nb = realpathSync(b);
  } catch {
    return strip(a) === strip(b);
  }
  return strip(na) === strip(nb);
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
// `git clean -fd` removes untracked-but-not-gitignored files only —
// gitignored build caches (node_modules, .dart_tool, target/) survive
// across tickets. A per-ticket `flutter pub get` or `npm install` is
// expensive enough that we deliberately keep them. Stale caches that
// matter (lockfile mismatches) are caught by the manifest-changed
// dependency-sync hook in pipeline.js.
export function prepareWorktreeForTicket(worktreeDir, defaultBranch) {
  if (!defaultBranch) throw new WorktreeError('defaultBranch is required', { code: 'BAD_ARG' });
  git(['reset', '--hard', defaultBranch], worktreeDir);
  git(['clean', '-fd'], worktreeDir);
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
  if (!defaultBranch) throw new WorktreeError('defaultBranch is required', { code: 'BAD_ARG' });
  if (!sha) throw new WorktreeError('sha is required', { code: 'BAD_ARG' });
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
    // -- separator guards against a sha that begins with `-` being
    // parsed as a flag.
    execFileSync('git', ['cherry-pick', '--', sha], {
      cwd: masterDir,
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    const headSha = git(['rev-parse', 'HEAD'], masterDir);
    return { ok: true, headSha };
  } catch (err) {
    cherryErr = err;
  }
  // Capture conflict files *before* abort; after abort the unmerged
  // markers are gone. CHERRY_PICK_HEAD presence tells us cherry-pick
  // got far enough to start applying the patch:
  //   - missing → pre-flight failure (bad sha, repo lock, etc.) →
  //     PREFLIGHT_FAILED. Reporting CONFLICT here would be a lie.
  //   - present + no unmerged paths + clean index → EMPTY (already
  //     applied; default cherry.empty=stop holds the cherry-pick state)
  //   - present + unmerged paths → real CONFLICT
  const cherryHead = git(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], masterDir, { tolerateFailure: true });
  const stderr = (cherryErr.stderr?.toString?.() ?? '').trim().slice(0, 500);
  if (!cherryHead) {
    return { ok: false, code: 'PREFLIGHT_FAILED', message: stderr };
  }
  const conflictFiles = (git(['diff', '--name-only', '--diff-filter=U'], masterDir, { tolerateFailure: true }) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const statusV2 = git(['status', '--porcelain=v2'], masterDir, { tolerateFailure: true }) || '';
  const isEmpty = conflictFiles.length === 0 && statusV2.length === 0;
  // Always try to abort so the tree never lingers in a half-merged
  // state. ROLLBACK_FAILED if the abort itself fails — distinct from a
  // normal conflict.
  const abortRes = git(['cherry-pick', '--abort'], masterDir, { tolerateFailure: true });
  if (abortRes === null) {
    return { ok: false, code: 'ROLLBACK_FAILED', message: stderr };
  }
  if (isEmpty) {
    return { ok: false, code: 'EMPTY', message: stderr };
  }
  return {
    ok: false,
    code: 'CONFLICT',
    files: conflictFiles,
    message: stderr,
  };
}
