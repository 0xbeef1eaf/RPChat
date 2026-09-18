import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorScript, ScriptProblem } from '@rp/shared';
import { api } from '../../api';
import { CodeEditor } from '../../components/common/CodeEditor';
import { ConfirmDialog } from '../../components/common/Modal';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { SaveBar } from './SaveBar';

/** The function name rules of the `lib` library (a JavaScript identifier, at most 64 characters). */
const NAME_RE = /^[a-zA-Z_$][\w$]*$/;
const NAME_MAX = 64;
/** How long the author has to stop typing before the function is checked again. */
const CHECK_DEBOUNCE_MS = 400;

interface ScriptDraft {
  /** Name of the file this draft came from; null for a function that is not saved yet. */
  previousName: string | null;
  name: string;
  description: string;
  source: string;
  /** A helper the character cannot call itself (`// @internal`). */
  internal: boolean;
}

function toDraft(s: EditorScript): ScriptDraft {
  return { previousName: s.name, name: s.name, description: s.description ?? '', source: s.source, internal: s.internal === true };
}

function fresh(template: string): ScriptDraft {
  return { previousName: null, name: '', description: '', source: template, internal: false };
}

/**
 * The character's function library: one `lib/<name>.ts` per function (docs/spec/pack.md
 * "Function library"). What the author ships here is what the character starts with; the
 * app writes the character's own `lib.register` calls into the same folder of the installed copy.
 */
