import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorLibraryFile, LibraryProblem, ScriptProblem } from '@rp/shared';
import { api } from '../../api';
import { CodeEditor } from '../../components/common/CodeEditor';
import { ConfirmDialog } from '../../components/common/Modal';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { SaveBar } from './SaveBar';

/** How long the author has to stop typing before the file is checked again. */
const CHECK_DEBOUNCE_MS = 400;

interface FileDraft {
  /** Path (relative to `lib/`) of the file this draft came from; null for a file that is not saved yet. */
  previousPath: string | null;
  /** Relative to `lib/`, e.g. `cheer.ts` or `games/simon.ts`. */
  path: string;
  source: string;
}

function toDraft(f: EditorLibraryFile): FileDraft {
  return { previousPath: f.path, path: f.path, source: f.source };
}

function fresh(template: string): FileDraft {
  return { previousPath: null, path: '', source: template };
}

/** Why `path` cannot name a library file, as the pack's `normalizeLibraryPath` will see it; undefined when it can. */
function pathProblem(path: string): string | undefined {
  if (path.length === 0) return 'Give the file a path, e.g. cheer.ts or games/simon.ts.';
  if (path.startsWith('/') || path.includes('\\')) return 'A path inside lib/, with forward slashes.';
  const segments = path.split('/');
  if (segments.some((s) => s.length === 0)) return 'No empty folder names.';
  if (segments.some((s) => s === '..')) return 'The file must stay inside lib/.';
  if (segments.some((s) => s.startsWith('.'))) return 'No folder or file name may start with ".".';
  if (!path.endsWith('.ts') || path.endsWith('.d.ts')) return 'A library file ends in .ts (and is not a .d.ts).';
  return undefined;
}

/** `Line 3, column 7: ` for a problem with a position, nothing otherwise. */
function where(p: { line?: number; column?: number }): string {
  return p.line !== undefined ? `Line ${p.line}${p.column !== undefined ? `, column ${p.column}` : ''}: ` : '';
}

/**
 * The character's function library: the `lib/` folder, a small TypeScript project
 * (docs/spec/pack.md "Function library"). Every `.ts` file in it is a module; what the files
 * export is `lib.<name>(...)`, and what the library looks like to the character is read back
 * from the saved folder, so the export list and the problems here are the loader's own.
 */
