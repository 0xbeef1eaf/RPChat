/** `file-added` events from watched directories (debounced; dotfiles and partial downloads ignored). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostEvent } from '@rp/shared';
import { expandHome } from '../commands.js';

const PARTIAL = /\.(part|crdownload|tmp|download|partial)$/i;

export function shouldIgnoreFile(name: string): boolean {
  return name.length === 0 || name.startsWith('.') || name.endsWith('~') || PARTIAL.test(name);
}

export interface DirWatcherOptions {
  emit(event: HostEvent): void;
  logger: Pick<Console, 'warn' | 'debug'>;
  debounceMs?: number;
  now?: () => Date;
}

export class DirWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly known = new Map<string, Set<string>>();

  constructor(private readonly o: DirWatcherOptions) {}

  get dirs(): string[] {
    return [...this.watchers.keys()];
  }

  /** Replace the watched set. */
  setDirs(dirs: string[]): void {
    const wanted = new Set(dirs.map((d) => path.resolve(expandHome(d))).filter((d) => d.length > 0));
    for (const dir of [...this.watchers.keys()]) if (!wanted.has(dir)) this.stop(dir);
    for (const dir of wanted) if (!this.watchers.has(dir)) this.start(dir);
  }

  private start(dir: string): void {
    try {
      const names = new Set(fs.readdirSync(dir));
      this.known.set(dir, names);
      const watcher = fs.watch(dir, { persistent: false }, (_type, filename) => {
        if (typeof filename !== 'string' || shouldIgnoreFile(filename)) return;
        this.schedule(dir, filename);
      });
      watcher.on('error', (err) => this.o.logger.warn(`[senses] watcher for ${dir} failed`, err));
      this.watchers.set(dir, watcher);
    } catch (err) {
      this.o.logger.warn(`[senses] cannot watch ${dir}`, err);
    }
  }

  private stop(dir: string): void {
    this.watchers.get(dir)?.close();
    this.watchers.delete(dir);
    this.known.delete(dir);
  }

  private schedule(dir: string, name: string): void {
    const key = path.join(dir, name);
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.check(dir, name);
    }, this.o.debounceMs ?? 750);
    timer.unref?.();
    this.pending.set(key, timer);
  }

  private check(dir: string, name: string): void {
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      this.known.get(dir)?.delete(name);
      return; // removed again (rename of a partial download, temp file)
    }
    if (!stat.isFile()) return;
    const known = this.known.get(dir);
    if (known?.has(name)) return;
    known?.add(name);
    this.o.emit({ name: 'file-added', data: { path: file, dir, name }, at: (this.o.now ?? (() => new Date()))().toISOString() });
  }

  dispose(): void {
    for (const dir of [...this.watchers.keys()]) this.stop(dir);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
