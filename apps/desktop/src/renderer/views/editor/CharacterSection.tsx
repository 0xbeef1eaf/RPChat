import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BehaviourHook, BehaviourTemplate, CharacterDefinition, EditorCharacter, ExampleDialogueTurn, ScriptProblem } from '@rp/shared';
import { api } from '../../api';
import { CodeEditor } from '../../components/common/CodeEditor';
import { Markdown } from '../../components/common/Markdown';
import { isValidCharacterId, wordCount } from '../../lib/editor';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { PromptSdkSection } from './PromptSdkSection';
import { SaveBar } from './SaveBar';
import { VoicePicker } from './VoicePicker';

interface CharacterSectionProps {
  dir: string;
}

interface CharacterDraft {
  definition: CharacterDefinition;
  personaText: string;
  behaviours: Partial<Record<BehaviourHook, string>>;
}

/** How long the author has to stop typing before the script is compiled again. */
const CHECK_DEBOUNCE_MS = 400;

const HOOKS: Array<{ hook: BehaviourHook; label: string; hint: string }> = [
  { hook: 'onInstall', label: 'onInstall', hint: 'Once, right after the user installed the pack.' },
  { hook: 'onSessionStart', label: 'onSessionStart', hint: 'Every new session; good for greetings with media.' },
  { hook: 'onUserMessage', label: 'onUserMessage', hint: 'Before the LLM sees a user message; may return { skipLlm: true }.' },
  { hook: 'onTimer', label: 'onTimer', hint: 'When a scheduled timer fires.' },
  { hook: 'onEvent', label: 'onEvent', hint: 'Host events with no matching subscription.' },
  { hook: 'onSessionEnd', label: 'onSessionEnd', hint: 'When a session is deleted.' },
];

function toDraft(c: EditorCharacter): CharacterDraft {
  return { definition: c.definition, personaText: c.personaText, behaviours: c.behaviours };
}

