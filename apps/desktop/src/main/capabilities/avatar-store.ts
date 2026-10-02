/** The avatars that were on screen when the app last closed: `<userData>/data/avatars.json`. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AvatarRecord, AvatarStore } from './avatar.js';
import { parseAvatarRecords } from './avatar.js';

export const AVATAR_STATE_FILENAME = 'avatars.json';

export class AvatarFileStore implements AvatarStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** No file (the usual case on a first run) or one that is no longer JSON: nothing to put back. */
  async load(): Promise<AvatarRecord[]> {
    try {
      return parseAvatarRecords(JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown);
    } catch {
      return [];
    }
  }

  /** Serialised and atomic: an avatar moving while the last write is in flight cannot leave half a file. */
  save(records: AvatarRecord[]): Promise<void> {
    const run = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify({ avatars: records }, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.file);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
