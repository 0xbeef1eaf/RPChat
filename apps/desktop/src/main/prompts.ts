/**
 * Pending questions to the user (permission prompts, `ui.confirm`/`ui.choose`):
 * each is delivered to a window and resolved by its `respond` IPC call.
 * Everything pending is answered with the fallback when its window goes away.
 */
export interface PendingPromptsOptions<A> {
  /** Answer used when the request cannot be delivered or the window goes away. */
  fallback: A;
  /** Safety net so an unanswered prompt never leaks (default 10 minutes). */
  timeoutMs?: number;
  /**
   * Called with the id once a prompt is resolved, however it was resolved (answered, timed out,
   * rejected). Used to close the window the question was asked in.
   */
  onSettled?: (id: string) => void;
}

interface Entry<A> {
  resolve(answer: A): void;
  timer: NodeJS.Timeout;
}

export class PendingPrompts<A> {
  private readonly pending = new Map<string, Entry<A>>();
  private readonly fallback: A;
  private readonly timeoutMs: number;
  private readonly onSettled: ((id: string) => void) | undefined;

  constructor(opts: PendingPromptsOptions<A>) {
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.onSettled = opts.onSettled;
  }

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** Register `id`, run `deliver` (which sends it to the UI); resolves with the user's answer or the fallback. */
  ask(id: string, deliver: () => boolean): Promise<A> {
    return new Promise<A>((resolve) => {
      const timer = setTimeout(() => this.respond(id, this.fallback), this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      let delivered = false;
      try {
        delivered = deliver();
      } catch {
        delivered = false;
      }
      if (!delivered) this.respond(id, this.fallback);
    });
  }

  /** Resolve a pending prompt. Returns false when the id is unknown (already answered). */
  respond(id: string, answer: A): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(answer);
    this.onSettled?.(id);
    return true;
  }

  /**
   * Answer pending prompts with the fallback (window closed, app quitting). With `filter`, only
   * the ids it accepts: closing the main window must not answer questions that are being asked
   * in windows of their own.
   */
  rejectAll(filter?: (id: string) => boolean): void {
    for (const id of [...this.pending.keys()]) {
      if (!filter || filter(id)) this.respond(id, this.fallback);
    }
  }
}
