import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Writes `data` to `abs` atomically (temp file in the same directory, then rename). */
export async function writeFileAtomic(abs: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
