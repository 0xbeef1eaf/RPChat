import { useEffect, useRef, useState } from 'react';
import type { ScriptProblem } from '@rp/shared';
import type { CodeEditorInstance, CodeModel, MonacoApi } from '../../lib/monaco';
import { useAppState } from '../../store/store';

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** TypeScript is checked against the character SDK's typings; JSON is checked as JSON. */
  language: 'typescript' | 'json';
  /**
   * Names this box's file for the type checker. Must be unique among the boxes on screen at
   * the same time, and stable while one document is being edited.
   */
  path: string;
  /** Any CSS height; the box itself can be dragged taller from its bottom edge. */
  height?: number | string;
  readOnly?: boolean;
  /** Draw the box as rejected, the way an invalid `textarea.code` used to be. */
  invalid?: boolean;
  ariaLabel: string;
  /** Ctrl/Cmd+Enter, when this box has something to submit. */
  onSubmit?: () => void;
  /** Shown while the box is empty. */
  placeholder?: string;
  /**
   * Problems from a check the host ran (`editor.checkScript`), underlined alongside the
   * ones the editor's own compiler found.
   */
  problems?: readonly ScriptProblem[];
}

/**
 * A box for code: the Monaco editor, with completion, hovers and type errors from the very
 * `sdk.d.ts` the character is given. Monaco and its language services are several megabytes
 * and belong to this component alone, so they are reached through an `import()` and only
 * fetched once a code box is actually on screen (see lib/monaco.ts).
 *
 * If that fails this falls back to the plain textarea these boxes used to be: a broken
 * chunk must not stand between an author and their own script.
 */
export function CodeEditor({ value, onChange, language, path, height = 260, readOnly = false, invalid = false, ariaLabel, onSubmit, placeholder, problems }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorRef = useRef<CodeEditorInstance | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  /** What the callbacks below must read: the editor outlives any one render's closures. */
  const latest = useRef({ value, onChange, onSubmit });
  latest.current = { value, onChange, onSubmit };
  const capabilities = useAppState((s) => s.capabilities);

  useEffect(() => {
    let cancelled = false;
    let editor: CodeEditorInstance | undefined;
    let model: CodeModel | undefined;
    void (async () => {
      try {
        const { loadMonaco, editorOptions } = await import('../../lib/monaco');
        const monaco = await loadMonaco();
        if (cancelled || !host.current) return;
        monacoRef.current = monaco;
        const uri = monaco.Uri.parse(`inmemory://rp/${path}.${language === 'json' ? 'json' : 'ts'}`);
        // A remount (a route left and re-entered, a document switched) can still hold the
        // model this box had last time.
        monaco.editor.getModel(uri)?.dispose();
        model = monaco.editor.createModel(latest.current.value, language, uri);
        editor = monaco.editor.create(host.current, { ...editorOptions(), model, readOnly, placeholder, ariaLabel });
        editorRef.current = editor;
        model.onDidChangeContent(() => {
          const next = model?.getValue() ?? '';
          if (next !== latest.current.value) latest.current.onChange(next);
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => latest.current.onSubmit?.());
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[code-editor] Monaco could not be loaded; falling back to a plain text box', err);
        setStatus('failed');
      }
    })();
    return () => {
      cancelled = true;
      editorRef.current = null;
      monacoRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
    // `readOnly`, `placeholder` and the rest are applied by the effects below rather than by
    // building the editor again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language]);

  // The parent replacing the text (Discard, Insert template, switching document) has to land
  // in the editor; a keystroke that got here through onChange is already in it.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value, status]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, status]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      'rp-check',
      (problems ?? []).map((problem) => {
        const line = Math.min(Math.max(problem.line ?? 1, 1), model.getLineCount());
        return {
          message: problem.message,
          severity: monaco.MarkerSeverity.Error,
          startLineNumber: line,
          // esbuild counts columns from zero, Monaco from one.
          startColumn: (problem.column ?? 0) + 1,
          endLineNumber: line,
          endColumn: model.getLineMaxColumn(line),
        };
      }),
    );
  }, [problems, status]);

  // A plugin can add or drop SDK modules while a box is open; the typings follow.
  const capabilitiesSettled = useRef(false);
  useEffect(() => {
    if (!capabilitiesSettled.current) {
      capabilitiesSettled.current = true;
      return;
    }
    void import('../../lib/monaco').then((m) => m.refreshSdkTypings());
  }, [capabilities]);

  if (status === 'failed') {
    return (
      <textarea
        className={`code${invalid ? ' invalid' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        aria-label={ariaLabel}
        placeholder={placeholder}
        style={{ height }}
      />
    );
  }

  return (
    <div className={`code-editor${invalid ? ' invalid' : ''}`} style={{ height }} aria-busy={status === 'loading'}>
      <div className="code-editor-host" ref={host} />
      {status === 'loading' ? <div className="code-editor-loading muted small">Loading editor…</div> : null}
    </div>
  );
}
