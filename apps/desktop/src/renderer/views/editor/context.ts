import { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import type { CapabilityInfo, EditorProject } from '@rp/shared';
import { draftReducer, initialDraft, jsonEqual, type DraftAction, type DraftState } from '../../lib/editor';

/** What a section exposes to the shell: its dirty flag and how to save. */
export interface SectionHandle {
  dirty: boolean;
  save: () => Promise<boolean>;
}

export interface EditorCtx {
  project: EditorProject;
  caps: CapabilityInfo[];
  setProject: (p: EditorProject) => void;
  /** The active section registers itself (null on unmount) so the shell can guard navigation and handle Ctrl+S. */
  register: (handle: SectionHandle | null) => void;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor outside EditorContext');
  return ctx;
}

/** Draft state for a section: dirty tracking on top of the pure reducer, registered with the shell. */
export function useDraft<T>(saved: T, save: (draft: T) => Promise<T | null>, isEqual: (a: T, b: T) => boolean = jsonEqual) {
  const [state, dispatch] = useReducer((s: DraftState<T>, a: DraftAction<T>) => draftReducer(s, a, isEqual), saved, initialDraft);
  const { register } = useEditor();
  const stateRef = useRef(state);
  stateRef.current = state;

  const doSave = useCallback(async (): Promise<boolean> => {
    const result = await save(stateRef.current.draft);
    if (result === null) return false;
    dispatch({ type: 'saved', saved: result });
    return true;
  }, [save]);

  useEffect(() => {
    register({ dirty: state.dirty, save: doSave });
  }, [register, state.dirty, doSave]);
  useEffect(() => () => register(null), [register]);

  return {
    draft: state.draft,
    saved: state.saved,
    dirty: state.dirty,
    generation: state.generation,
    edit: useCallback((patch: Partial<T> | ((d: T) => T)) => dispatch({ type: 'edit', patch }), []),
    reset: useCallback((s: T) => dispatch({ type: 'reset', saved: s }), []),
    external: useCallback((s: T, keep: (draft: T, saved: T) => T) => dispatch({ type: 'external', saved: s, keep }), []),
    save: doSave,
  };
}
