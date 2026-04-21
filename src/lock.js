import { readFile, writeFile, unlink, appendFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { dirname, basename, resolve as pathResolve } from 'path';

// A crashed pipeline leaves code.lock behind. The next start can't tell
// if the holder is alive without checking: our PID marker plus an age
// ceiling. We write `pid=<N>` into the lock alongside the description;
// acquireLock treats a lock as stale when EITHER the PID is not alive
// OR the file is older than STALE_LOCK_MAX_AGE_MS (belt + braces in
// case the pid field is missing from an older lock format).
const STALE_LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    // Signal 0 probes process existence without affecting it. ESRCH means
    // the PID doesn't exist → dead. EPERM means the PID exists but we
    // can't signal it (e.g. init, or a process owned by another user) →
    // treat as alive so we don't steal locks held by real processes.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function parsePidFromLockBody(body) {
  const m = /\bpid=(\d+)\b/.exec(body || '');
  return m ? Number(m[1]) : null;
}

function isLockStale(lockPath, body) {
  const pid = parsePidFromLockBody(body);
  if (pid !== null) return !isPidAlive(pid);
  // Legacy lock without a pid marker — fall back to age.
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    return ageMs > STALE_LOCK_MAX_AGE_MS;
  } catch {
    return false;
  }
}

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
    // If the holder's PID is dead (or the lock is legacy-format and
    // older than the staleness ceiling), steal it rather than reporting
    // false "already held". This unblocks the next run after a SIGKILL.
    if (isLockStale(lockPath, holder)) {
      try {
        await unlink(lockPath);
      } catch { /* race with another acquirer — fall through */ }
    } else {
      return { acquired: false, holder: holder.trim() };
    }
  }
  await writeFile(lockPath, `toshelabs-pipeline: ${description} pid=${process.pid}\n`);
  return { acquired: true, holder: null };
}

export async function releaseLock(lockPath) {
  if (existsSync(lockPath)) {
    await unlink(lockPath);
    return true;
  }
  return false;
}
