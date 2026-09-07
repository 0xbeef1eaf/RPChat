/** Enabled/disabled state per installed plugin: `<userData>/data/plugins.json` → `{ [id]: { enabled } }`. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PluginRecord {
  enabled: boolean;
}

export class PluginRegistry {
  private records: Record<string, PluginRecord> = {};
  private loaded = false;

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, rec] of Object.entries(raw as Record<string, unknown>)) {
          if (rec && typeof rec === 'object') this.records[id] = { enabled: (rec as { enabled?: unknown }).enabled !== false };
        }
      }
    } catch {
      this.records = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.records, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Enabled unless explicitly disabled (fresh installs default to enabled). */
  isEnabled(id: string): boolean {
    this.load();
    return this.records[id]?.enabled !== false;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.load();
    this.records[id] = { enabled };
    this.save();
  }

  remove(id: string): void {
    this.load();
    if (!(id in this.records)) return;
    delete this.records[id];
    this.save();
  }

  ids(): string[] {
    this.load();
    return Object.keys(this.records);
  }
}
