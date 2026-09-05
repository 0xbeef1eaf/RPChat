import type { ActionContext, CapabilityHandler, Json, MemoryEntry } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
import type { MemoryService } from '../services/memory.js';

export const MEMORY_LIST_DEFAULT = 10;
export const MEMORY_LIST_MAX = 50;

/** The `MemoryEntry` shape declared in the SDK preamble (internal bookkeeping fields stripped). */
export function toSdkMemory(entry: MemoryEntry): Json {
  return {
    id: entry.id,
    text: entry.text,
    tags: entry.tags,
    importance: entry.importance,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function limitArg(value: unknown): number {
  if (value === undefined || value === null) return MEMORY_LIST_DEFAULT;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new RpError('INVALID_ARGUMENT', 'limit must be a positive number');
  }
  return Math.min(Math.floor(value), MEMORY_LIST_MAX);
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new RpError('INVALID_ARGUMENT', 'id must be a non-empty string');
  return value;
}

/** `sdk.memory`: remember / recall / recent / update / forget, scoped to the acting character. */
export class MemoryHandler implements CapabilityHandler {
  readonly moduleId = 'memory';

  constructor(private readonly memories: MemoryService) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const ref = characterRef(context.packId, context.characterId);
    switch (method) {
      case 'remember': {
        const options = this.optionsArg(args[1]);
        const entry = await this.memories.add(ref, args[0] as string, { ...options, source: 'character', sessionId: context.sessionId });
        return toSdkMemory(entry);
      }
      case 'recall': {
        if (typeof args[0] !== 'string' || args[0].trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'query must be a non-empty string');
        const hits = await this.memories.search(ref, args[0], limitArg(args[1]));
        return hits.map(toSdkMemory);
      }
      case 'recent':
        return (await this.memories.recent(ref, limitArg(args[0]))).map(toSdkMemory);
      case 'update': {
        const id = requireId(args[0]);
        await this.own(ref, id);
        const patch = this.optionsArg(args[1]);
        const textPatch = args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) ? (args[1] as Record<string, Json>).text : undefined;
        const update: Parameters<MemoryService['update']>[0] = { id };
        if (textPatch !== undefined && textPatch !== null) update.text = textPatch as string;
        if (patch.tags !== undefined) update.tags = patch.tags;
        if (patch.importance !== undefined) update.importance = patch.importance as MemoryEntry['importance'];
        return toSdkMemory(await this.memories.update(update));
      }
      case 'forget': {
        const id = requireId(args[0]);
        const entry = await this.memories.get(id);
        if (!entry || entry.characterRef !== ref) return false;
        return this.memories.remove(id);
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.memory.${method}`);
    }
  }

  private async own(ref: string, id: string): Promise<MemoryEntry> {
    const entry = await this.memories.get(id);
    if (!entry || entry.characterRef !== ref) throw new RpError('NOT_FOUND', `Memory "${id}" does not exist`, { id });
    return entry;
  }

  private optionsArg(value: unknown): { tags?: string[]; importance?: number } {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new RpError('INVALID_ARGUMENT', 'options must be an object');
    const { tags, importance } = value as { tags?: unknown; importance?: unknown };
    const out: { tags?: string[]; importance?: number } = {};
    if (tags !== undefined && tags !== null) {
      if (!Array.isArray(tags)) throw new RpError('INVALID_ARGUMENT', 'tags must be an array of strings');
      out.tags = tags as string[];
    }
    if (importance !== undefined && importance !== null) {
      if (typeof importance !== 'number') throw new RpError('INVALID_ARGUMENT', 'importance must be a number 1..5');
      out.importance = importance;
    }
    return out;
  }
}
