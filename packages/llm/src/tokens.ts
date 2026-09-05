import type { ContentPart, LlmMessage } from '@rp/shared';

/** Approximate chars-per-token ratio used by the estimator. */
const CHARS_PER_TOKEN = 4;
/** Rough cost of one inline image. */
const IMAGE_TOKENS = 1000;
/** Fixed per-message overhead (role, framing) in tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Rough token estimate: ~4 characters per token. Never negative; empty text is 0. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function partTokens(part: ContentPart): number {
  if (part.type === 'image') return IMAGE_TOKENS;
  return estimateTokens(partText(part));
}

function partText(part: Exclude<ContentPart, { type: 'image' }>): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'tool_use':
      return `${part.name} ${safeJson(part.input)}`;
    case 'tool_result':
      return part.content;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Estimate tokens of a whole message (tool_use inputs are counted as their JSON text, images as ~1000). */
export function estimateMessageTokens(msg: LlmMessage): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const part of msg.content) total += partTokens(part);
  return total;
}

function toolUseIds(msg: LlmMessage): Set<string> {
  const ids = new Set<string>();
  for (const part of msg.content) if (part.type === 'tool_use') ids.add(part.id);
  return ids;
}

function referencesAny(msg: LlmMessage, ids: Set<string>): boolean {
  return msg.content.some((p) => p.type === 'tool_result' && ids.has(p.toolUseId));
}

/**
 * Group messages into indivisible units: an assistant message containing
 * `tool_use` parts is glued to the following user message(s) that carry the
 * matching `tool_result` parts. Every other message is a unit of its own.
 */
export function groupToolPairs(messages: LlmMessage[]): LlmMessage[][] {
  const groups: LlmMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    const group = [msg];
    i += 1;
    if (msg.role === 'assistant') {
      const ids = toolUseIds(msg);
      if (ids.size > 0) {
        while (i < messages.length) {
          const next = messages[i]!;
          if (next.role !== 'user' || !referencesAny(next, ids)) break;
          group.push(next);
          i += 1;
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Trim the transcript to a token budget by dropping the oldest messages.
 * A `tool_use` message and its `tool_result` reply are never separated, and the
 * last message (with its pair, if any) is always kept even if it alone exceeds
 * the budget.
 */
export function windowMessages(messages: LlmMessage[], budgetTokens: number): LlmMessage[] {
  if (messages.length === 0) return [];
  const groups = groupToolPairs(messages);
  const kept: LlmMessage[][] = [];
  let used = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!;
    const cost = group.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (kept.length > 0 && used + cost > budgetTokens) break;
    kept.push(group);
    used += cost;
  }
  kept.reverse();
  return kept.flat();
}
