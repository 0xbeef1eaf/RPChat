/** `sdk.files`: a per-character home directory under userData, with the same path guard as pack assets. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
import { normalizeRelativePath, resolveAssetPath } from '@rp/pack';

export const FILES_MAX_BYTES = 5 * 1024 * 1024;
export const FILES_MAX_COUNT = 200;
export const FILES_READ_DEFAULT = 64 * 1024;

export function characterHomeDir(userData: string, ref: string): string {
  return path.join(userData, 'characters', encodeURIComponent(ref), 'home');
}

/** Validate a character-relative path and resolve it inside `home`. Throws PATH_ESCAPE / INVALID_ARGUMENT. */
export function resolveHomePath(home: string, input: unknown): { relative: string; absolute: string } {
  if (typeof input !== 'string' || input.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'path must be a non-empty string');
  const n = normalizeRelativePath(input.trim());
  if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe path "${input}": ${n.reason}`, { path: input });
  return { relative: n.path, absolute: resolveAssetPath(home, n.path) };
}

export interface FilesHandlerDeps {
  userData: string;
  openPath?: (absolute: string) => Promise<string>;
}

export class FilesHandler implements CapabilityHandler {
  readonly moduleId = 'files';

  constructor(private readonly deps: FilesHandlerDeps) {}

  homeFor(context: ActionContext): string {
    return characterHomeDir(this.deps.userData, characterRef(context.packId, context.characterId));
  }

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const home = this.homeFor(context);
    switch (method) {
      case 'homePath':
        return home;
      case 'write':
        await this.write(home, args[0], args[1], false);
        return;
      case 'append':
        await this.write(home, args[0], args[1], true);
        return;
      case 'read':
        return this.read(home, args[0], args[1]);
      case 'list':
        return (await this.list(home, args[0])) as unknown as Json;
      case 'delete': {
        const { absolute } = resolveHomePath(home, args[0]);
        try {
          await fs.rm(absolute, { force: false });
          return true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw new RpError('CAPABILITY_FAILED', `Cannot delete: ${(err as Error).message}`);
        }
      }
      case 'open': {
        const { absolute } = resolveHomePath(home, args[0]);
        await fs.access(absolute).catch(() => {
          throw new RpError('NOT_FOUND', `${String(args[0])} does not exist`);
        });
        const error = await (this.deps.openPath ?? (async () => 'no opener'))(absolute);
        if (error) throw new RpError('CAPABILITY_FAILED', error);
        return;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.files.${method}`);
    }
  }

  private async write(home: string, pathArg: unknown, textArg: unknown, append: boolean): Promise<void> {
    if (typeof textArg !== 'string') throw new RpError('INVALID_ARGUMENT', 'text must be a string');
    const { absolute } = resolveHomePath(home, pathArg);
    const incoming = Buffer.byteLength(textArg, 'utf8');
    let existing = 0;
    let isNew = true;
    try {
      const st = await fs.stat(absolute);
      if (!st.isFile()) throw new RpError('INVALID_ARGUMENT', 'path is a directory');
      existing = st.size;
      isNew = false;
    } catch (err) {
      if (err instanceof RpError) throw err;
    }
    const total = append ? existing + incoming : incoming;
    if (total > FILES_MAX_BYTES) throw new RpError('INVALID_ARGUMENT', `File would exceed ${FILES_MAX_BYTES} bytes`);
    if (isNew && (await this.count(home)) >= FILES_MAX_COUNT) throw new RpError('INVALID_ARGUMENT', `At most ${FILES_MAX_COUNT} files per character`);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    if (append) await fs.appendFile(absolute, textArg, 'utf8');
    else await fs.writeFile(absolute, textArg, 'utf8');
  }

  private async read(home: string, pathArg: unknown, maxArg: unknown): Promise<string> {
    const { absolute } = resolveHomePath(home, pathArg);
    const max = typeof maxArg === 'number' && maxArg > 0 ? Math.min(FILES_MAX_BYTES, Math.round(maxArg)) : FILES_READ_DEFAULT;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(absolute, 'r');
    } catch {
      throw new RpError('NOT_FOUND', `${String(pathArg)} does not exist`);
    }
    try {
      const st = await handle.stat();
      const buf = Buffer.alloc(Math.min(max, st.size));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async list(home: string, prefixArg: unknown): Promise<Array<{ path: string; bytes: number; modifiedAt: string }>> {
    let prefix = '';
    if (typeof prefixArg === 'string' && prefixArg.trim().length > 0) {
      const n = normalizeRelativePath(prefixArg.trim());
      if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe prefix "${prefixArg}": ${n.reason}`);
      prefix = n.path;
    }
    const out: Array<{ path: string; bytes: number; modifiedAt: string }> = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), relPath);
        else if (e.isFile()) {
          if (prefix && !relPath.startsWith(prefix)) continue;
          const st = await fs.stat(path.join(dir, e.name));
          out.push({ path: relPath, bytes: st.size, modifiedAt: st.mtime.toISOString() });
        }
      }
    };
    await walk(home, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async count(home: string): Promise<number> {
    return (await this.list(home, undefined)).length;
  }
}
