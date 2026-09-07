/** Registry of open editor projects: `<userData>/data/editor-projects.json` → `[{ key, dir }]`. */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectEntry {
  key: string;
  dir: string;
}

export const EDITOR_KEY_PREFIX = 'editor-';
const KEY = /^[a-f0-9]{12}$/;

/** sha1 of the resolved directory, first 12 hex chars. */
export function projectKey(dir: string): string {
  return createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

export function isProjectKey(v: unknown): v is string {
  return typeof v === 'string' && KEY.test(v);
}

/** `rp-asset://editor-<key>/<path>` host → key, or undefined for ordinary pack ids. */
export function keyFromAssetHost(host: string): string | undefined {
  if (!host.startsWith(EDITOR_KEY_PREFIX)) return undefined;
  const key = host.slice(EDITOR_KEY_PREFIX.length);
  return KEY.test(key) ? key : undefined;
}

export function editorAssetHost(key: string): string {
  return `${EDITOR_KEY_PREFIX}${key}`;
}

export class ProjectRegistry {
  private entries: ProjectEntry[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      const list = Array.isArray(raw) ? raw : Array.isArray((raw as { projects?: unknown })?.projects) ? (raw as { projects: unknown[] }).projects : [];
      this.entries = list
        .filter((e): e is { dir: string } => Boolean(e) && typeof (e as { dir?: unknown }).dir === 'string')
        .map((e) => ({ key: projectKey(e.dir), dir: path.resolve(e.dir) }));
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ projects: this.entries }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list(): ProjectEntry[] {
    this.load();
    return [...this.entries];
  }

  get(key: string): ProjectEntry | undefined {
    this.load();
    return this.entries.find((e) => e.key === key);
  }

  byDir(dir: string): ProjectEntry | undefined {
    this.load();
    const resolved = path.resolve(dir);
    return this.entries.find((e) => e.dir === resolved);
  }

  /** Register a directory (idempotent); returns its entry. */
  add(dir: string): ProjectEntry {
    this.load();
    const existing = this.byDir(dir);
    if (existing) return existing;
    const entry: ProjectEntry = { key: projectKey(dir), dir: path.resolve(dir) };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  remove(key: string): boolean {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.key !== key);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }
}
