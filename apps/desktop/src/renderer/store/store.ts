import { useSyncExternalStore } from 'react';
import { initialState, type AppState } from './state';

export type Listener = () => void;

export interface Store<S> {
  getState(): S;
  setState(update: S | ((prev: S) => S)): void;
  subscribe(listener: Listener): () => void;
}

/** Minimal external store: immutable state, synchronous updates, subscriber notifications. */
export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    setState(update) {
      const next = typeof update === 'function' ? (update as (prev: S) => S)(state) : update;
      if (Object.is(next, state)) return;
      state = next;
      for (const l of Array.from(listeners)) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const appStore: Store<AppState> = createStore(initialState());

/**
 * Subscribe a component to a slice of the app state. The selector must return
 * a referentially stable value for unchanged state (pick from the state
 * object; derive arrays/objects with `useMemo` in the component instead).
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(appStore.subscribe, () => selector(appStore.getState()), () => selector(appStore.getState()));
}

/** Convenience for reducers: `update(s => reducer(s, ...))`. */
export function update(fn: (prev: AppState) => AppState): void {
  appStore.setState(fn);
}
