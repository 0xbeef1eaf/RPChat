import { useState } from 'react';
import type { ModelInfo, ProviderConfig, ProviderKind } from '@rp/shared';
import { api, errorMessage } from '../../api';

const KINDS: Array<{ value: ProviderKind; label: string; hint: string }> = [
  { value: 'anthropic', label: 'Anthropic', hint: 'Claude models via the Anthropic API.' },
  { value: 'openai-compatible', label: 'OpenAI-compatible', hint: 'OpenAI, OpenRouter, Ollama, LM Studio, vLLM… anything with /v1/chat/completions.' },
  { value: 'mock', label: 'Mock (testing)', hint: 'Scripted replies; no network.' },
];

interface ProviderEditorProps {
  initial: ProviderConfig;
  isNew: boolean;
  onSave: (config: ProviderConfig) => Promise<void>;
  onCancel: () => void;
}

export function ProviderEditor({ initial, isNew, onSave, onCancel }: ProviderEditorProps) {
  const [cfg, setCfg] = useState<ProviderConfig>(initial);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState<'models' | 'test' | 'save' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const patch = (p: Partial<ProviderConfig>) => setCfg((c) => ({ ...c, ...p }));
  const kindInfo = KINDS.find((k) => k.value === cfg.kind);

  const fetchModels = async () => {
    setBusy('models');
    setResult(null);
    try {
      const list = await api().settings.listModels(cfg);
      setModels(list);
      setResult({ ok: true, message: list.length ? `${list.length} models available` : 'The provider returned no models' });
      if (!cfg.model && list[0]) patch({ model: list[0].id });
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const r = await api().settings.testProvider(cfg);
      setResult({ ok: r.ok, message: r.message ?? (r.ok ? 'Connection OK' : 'Test failed') });
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    await onSave({ ...cfg, label: cfg.label.trim() || kindInfo?.label || 'Provider', model: cfg.model.trim() });
    setBusy(null);
  };

  const valid = cfg.model.trim().length > 0 && (cfg.kind !== 'openai-compatible' || Boolean(cfg.baseUrl?.trim()));

  return (
    <div className="card provider-editor">
      <h3>{isNew ? 'New provider' : `Edit ${initial.label}`}</h3>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="p-label">Label</label>
          <input id="p-label" type="text" value={cfg.label} onChange={(e) => patch({ label: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="p-kind">Kind</label>
          <select id="p-kind" value={cfg.kind} onChange={(e) => patch({ kind: e.target.value as ProviderKind })}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          {kindInfo ? <span className="field-hint">{kindInfo.hint}</span> : null}
        </div>
        <div className="field">
          <label htmlFor="p-url">Base URL</label>
          <input
            id="p-url"
            type="url"
            value={cfg.baseUrl ?? ''}
            placeholder={cfg.kind === 'anthropic' ? 'https://api.anthropic.com (default)' : 'http://localhost:11434/v1'}
            onChange={(e) => patch({ baseUrl: e.target.value || undefined })}
          />
        </div>
        <div className="field">
          <label htmlFor="p-key">API key</label>
          <div className="input-with-btn">
            <input
              id="p-key"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              value={cfg.apiKey ?? ''}
              placeholder={cfg.kind === 'mock' ? 'not needed' : 'sk-…'}
              onChange={(e) => patch({ apiKey: e.target.value || undefined })}
            />
            <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="p-model">Model</label>
          <div className="input-with-btn">
            <input id="p-model" type="text" list="p-models" value={cfg.model} onChange={(e) => patch({ model: e.target.value })} />
            <datalist id="p-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
            </datalist>
            <button type="button" className="btn btn-sm" onClick={fetchModels} disabled={busy !== null}>
              {busy === 'models' ? 'Fetching…' : 'Fetch models'}
            </button>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Tool calling</span>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.supportsTools !== false}
              onChange={(e) => patch({ supportsTools: e.target.checked ? undefined : false })}
            />
            Model supports native tool calling
          </label>
          <span className="field-hint">Untick for models that only work with fenced ```action blocks.</span>
        </div>
        <div className="field">
          <span className="field-label">Vision</span>
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.supportsVision ?? cfg.kind === 'anthropic'}
              onChange={(e) => patch({ supportsVision: e.target.checked })}
            />
            Model accepts images
          </label>
          <span className="field-hint">
            Needed for screenshots (<code>sdk.screen.look</code>) and the pack editor's auto-tagging. Tick it for vision models such as qwen3-vl or llava.
          </span>
        </div>
      </div>
      {models.length > 0 ? (
        <div className="field">
          <label htmlFor="p-model-select">Pick from fetched models</label>
          <select id="p-model-select" value={models.some((m) => m.id === cfg.model) ? cfg.model : ''} onChange={(e) => patch({ model: e.target.value })}>
            <option value="">—</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {result ? <div className={`test-result ${result.ok ? 'callout callout-success' : 'callout callout-danger'}`}>{result.message}</div> : null}
      <div className="form-actions">
        <button type="button" className="btn" onClick={test} disabled={busy !== null}>
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel} disabled={busy === 'save'}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={!valid || busy !== null}>
          Save
        </button>
      </div>
    </div>
  );
}
