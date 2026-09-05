export type Unsubscribe = () => void;

type Listener<T> = (payload: T) => void;

/**
 * Minimal typed event emitter. Listener errors are caught and reported through
 * `onListenerError` (default: swallowed) so one bad subscriber cannot break a turn.
 */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();
  onListenerError: ((event: keyof Events, error: unknown) => void) | undefined;

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        this.onListenerError?.(event, err);
      }
    }
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
