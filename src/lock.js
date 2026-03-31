import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

export async function acquireLock(lockPath, description) {
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