export function ScriptsSection() {
  const { project, setProject } = useEditor();
  const character = project.characters[0];
  const library = useMemo(() => character?.library ?? { files: [], functions: [], problems: [] }, [character]);
  const files = library.files;
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const [template, setTemplate] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null | undefined>(undefined);
  const [problems, setProblems] = useState<ScriptProblem[]>([]);
  const checkTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api()
      .editor.libraryFileTemplate()
      .then(setTemplate)
      .catch((err) => console.error('libraryFileTemplate failed', err));
  }, []);

  const key = project.summary.key;
  const dir = character?.dir;

  const save = useCallback(
    async (draft: FileDraft) => {
      if (!dir) return null;
      const path = draft.path.trim();
      try {
        const input: Parameters<ReturnType<typeof api>['editor']['saveLibraryFile']>[1] = { dir, path, source: draft.source };
        if (draft.previousPath) input.previousPath = draft.previousPath;
        const p = await api().editor.saveLibraryFile(key, input);
        setProject(p);
        const saved = p.characters[0]?.library.files.find((f) => f.path === path);
        toast('success', `lib/${path} saved`);
        setSelected(path);
        return saved ? toDraft(saved) : { ...draft, previousPath: path, path };
      } catch (err) {
        reportError('Could not save library file', err);
        return null;
      }
    },
    [key, dir, setProject],
  );

  const current = files.find((f) => f.path === selected);
  const d = useDraft<FileDraft>(current ? toDraft(current) : fresh(template), save);
  const { draft, edit, reset, dirty } = d;

  /** Parse the file on its own as a module, a moment after the author stops typing. */
  const check = useCallback((source: string) => {
    if (source.trim().length === 0) {
      setProblems([]);
      return;
    }
    api()
      .editor.checkScript(source, 'module')
      .then(setProblems)
      .catch(() => undefined); // the check is a convenience; never let it interrupt editing
  }, []);
  useEffect(() => {
    check(draft.source);
    return () => {
      if (checkTimer.current !== undefined) window.clearTimeout(checkTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // The template arrives after mount: a "new file" draft opened before that starts from it.
  useEffect(() => {
    if (template && selected === null && !dirty && draft.source.length === 0) reset(fresh(template));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  const setSource = (source: string) => {
    edit({ source });
    if (checkTimer.current !== undefined) window.clearTimeout(checkTimer.current);
    checkTimer.current = window.setTimeout(() => check(source), CHECK_DEBOUNCE_MS);
  };

  const select = (path: string | null) => {
    if (path === selected && (path !== null || draft.previousPath === null)) return;
    if (dirty) {
      setPendingSelect(path);
      return;
    }
    applySelect(path);
  };
  const applySelect = (path: string | null) => {
    setSelected(path);
    const next = path === null ? undefined : files.find((f) => f.path === path);
    reset(next ? toDraft(next) : fresh(template));
  };

  const remove = async (path: string) => {
    setRemoving(null);
    if (!dir) return;
    try {
      const p = await api().editor.removeLibraryFile(key, dir, path);
      setProject(p);
      toast('info', `lib/${path} removed`);
      const remaining = p.characters[0]?.library.files ?? [];
      const next = remaining[0] ?? null;
      setSelected(next?.path ?? null);
      reset(next ? toDraft(next) : fresh(template));
    } catch (err) {
      reportError('Could not remove library file', err);
    }
  };

  if (!character || !dir) {
    return (
      <div>
        <div className="section-head">
          <h1>Scripts</h1>
        </div>
        <p className="muted">The pack's character could not be read; fix the problems under Check &amp; publish first.</p>
      </div>
    );
  }

  // The loader reports problems against pack-relative files; one that names no file of the list
  // (the folder itself, an import that leads nowhere) belongs to the whole library.
  const problemsOf = (file: string): LibraryProblem[] => library.problems.filter((p) => p.file === file);
  const unplaced = library.problems.filter((p) => !files.some((f) => f.file === p.file));
  const fileProblems = current ? problemsOf(current.file) : [];
  const exportsOf = (file: string) => library.functions.filter((f) => f.file === file).map((f) => f.name);
  // What the saved library reports for this file only matches the box until the author edits it.
  const markers = dirty ? problems : [...problems, ...fileProblems];

  const path = draft.path.trim();
  const pathIssue = pathProblem(path) ?? (files.some((f) => f.path === path && f.path !== draft.previousPath) ? 'Another file has this path.' : undefined);
  const bytes = new TextEncoder().encode(draft.source).length;
  const canSave = pathIssue === undefined && draft.source.trim().length > 0;

  return (
    <div>
      <div className="section-head">
        <h1>Scripts</h1>
        <span className="muted small">
          {files.length} file{files.length === 1 ? '' : 's'} · {library.functions.length} function{library.functions.length === 1 ? '' : 's'} · <code className="mono">{dir}/lib/</code>
        </span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => select(null)}>
          New file
        </button>
      </div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        The <code>lib/</code> folder is {character.definition.name || character.definition.id}'s <code>lib</code> library, a small TypeScript project. Every{' '}
        <code>.ts</code> file in it is a module: each function it <code>export</code>s is callable as <code>lib.&lt;name&gt;(...)</code> in every action, timer handler
        and event handler, and whatever it does not export stays private to the file. The summary of an export's JSDoc comment (<code>/** … */</code>) is its line
        in the character's prompt; an <code>@internal</code> tag keeps it as plumbing for your other functions and hooks, out of sight of the character. Files
        import each other by relative path (<code>import {'{ roll }'} from './dice'</code>); <code>sdk</code> and <code>lib</code> are globals, not imports.
      </p>
      <div className="scripts-layout">
        <nav className="scripts-list" aria-label="Library files">
          {files.length === 0 ? <p className="muted small">No files yet.</p> : null}
          {files.map((f) => {
            const names = exportsOf(f.file);
            const broken = problemsOf(f.file).length > 0;
            return (
              <button key={f.path} type="button" className="nav-item" aria-current={f.path === selected ? 'page' : undefined} onClick={() => select(f.path)} title={f.file}>
                <span className="item-text">
                  <span className="item-title mono">{f.path}</span>
                  {names.length > 0 ? <span className="item-sub">{names.join(', ')}</span> : null}
                </span>
                {broken ? <span className="badge badge-danger">problem</span> : null}
              </button>
            );
          })}
          {selected === null ? (
            <button type="button" className="nav-item" aria-current="page">
              <span className="item-text">
                <span className="item-title mono">{path || 'new file'}</span>
                <span className="item-sub">not saved yet</span>
              </span>
            </button>
          ) : null}
        </nav>
        <div className="scripts-editor">
          <div className="field">
            <label htmlFor="sc-path">Path</label>
            <input id="sc-path" type="text" className="mono" value={draft.path} spellCheck={false} placeholder="cheer.ts" onChange={(e) => edit({ path: e.target.value })} />
            {pathIssue ? (
              <span className="field-hint msg-error">{pathIssue}</span>
            ) : (
              <span className="field-hint">
                Saved as <code>{dir}/lib/{path}</code>; sub-folders are created as needed. Change it to rename the file.
              </span>
            )}
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <div className="row">
              <span className="field-label grow">Source</span>
              <span className="muted small">{bytes} bytes</span>
              <button type="button" className="btn btn-sm" onClick={() => setSource(draft.source.trim() ? `${draft.source.trimEnd()}\n\n${template}` : template)} disabled={!template}>
                Insert template
              </button>
            </div>
            <CodeEditor
              language="typescript"
              path={`lib/${draft.previousPath ?? 'new'}`}
              value={draft.source}
              onChange={setSource}
              invalid={markers.length > 0}
              problems={markers.length > 0 ? markers : undefined}
              height={360}
              ariaLabel="Library file source"
            />
            {problems.map((p, i) => (
              <div key={`check-${i}`} className="script-problem">
                <strong>{where(p)}</strong>
                {p.message}
                {p.lineText ? <pre>{p.lineText.trim()}</pre> : null}
                <span className="muted small">The file does not parse; the whole library is left without functions until it does.</span>
              </div>
            ))}
            {!dirty && problems.length === 0
              ? fileProblems.map((p, i) => (
                  <div key={`lib-${i}`} className="script-problem">
                    <span>
                      <strong>{where(p)}</strong>
                      {p.message}
                    </span>
                    <span className="muted small">Reported by the pack loader for {p.file}.</span>
                  </div>
                ))
              : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {current ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(current.path)}>
                Delete {current.path}
              </button>
            ) : null}
            <span className="grow" />
          </div>
          <SaveBar dirty={dirty} canSave={canSave} onSave={d.save} onDiscard={() => reset(current ? toDraft(current) : fresh(template))} label={draft.previousPath && draft.previousPath !== path ? 'Save and rename' : 'Save'} />
        </div>
      </div>
      {unplaced.length > 0 ? (
        <section className="section" style={{ marginTop: 18 }}>
          <h2>Library problems</h2>
          <ul className="problem-list">
            {unplaced.map((p, i) => (
              <li key={i} className="msg-error">
                <code className="mono">{p.file}</code>: {where(p)}
                {p.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="section" style={{ marginTop: 18 }}>
        <h2>What lib exports</h2>
        {library.functions.length > 0 ? (
          <ul className="problem-list">
            {library.functions.map((f) => (
              <li key={f.name}>
                <code className="mono">
                  lib.{f.name}({f.params})
                </code>
                {f.description ? ` — ${f.description}` : null} {f.internal ? <span className="badge">internal</span> : null}{' '}
                <span className="muted small">{f.file.startsWith(`${dir}/lib/`) ? f.file.slice(dir.length + 5) : f.file}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            {library.problems.length > 0 && files.length > 0
              ? 'Nothing until the library builds: fix the problems above.'
              : 'No functions yet: export one from a file in lib/ and save it.'}
          </p>
        )}
        <p className="muted small">Read from the saved files: save to see an edit here.</p>
      </section>
      {removing ? (
        <ConfirmDialog
          title={`Delete ${removing}?`}
          message={`Deletes ${dir}/lib/${removing} from the project. Files that import it stop building until their imports are changed.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      ) : null}
      {pendingSelect !== undefined ? (
        <ConfirmDialog
          title="Unsaved changes"
          message="This file has unsaved changes. Discard them?"
          confirmLabel="Discard"
          danger
          onCancel={() => setPendingSelect(undefined)}
          onConfirm={() => {
            const target = pendingSelect;
            setPendingSelect(undefined);
            applySelect(target ?? null);
          }}
        />
      ) : null}
    </div>
  );
}