export function CharacterSection({ dir }: CharacterSectionProps) {
  const { project, setProject } = useEditor();
  const character = project.characters.find((c) => c.dir === dir)!;
  const [templates, setTemplates] = useState<BehaviourTemplate[]>([]);
  const [preview, setPreview] = useState(false);
  const [idUnlocked, setIdUnlocked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [scriptProblems, setScriptProblems] = useState<Partial<Record<BehaviourHook, ScriptProblem>>>({});
  const checkTimers = useRef<Partial<Record<BehaviourHook, number>>>({});

  useEffect(() => {
    api()
      .editor.behaviourTemplates()
      .then(setTemplates)
      .catch((err) => console.error('behaviourTemplates failed', err));
  }, []);

  /**
   * Compile the script the author is typing, a moment after they stop. Writing a behaviour blind —
   * save, install, start a session, watch nothing happen — is the worst part of the editor, and a
   * syntax error costs the whole hook: nothing in the script runs, including the `sdk.events.on`
   * call at the bottom of it.
   */
  const checkHook = useCallback((hook: BehaviourHook, source: string | undefined) => {
    if (source === undefined || source.trim().length === 0) {
      setScriptProblems((p) => ({ ...p, [hook]: undefined }));
      return;
    }
    api()
      .editor.checkScript(source)
      .then((problems) => setScriptProblems((p) => ({ ...p, [hook]: problems[0] })))
      .catch(() => undefined); // the check is a convenience; never let it interrupt editing
  }, []);

  useEffect(() => {
    const timers = checkTimers.current;
    setScriptProblems({});
    for (const { hook } of HOOKS) checkHook(hook, character.behaviours[hook]);
    return () => {
      for (const t of Object.values(timers)) if (t !== undefined) window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  const save = useCallback(
    async (draft: CharacterDraft) => {
      try {
        const p = await api().editor.saveCharacter(project.summary.key, { dir, ...draft });
        setProject(p);
        toast('success', `${draft.definition.name} saved`);
        const saved = p.characters.find((c) => c.dir === dir);
        return saved ? toDraft(saved) : draft;
      } catch (err) {
        reportError('Could not save character', err);
        return null;
      }
    },
    [project.summary.key, dir, setProject],
  );

  const d = useDraft<CharacterDraft>(toDraft(character), save);
  const { draft, edit } = d;
  // Pickers write to disk and return a new project: take avatar/avatarSet paths from disk, keep other edits.
  useEffect(() => {
    d.external(toDraft(character), (dr, saved) => ({
      ...dr,
      definition: {
        ...dr.definition,
        avatar: saved.definition.avatar,
        // `pickVoice` copies the recording and writes the reference itself; the rest is draft state.
        voice: saved.definition.voice ? { ...dr.definition.voice, reference: saved.definition.voice.reference, referenceSource: saved.definition.voice.referenceSource, attribution: saved.definition.voice.attribution } : dr.definition.voice,
        avatarSet: saved.definition.avatarSet
          ? { ...saved.definition.avatarSet, ...(dr.definition.avatarSet ? { defaultExpression: dr.definition.avatarSet.defaultExpression, size: dr.definition.avatarSet.size } : {}), expressions: saved.definition.avatarSet.expressions }
          : dr.definition.avatarSet,
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character]);

  const def = draft.definition;
  const setDef = (patch: Partial<CharacterDefinition>) => edit((dr) => ({ ...dr, definition: { ...dr.definition, ...patch } }));
  const hints = def.modelHints ?? {};
  const setHints = (patch: Partial<NonNullable<CharacterDefinition['modelHints']>>) => {
    const next = { ...hints, ...patch };
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined || (next[k] as unknown) === '') delete next[k];
    setDef({ modelHints: Object.keys(next).length ? next : undefined });
  };
  const voice = def.voice;
  /** Same shape as `setHints`: empty values drop out, and an empty block drops the key entirely. */
  const setVoice = (patch: Partial<NonNullable<CharacterDefinition['voice']>>) => {
    const next = { ...(voice ?? {}), ...patch };
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined || (next[k] as unknown) === '') delete next[k];
    setDef({ voice: Object.keys(next).length ? next : undefined });
  };
  const dialogue = def.exampleDialogue ?? [];
  const setDialogue = (list: ExampleDialogueTurn[]) => setDef({ exampleDialogue: list.length ? list : undefined });
  const avatarSet = def.avatarSet;
  const expressions = Object.entries(avatarSet?.expressions ?? {});
  const [newExpr, setNewExpr] = useState('');

  const pick = async (what: 'avatar' | 'expression', expression?: string) => {
    setBusy(what);
    try {
      const p = what === 'avatar' ? await api().editor.pickAvatar(project.summary.key, dir) : await api().editor.pickExpression(project.summary.key, dir, expression!);
      setProject(p);
      if (what === 'expression') setNewExpr('');
    } catch (err) {
      reportError(what === 'avatar' ? 'Could not pick avatar' : 'Could not pick expression', err);
    } finally {
      setBusy(null);
    }
  };

  const insertTemplate = (hook: BehaviourHook) => {
    const t = templates.find((x) => x.hook === hook);
    if (!t) return;
    edit((dr) => ({ ...dr, behaviours: { ...dr.behaviours, [hook]: dr.behaviours[hook] ? `${dr.behaviours[hook]}\n\n${t.source}` : t.source } }));
  };
  const setHook = (hook: BehaviourHook, source: string | undefined) => {
    edit((dr) => {
      const behaviours = { ...dr.behaviours };
      if (source === undefined) delete behaviours[hook];
      else behaviours[hook] = source;
      return { ...dr, behaviours };
    });
    const pending = checkTimers.current;
    if (pending[hook] !== undefined) window.clearTimeout(pending[hook]);
    pending[hook] = window.setTimeout(() => checkHook(hook, source), CHECK_DEBOUNCE_MS);
  };

  const words = useMemo(() => wordCount(draft.personaText), [draft.personaText]);

  return (
    <div>
      <div className="section-head">
        <h1>{def.name || def.id}</h1>
        <span className="muted small">
          The pack's character · <code className="mono">{dir}</code>
        </span>
      </div>

      <div className="field-grid">
        <div className="field">
          <label htmlFor="ch-id">Id</label>
          <div className="input-with-btn">
            <input id="ch-id" type="text" className="mono" value={def.id} disabled={!idUnlocked} onChange={(e) => setDef({ id: e.target.value.toLowerCase() })} />
            <button type="button" className="btn btn-sm" onClick={() => setIdUnlocked((v) => !v)}>
              {idUnlocked ? 'Lock' : 'Advanced'}
            </button>
          </div>
          {!isValidCharacterId(def.id) ? <span className="field-hint msg-error">Invalid id.</span> : null}
        </div>
        <div className="field">
          <label htmlFor="ch-name">Name</label>
          <input id="ch-name" type="text" value={def.name} onChange={(e) => setDef({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="ch-tagline">Tagline</label>
          <input id="ch-tagline" type="text" value={def.tagline ?? ''} onChange={(e) => setDef({ tagline: e.target.value || undefined })} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="ch-greeting">Greeting</label>
        <textarea id="ch-greeting" value={def.greeting ?? ''} placeholder="First message in a new session (markdown)." onChange={(e) => setDef({ greeting: e.target.value || undefined })} />
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Avatar</span>
        <div className="avatar-pick">
          {character.avatarUrl ? <img src={character.avatarUrl} alt="" /> : <span className="expr-thumb row" style={{ justifyContent: 'center' }}>—</span>}
          <div className="stack" style={{ gap: 4 }}>
            <span className="muted small mono">{def.avatar ?? 'no avatar'}</span>
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => pick('avatar')} disabled={busy !== null}>
                {busy === 'avatar' ? 'Picking…' : 'Pick image…'}
              </button>
              {def.avatar ? (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDef({ avatar: undefined })}>
                  Clear
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <div className="row">
          <label htmlFor="ch-persona" className="field-label grow">
            Persona (markdown) · {words} words
          </label>
          <label className="check small">
            <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> preview
          </label>
        </div>
        <div className={preview ? 'split' : undefined}>
          <textarea id="ch-persona" className="persona" value={draft.personaText} spellCheck onChange={(e) => edit({ personaText: e.target.value })} />
          {preview ? (
            <div className="preview">
              <Markdown source={draft.personaText || '_Nothing yet._'} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Example dialogue</span>
        <span className="field-hint">Short user / character pairs that show the voice.</span>
        <div className="stack" style={{ gap: 6, marginTop: 4 }}>
          {dialogue.map((t, i) => (
            <div key={i} className="dialogue-row">
              <textarea value={t.user} placeholder="User" style={{ minHeight: 48 }} onChange={(e) => setDialogue(dialogue.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)))} />
              <textarea value={t.character} placeholder="Character" style={{ minHeight: 48 }} onChange={(e) => setDialogue(dialogue.map((x, j) => (j === i ? { ...x, character: e.target.value } : x)))} />
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Remove pair" onClick={() => setDialogue(dialogue.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setDialogue([...dialogue, { user: '', character: '' }])}>
              Add pair
            </button>
          </div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Behaviours</span>
        <span className="field-hint">Scripts run in the sandbox around the LLM turn, with the same SDK and permissions.</span>
        <div className="stack" style={{ gap: 8, marginTop: 4 }}>
          {HOOKS.map(({ hook, label, hint }) => {
            const enabled = draft.behaviours[hook] !== undefined;
            const problem = enabled ? scriptProblems[hook] : undefined;
            return (
              <div key={hook} className="hook">
                <div className="row">
                  <label className="check grow">
                    <input type="checkbox" checked={enabled} onChange={(e) => setHook(hook, e.target.checked ? (templates.find((t) => t.hook === hook)?.source ?? '') : undefined)} />
                    <code>{label}</code>
                    <span className="muted small">{hint}</span>
                  </label>
                  {enabled ? (
                    <button type="button" className="btn btn-sm" onClick={() => insertTemplate(hook)} disabled={!templates.some((t) => t.hook === hook)}>
                      Insert template
                    </button>
                  ) : null}
                </div>
                {enabled ? (
                  <>
                    <div style={{ marginTop: 8 }}>
                      <CodeEditor
                        language="typescript"
                        path={`hook-${hook}`}
                        value={draft.behaviours[hook] ?? ''}
                        onChange={(next) => setHook(hook, next)}
                        invalid={Boolean(problem)}
                        problems={problem ? [problem] : undefined}
                        height={220}
                        ariaLabel={`${label} script`}
                      />
                    </div>
                    {problem ? (
                      <div className="script-problem">
                        <strong>{problem.line !== undefined ? `Line ${problem.line}${problem.column !== undefined ? `, column ${problem.column}` : ''}: ` : ''}</strong>
                        {problem.message}
                        {problem.lineText ? <pre>{problem.lineText.trim()}</pre> : null}
                        <span className="muted small">Nothing in this script runs until it compiles — not even the calls below the error.</span>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Model hints</span>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="ch-temp">Temperature</label>
            <input id="ch-temp" type="number" min={0} max={2} step={0.1} value={hints.temperature ?? ''} onChange={(e) => setHints({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })} />
          </div>
          <div className="field">
            <label htmlFor="ch-maxtok">Max tokens</label>
            <input id="ch-maxtok" type="number" min={1} step={1} value={hints.maxTokens ?? ''} onChange={(e) => setHints({ maxTokens: e.target.value === '' ? undefined : Math.round(Number(e.target.value)) })} />
          </div>
          <div className="field">
            <label htmlFor="ch-model">Preferred model</label>
            <input id="ch-model" type="text" className="mono" value={hints.model ?? ''} onChange={(e) => setHints({ model: e.target.value || undefined })} />
          </div>
        </div>
      </div>

      <VoicePicker projectKey={project.summary.key} dir={dir} voice={voice} onChange={setVoice} onProject={(p) => setProject(p as typeof project)} />

      <div className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Avatar expressions (sdk.avatar)</span>
        <span className="field-hint">Expression name → image or short webm. Include “neutral”.</span>
        <div className="stack" style={{ gap: 6, marginTop: 4 }}>
          {expressions.map(([name, path]) => (
            <div key={name} className="expr-row">
              {character.expressionUrls?.[name] ? <img className="expr-thumb" src={character.expressionUrls[name]} alt="" style={{ width: 40, height: 40 }} /> : null}
              <div className="item-text">
                <span className="item-title">{name}</span>
                <span className="item-sub mono">{path}</span>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => pick('expression', name)} disabled={busy !== null}>
                Replace…
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label={`Remove ${name}`}
                onClick={() => {
                  const next = { ...(avatarSet?.expressions ?? {}) };
                  delete next[name];
                  setDef({ avatarSet: Object.keys(next).length ? { ...avatarSet, expressions: next, defaultExpression: avatarSet?.defaultExpression === name ? undefined : avatarSet?.defaultExpression } : undefined });
                }}
              >
                ×
              </button>
            </div>
          ))}
          <div className="row">
            <input type="text" value={newExpr} placeholder="expression name (e.g. happy)" style={{ maxWidth: 260 }} onChange={(e) => setNewExpr(e.target.value.trim().toLowerCase())} />
            <button type="button" className="btn btn-sm" onClick={() => pick('expression', newExpr)} disabled={!newExpr || busy !== null}>
              {busy === 'expression' ? 'Picking…' : 'Pick file…'}
            </button>
          </div>
          {expressions.length > 0 ? (
            <div className="field-grid">
              <div className="field">
                <label htmlFor="ch-defexpr">Default expression</label>
                <select id="ch-defexpr" value={avatarSet?.defaultExpression ?? ''} onChange={(e) => setDef({ avatarSet: { ...avatarSet!, defaultExpression: e.target.value || undefined } })}>
                  <option value="">neutral (default)</option>
                  {expressions.map(([name]) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ch-size">Size (px)</label>
                <input id="ch-size" type="number" min={48} step={8} value={avatarSet?.size ?? ''} placeholder="240" onChange={(e) => setDef({ avatarSet: { ...avatarSet!, size: e.target.value ? Number(e.target.value) : undefined } })} />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <PromptSdkSection value={def.promptFunctions} onChange={(promptFunctions) => setDef({ promptFunctions })} />

      <div className="field" style={{ marginTop: 16 }}>
        <span className="field-label">Mood baselines</span>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="ch-mood">Mood baseline (−1 … 1)</label>
            <div className="slider-row">
              <input id="ch-mood" type="range" min={-1} max={1} step={0.05} value={def.mood?.baseline ?? 0.2} onChange={(e) => setDef({ mood: { ...def.mood, baseline: Number(e.target.value) } })} />
              <span className="mono small">{(def.mood?.baseline ?? 0.2).toFixed(2)}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ch-energy">Energy baseline (0 … 1)</label>
            <div className="slider-row">
              <input id="ch-energy" type="range" min={0} max={1} step={0.05} value={def.mood?.energyBaseline ?? 0.7} onChange={(e) => setDef({ mood: { ...def.mood, energyBaseline: Number(e.target.value) } })} />
              <span className="mono small">{(def.mood?.energyBaseline ?? 0.7).toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>

      <SaveBar dirty={d.dirty} onSave={d.save} onDiscard={() => d.reset(toDraft(character))} />
    </div>
  );
}
