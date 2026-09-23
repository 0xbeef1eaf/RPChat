/**
 * Serialises asynchronous work per key: two tasks queued under the same key
 * never overlap, tasks under different keys run side by side.
 *
 * This is the shape the engine reaches for wherever something must happen in
 * order without holding up everything else — a session's turns, a
 * subscription's event handlers, a repeating timer's runs, the writes to one
 * storage file. A tail is kept only while something is queued on it, so
 * `has`/`keys`/`idle` describe exactly what is still in flight.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Queue `task` behind whatever is already running for `key`. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.tails.set(key, next);
    next
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  /** Whether anything is running or queued for `key`. */
  has(key: string): boolean {
    return this.tails.has(key);
  }

  /** The keys with work in flight. */
  keys(): string[] {
    return [...this.tails.keys()];
  }

  /** How many keys have work in flight. */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Wait for everything queued on `key` — or, with no key, on every key.
   * Resolves even when a task rejects: the caller wants quiet, not the result.
   */
  async idle(key?: string): Promise<void> {
    const pending = key === undefined ? [...this.tails.values()] : [this.tails.get(key)];
    await Promise.all(pending.map((p) => p?.catch(() => undefined)));
  }
}
