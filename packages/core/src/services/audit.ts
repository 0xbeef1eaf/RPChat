import { randomUUID } from 'node:crypto';
import type { AuditEntry, Storage } from '@rp/shared';
import type { Clock, Logger } from '../types.js';

/** Append-only action log. Never throws: a storage failure is logged and swallowed so a turn is not lost. */
export class AuditService {
  constructor(
    private readonly storage: Storage,
    private readonly now: Clock,
    private readonly logger: Logger,
  ) {}

  async record(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<AuditEntry> {
    const full: AuditEntry = { id: randomUUID(), at: this.now().toISOString(), ...entry };
    try {
      await this.storage.audit.append(full);
    } catch (err) {
      this.logger.error('[audit] failed to append entry', err);
    }
    return full;
  }

  list(options?: { sessionId?: string; limit?: number }): Promise<AuditEntry[]> {
    return this.storage.audit.list(options);
  }
}
