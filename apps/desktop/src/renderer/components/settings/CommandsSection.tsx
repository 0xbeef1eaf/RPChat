import { useEffect, useState } from 'react';
import type { AppSettings, CommandTemplate, CommandTemplates } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { Toggle } from '../common/Toggle';

type TemplateName = keyof CommandTemplates;

const TEMPLATES: Array<{ name: TemplateName; label: string; placeholders: string; help: string }> = [
  {
    name: 'wallpaper',
    label: 'Set wallpaper',
    placeholders: '{file} {monitor}',
    help: 'Used by sdk.wallpaper.set. {file} is the absolute image path, {monitor} the monitor name or empty.',
  },
  {
    name: 'browser',
    label: 'Open browser',
    placeholders: '{url}',
    help: 'Used by sdk.browser.open. Include {newWindow} where a new-window flag should go.',
  },
  {
    name: 'inputLock',
    label: 'Lock input',
    placeholders: '{seconds} {durationMs}',
    help: 'Used by sdk.input.lock. No platform default: point it at your own script (e.g. evsieve/xinput on Linux, or hyprlock for a screen lock).',
  },
  {
    name: 'inputUnlock',
    label: 'Unlock input',
    placeholders: '',
    help: 'Optional. Leave empty when the lock command unlocks itself after the duration.',
  },
];

const EMPTY: CommandTemplate = { command: '' };

interface CommandsSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
}

export function CommandsSection({ settings, onPatch }: CommandsSectionProps) {
  const [defaults, setDefaults] = useState<CommandTemplates | null>(null);

  useEffect(() => {
    api()
      .settings.defaultCommands()
      .then(setDefaults)
      .catch((err) => console.error('defaultCommands failed', err));
  }, []);

  const templates = settings.commandTemplates;
  const saveTemplate = (name: TemplateName, tpl: CommandTemplate) =>
    onPatch({ commandTemplates: { ...templates, [name]: tpl } });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="muted small">
        External commands characters may run through the <code>wallpaper</code>, <code>browser</code> and <code>input</code> modules
        (each still needs a per-pack grant). Commands are tokenised like a shell line and run <em>without</em> a shell; placeholders are
        substituted inside tokens so values can never inject extra arguments. Leave a command empty to use the platform default.
      </p>
      {TEMPLATES.map((t) => (
        <TemplateEditor
          key={t.name}
          meta={t}
          value={templates[t.name] ?? EMPTY}
          fallback={defaults?.[t.name]}
          onSave={(tpl) => saveTemplate(t.name, tpl)}
        />
      ))}
    </div>
  );
}

interface TemplateEditorProps {
  meta: (typeof TEMPLATES)[number];
  value: CommandTemplate;
  fallback: CommandTemplate | undefined;
  onSave: (tpl: CommandTemplate) => Promise<boolean>;
}

function TemplateEditor({ meta, value, fallback, onSave }: TemplateEditorProps) {
  const [draft, setDraft] = useState<CommandTemplate>(value);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ code: number; stdout: string; stderr: string } | { error: string } | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = draft.command !== value.command || Boolean(draft.shell) !== Boolean(value.shell) || (draft.timeoutMs ?? 0) !== (value.timeoutMs ?? 0);
  const effective = draft.command.trim() ? draft : fallback && fallback.command ? fallback : null;
  const fallbackText = fallback?.command ? fallback.command : 'no platform default — not configured';

  const save = async () => {
    setBusy('save');
    const tpl: CommandTemplate = { command: draft.command.trim() };
    if (draft.shell) tpl.shell = true;
    if (draft.timeoutMs && draft.timeoutMs > 0) tpl.timeoutMs = Math.round(draft.timeoutMs);
    await onSave(tpl);
    setBusy(null);
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const tpl = effective ?? draft;
      setResult(await api().settings.testCommand(meta.name, tpl));
    } catch (err) {
      setResult({ error: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const inputId = `cmd-${meta.name}`;
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 className="grow">
          {meta.label} <span className="muted mono small">{meta.placeholders}</span>
        </h3>
        {!draft.command.trim() ? (
          <span className={fallback?.command ? 'badge badge-accent' : 'badge badge-warning'}>
            {fallback?.command ? 'platform default' : 'not configured'}
          </span>
        ) : (
          <span className="badge badge-success">custom</span>
        )}
      </div>
      <p className="field-hint" style={{ marginBottom: 8 }}>
        {meta.help}
      </p>
      <div className="field">
        <label htmlFor={inputId}>Command</label>
        <input
          id={inputId}
          type="text"
          className="mono"
          value={draft.command}
          placeholder={fallbackText}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
        />
        {!draft.command.trim() && fallback?.command ? (
          <span className="field-hint">
            Default: <code>{fallback.command}</code>
            {fallback.shell ? ' (via shell)' : ''}
          </span>
        ) : null}
      </div>
      <div className="row wrap" style={{ marginTop: 8, gap: 16 }}>
        <Toggle checked={Boolean(draft.shell)} onChange={(shell) => setDraft({ ...draft, shell: shell || undefined })} label="Run through the platform shell" />
        <div className="row">
          <label htmlFor={`${inputId}-timeout`} className="muted small">
            Timeout (ms)
          </label>
          <input
            id={`${inputId}-timeout`}
            type="number"
            min={100}
            step={100}
            style={{ width: 110 }}
            value={draft.timeoutMs ?? ''}
            placeholder="30000"
            onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={test} disabled={busy !== null || !effective}>
          {busy === 'test' ? 'Running…' : 'Test'}
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || busy !== null}>
          Save
        </button>
      </div>
      {result ? (
        'error' in result ? (
          <div className="callout callout-danger small" style={{ marginTop: 8 }}>
            {result.error}
          </div>
        ) : (
          <div className={`callout small ${result.code === 0 ? 'callout-success' : 'callout-danger'}`} style={{ marginTop: 8 }}>
            <div>
              Exit code <strong>{result.code}</strong>
            </div>
            {result.stdout ? (
              <pre style={{ marginTop: 6, maxHeight: 160 }}>
                <code>{result.stdout}</code>
              </pre>
            ) : null}
            {result.stderr ? (
              <pre style={{ marginTop: 6, maxHeight: 160 }}>
                <code>{result.stderr}</code>
              </pre>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}
