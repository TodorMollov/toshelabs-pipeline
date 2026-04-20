import { readFile, writeFile, unlink, appendFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { dirname, basename, resolve as pathResolve } from 'path';

// Ensure the target git repo ignores the lock file via .git/info/exclude
// (per-clone local exclude). We do NOT touch the tracked .gitignore —
// the lock is a pipeline concern, not a project concern. Without this,
// Phase 3's ensureBranch sees the lock in `git status --porcelain` and
// refuses to start the ticket with DIRTY_TREE.
//
// Idempotent: if the exclude rule is already present, we no-op. If the
// repo isn't a git repo (no .git), we no-op silently — lock still works
// as a plain file mutex in that case.
async function ensureLockIgnored(lockPath) {
  const repoRoot = dirname(lockPath);
  const lockName = basename(lockPath);
  const excludePath = pathResolve(repoRoot, '.git', 'info', 'exclude');
  const gitDir = pathResolve(repoRoot, '.git');
  if (!existsSync(gitDir)) return;
  // .git may be a file (worktree) rather than a directory; only write when
  // it's a real directory with info/exclude reachable.
  try {
    if (!statSync(gitDir).isDirectory()) return;
  } catch {
    return;
  }
  if (!existsSync(excludePath)) return; // don't create it; git usually does
  const existing = await readFile(excludePath, 'utf-8');
  const lines = existing.split('\n').map((l) => l.trim());
  if (lines.includes(lockName) || lines.includes(`/${lockName}`)) return;
  const prefix = existing.endsWith('\n') ? '' : '\n';
  await appendFile(
    excludePath,
    `${prefix}# toshelabs-pipeline: lock file — ignored so Phase 3 checkpoints don't see DIRTY_TREE\n${lockName}\n`,
  );
}

export async function acquireLock(lockPath, description) {
  await ensureLockIgnored(lockPath);
  if (existsSync(lockPath)) {
    const holder = await readFile(lockPath, 'utf-8');
    return { acquired: false, holder: holder.trim() };
  }
  await writeFile(lockPath, `toshelabs-pipeline: ${description}\n`);
  return { acquired: true, holder: null };
}

export async function releaseLock(lockPath) {
  if (existsSync(lockPath)) {
    await unlink(lockPath);
    return true;
  }
  return false;
}