export function ScriptsSection() {
  const { project, setProject } = useEditor();
  const character = project.characters[0];
  const scripts = useMemo(() => character?.library ?? [], [character]);
  const [selected, setSelected] = useState<string | null>(scripts[0]?.name ?? null);
  const [template, setTemplate] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null | undefined>(undefined);
  const [problem, setProblem] = useState<ScriptProblem | undefined>(undefined);
  const checkTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api()
      .editor.scriptTemplate()
      .then(setTemplate)
      .catch((err) => console.error('scriptTemplate failed', err));
  }, []);

  const key = project.summary.key;
  const dir = character?.dir;

  const save = useCallback(
    async (draft: ScriptDraft) => {
      if (!dir) return null;
      try {
        const input: Parameters<ReturnType<typeof api>['editor']['saveScript']>[1] = { dir, name: draft.name.trim(), source: draft.source };
        if (draft.description.trim().length > 0) input.description = draft.description.trim();
        if (draft.internal) input.internal = true;
        if (draft.previousName) input.previousName = draft.previousName;
        const p = await api().editor.saveScript(key, input);
        setProject(p);
        const saved = p.characters[0]?.library.find((s) => s.name === draft.name.trim());
        toast('success', `lib.${draft.name.trim()} saved`);
        setSelected(draft.name.trim());
        return saved ? toDraft(saved) : { ...draft, previousName: draft.name.trim(), name: draft.name.trim() };
      } catch (err) {
        reportError('Could not save function', err);
        return null;
      }
    },
    [key, dir, setProject],
  );

  const current = scripts.find((s) => s.name === selected);
  const d = useDraft<ScriptDraft>(current ? toDraft(current) : fresh(template), save);
  const { draft, edit, reset, dirty } = d;

  /** Check the function the way the loader will, a moment after the author stops typing. */
  const check = useCallback((source: string) => {
    if (source.trim().length === 0) {
      setProblem(undefined);
      return;
    }
    api()
      .editor.checkScript(source, 'function')
      .then((problems) => setProblem(problems[0]))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    check(draft.source);
    return () => {
      if (checkTimer.current !== undefined) window.clearTimeout(checkTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // The template arrives after mount: a "new function" draft opened before that starts from it.
  useEffect(() => {
    if (template && selected === null && !dirty && draft.source.length === 0) reset(fresh(template));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  const setSource = (source: string) => {
    edit({ source });
    if (checkTimer.current !== undefined) window.clearTimeout(checkTimer.current);
    checkTimer.current = window.setTimeout(() => check(source), CHECK_DEBOUNCE_MS);
  };

  const select = (name: string | null) => {
    if (name === selected && (name !== null || draft.previousName === null)) return;
    if (dirty) {
      setPendingSelect(name);
      return;
    }
    applySelect(name);
  };
  const applySelect = (name: string | null) => {
    setSelected(name);
    const next = name === null ? undefined : scripts.find((s) => s.name === name);
    reset(next ? toDraft(next) : fresh(template));
  };

  const remove = async (name: string) => {
    setRemoving(null);
    if (!dir) return;
    try {
      const p = await api().editor.removeScript(key, dir, name);
      setProject(p);
      toast('info', `lib.${name} removed`);
      const remaining = p.characters[0]?.library ?? [];
      const next = remaining[0]?.name ?? null;
      setSelected(next);
      reset(next ? toDraft(remaining.find((s) => s.name === next)!) : fresh(template));
    } catch (err) {
      reportError('Could not remove function', err);
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

  const name = draft.name.trim();
  const nameProblem =
    name.length === 0 ? 'Give the function a name.' : name.length > NAME_MAX ? `At most ${NAME_MAX} characters.` : !NAME_RE.test(name) ? 'A JavaScript identifier: letters, digits, _ and $, not starting with a digit.' : scripts.some((s) => s.name === name && s.name !== draft.previousName) ? 'Another function has this name.' : undefined;
  const bytes = new TextEncoder().encode(draft.source).length;
  const canSave = nameProblem === undefined && draft.source.trim().length > 0 && bytes <= 16 * 1024;

  return (
    <div>
      <div className="section-head">
        <h1>Scripts</h1>
        <span className="muted small">
          {scripts.length} function{scripts.length === 1 ? '' : 's'} · <code className="mono">{dir}/lib/</code>
        </span>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => select(null)}>
          New function
        </button>
      </div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        Each file is one function of {character.definition.name || character.definition.id}'s <code>lib</code> library, callable as <code>lib.&lt;name&gt;(...)</code> in every
        action, timer handler and event handler. The first line <code>// …</code> is its description in the prompt; the rest is exactly one function expression.
        The character's own <code>lib.register</code> calls are saved into the same folder of the installed pack. Mark a function <em>internal</em> to keep it as
        plumbing for your other functions and hooks, out of sight of the character.
      </p>
      <div className="scripts-layout">
        <nav className="scripts-list" aria-label="Functions">
          {scripts.length === 0 ? <p className="muted small">No functions yet.</p> : null}
          {scripts.map((s) => (
            <button key={s.name} type="button" className="nav-item" aria-current={s.name === selected ? 'page' : undefined} onClick={() => select(s.name)} title={s.problem ?? s.description ?? s.file}>
              <span className="item-text">
                <span className="item-title mono">{s.name}</span>
                {s.description ? <span className="item-sub">{s.description}</span> : null}
              </span>
              {s.internal ? <span className="badge">internal</span> : null}
              {s.problem ? <span className="badge badge-danger">broken</span> : null}
            </button>
          ))}
          {selected === null ? (
            <button type="button" className="nav-item" aria-current="page">
              <span className="item-text">
                <span className="item-title mono">{name || 'new function'}</span>
                <span className="item-sub">not saved yet</span>
              </span>
            </button>
          ) : null}
        </nav>
        <div className="scripts-editor">
          <div className="field-grid">
            <div className="field">
              <label htmlFor="sc-name">Name</label>
              <input id="sc-name" type="text" className="mono" value={draft.name} spellCheck={false} placeholder="cheer" onChange={(e) => edit({ name: e.target.value })} />
              {nameProblem ? <span className="field-hint msg-error">{nameProblem}</span> : <span className="field-hint">Called as <code>lib.{name || 'name'}(...)</code>; saved as <code>lib/{name || 'name'}.ts</code>.</span>}
            </div>
            <div className="field">
              <label htmlFor="sc-desc">Description</label>
              <input id="sc-desc" type="text" value={draft.description} placeholder="show a picture for a mood" onChange={(e) => edit({ description: e.target.value })} />
              <span className="field-hint">One line, shown in the character's prompt under <code>&lt;library&gt;</code>.</span>
            </div>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label className="check small">
              <input type="checkbox" checked={draft.internal} onChange={(e) => edit({ internal: e.target.checked })} />
              Internal helper (first line <code>// @internal</code>)
            </label>
            <span className="field-hint">
              Your other functions and the character's behaviour hooks can call <code>lib.{name || 'name'}(...)</code>; the character cannot. It is left out of{' '}
              <code>&lt;library&gt;</code> and of the <code>lib</code> object the character's own code sees.
            </span>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <div className="row">
              <span className="field-label grow">Function</span>
              <span className="muted small">{bytes} bytes</span>
              <button type="button" className="btn btn-sm" onClick={() => setSource(draft.source.trim() ? `${draft.source.trimEnd()}\n\n${template}` : template)} disabled={!template}>
                Insert template
              </button>
            </div>
            <CodeEditor
              language="typescript"
              path={`lib-${draft.previousName ?? 'new'}`}
              value={draft.source}
              onChange={setSource}
              invalid={Boolean(problem || current?.problem)}
              problems={problem ? [problem] : undefined}
              height={320}
              ariaLabel="Function source"
            />
            {problem ? (
              <div className="script-problem">
                <strong>{problem.line !== undefined ? `Line ${problem.line}${problem.column !== undefined ? `, column ${problem.column}` : ''}: ` : ''}</strong>
                {problem.message}
                {problem.lineText ? <pre>{problem.lineText.trim()}</pre> : null}
                <span className="muted small">The loader skips a file that is not exactly one function expression; the character will not see it until this is fixed.</span>
              </div>
            ) : current?.problem && !dirty ? (
              <div className="script-problem">
                {current.problem}
                <span className="muted small">Reported by the pack loader for {current.file}.</span>
              </div>
            ) : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {current ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(current.name)}>
                Delete lib.{current.name}
              </button>
            ) : null}
            <span className="grow" />
          </div>
          <SaveBar dirty={dirty} canSave={canSave} onSave={d.save} onDiscard={() => reset(current ? toDraft(current) : fresh(template))} label={draft.previousName && draft.previousName !== name ? 'Save and rename' : 'Save'} />
        </div>
      </div>
      {removing ? (
        <ConfirmDialog
          title={`Delete lib.${removing}?`}
          message={`Deletes ${dir}/lib/${removing}.ts from the project.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove(removing)}
        />
      ) : null}
      {pendingSelect !== undefined ? (
        <ConfirmDialog
          title="Unsaved changes"
          message="This function has unsaved changes. Discard them?"
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
