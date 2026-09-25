import { useEffect, useState } from 'react';
import {
  CHAT_ZOOM_MAX,
  CHAT_ZOOM_MIN,
  CHAT_ZOOM_STEP,
  DEFAULT_RUN_LIMITS,
  UNLIMITED,
  type AppSettings,
  type EmbeddingStatus,
  type ProviderConfig,
  type RunLimits,
} from '@rp/shared';
import { api } from '../api';
import { BrowserSection } from '../components/settings/BrowserSection';
import { CommandsSection } from '../components/settings/CommandsSection';
import { DisplayInfo } from '../components/settings/DisplayInfo';
import { IntegrationsSection } from '../components/settings/IntegrationsSection';
import { PermissionsSection } from '../components/settings/PermissionsSection';
import { PluginsSection } from '../components/settings/PluginsSection';
import { ManagedBadge, useManaged } from '../components/settings/Managed';
import { EncryptionSection } from '../components/settings/EncryptionSection';
import { SystemSection } from '../components/settings/SystemSection';
import { UpdatesSection } from '../components/settings/UpdatesSection';
import { SensesSection } from '../components/settings/SensesSection';
import { ProviderEditor } from '../components/settings/ProviderEditor';
import { ConfirmDialog } from '../components/common/Modal';
import { newId } from '../lib/ids';
import { maskSecret } from '../lib/format';
import { applyTheme } from '../lib/theme';
import { reportError, setChatZoom, toast } from '../store/actions';
import { useAppState, update } from '../store/store';
import type { SettingsTab } from '../store/state';

async function patchSettings(patch: Partial<AppSettings>): Promise<boolean> {
  try {
    const next = await api().settings.update(patch);
    update((s) => ({ ...s, settings: next }));
    applyTheme(next.theme);
    return true;
  } catch (err) {
    reportError('Could not save settings', err);
    return false;
  }
}

export interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  hint?: string;
  min?: number;
  step?: number;
  /** Dotted settings path; when forced by policy the field renders disabled with a badge. */
  path?: string;
  onCommit: (v: number) => void;
}

function NumberField({ id, label, value, hint, min, step, path, onCommit }: NumberFieldProps) {
  const managed = useManaged(path ?? '');
  const [text, setText] = useState(String(value));
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || (min !== undefined && n < min)) {
      setText(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        <ManagedBadge show={managed} />
      </label>
      <input
        id={id}
        type="number"
        min={min}
        step={step}
        value={text}
        disabled={managed}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/** One `MediaKind` per row: how many may run at once, and how many may wait behind them. */
const MEDIA_LIMIT_ROWS: ReadonlyArray<{ kind: keyof AppSettings['media']['maxConcurrent']; at: string; waiting: string }> = [
  { kind: 'image', at: 'Images on screen at once', waiting: 'Images waiting' },
  { kind: 'video', at: 'Videos playing at once', waiting: 'Videos waiting' },
  { kind: 'audio', at: 'Sounds playing at once', waiting: 'Sounds waiting' },
];

/**
 * `settings.media`: the per-kind concurrency caps and queue lengths for `sdk.media`. A call over a
 * cap is not refused and does not block the character — it waits its turn and opens when one of
 * the open items of its kind goes away.
 */
function MediaLimitFields({ settings }: { settings: AppSettings }) {
  const patch = (side: 'maxConcurrent' | 'maxQueued', kind: keyof AppSettings['media']['maxConcurrent'], value: number) =>
    void patchSettings({ media: { ...settings.media, [side]: { ...settings.media[side], [kind]: Math.max(0, Math.round(value)) } } });
  return (
    <div className="field">
      <span className="field-label">How much media at once</span>
      <span className="field-hint">
        Per kind: how many a character may have running together, and how many more may queue behind them. A call over the limit does not fail — it waits, and
        starts by itself as soon as one closes. <strong>0 at once</strong> means no limit; <strong>0 waiting</strong> refuses the call instead of queueing it.
      </span>
      <div className="field-grid">
        {MEDIA_LIMIT_ROWS.map((row) => (
          <NumberField
            key={`at-${row.kind}`}
            id={`media-at-once-${row.kind}`}
            label={row.at}
            min={0}
            value={settings.media.maxConcurrent[row.kind]}
            path={`media.maxConcurrent.${row.kind}`}
            onCommit={(v) => patch('maxConcurrent', row.kind, v)}
          />
        ))}
        {MEDIA_LIMIT_ROWS.map((row) => (
          <NumberField
            key={`queue-${row.kind}`}
            id={`media-queued-${row.kind}`}
            label={row.waiting}
            min={0}
            value={settings.media.maxQueued[row.kind]}
            path={`media.maxQueued.${row.kind}`}
            onCommit={(v) => patch('maxQueued', row.kind, v)}
          />
        ))}
      </div>
    </div>
  );
}

/** One line of plain English for what `memories.embeddingStatus()` came back with. */
function embeddingStatusText(status: EmbeddingStatus): string {
  if (status.problem) return `Keyword ranking only — ${status.problem}`;
  const where = status.source === 'local' ? 'on this machine' : 'through the provider';
  return `Ranking by meaning ${where}: ${status.label ?? 'embedder'}${status.dims ? `, ${status.dims} dimensions` : ''}.`;
}

/**
 * `settings.memory`: where the vectors behind semantic recall come from.
 *
 * The model has to be named because an embedding model id cannot be guessed from a chat one, and
 * naming the wrong one fails in a way that is invisible from the chat window — every recall simply
 * goes back to keywords. Hence the check button: one short embedding is the only honest test.
 */
function SemanticMemoryFields({ settings }: { settings: AppSettings }) {
  const managed = useManaged('memory.semanticRanking');
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [model, setModel] = useState(settings.memory.embeddingModel ?? '');
  const patchMemory = (patch: Partial<AppSettings['memory']>) => void patchSettings({ memory: { ...settings.memory, ...patch } });
  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api().memories.embeddingStatus());
    } catch (err) {
      reportError('Could not check the embedder', err);
    } finally {
      setChecking(false);
    }
  };
  const commitModel = () => {
    const next = model.trim();
    if (next !== (settings.memory.embeddingModel ?? '')) {
      setStatus(null);
      patchMemory({ embeddingModel: next.length > 0 ? next : undefined });
    }
  };
  return (
    <>
      <div className="field">
        <span className="field-label">
          Recall by meaning
          <ManagedBadge show={managed} />
        </span>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.memory.semanticRanking}
            disabled={managed}
            onChange={(e) => patchMemory({ semanticRanking: e.target.checked })}
          />
          Rank memories with an embedding model as well as by keywords
        </label>
        <span className="field-hint">
          Lets "how is your sister?" reach a memory that only ever says her name. Without an embedder nothing changes — memories are ranked by their words and
          tags as before.
        </span>
      </div>
      <div className="field">
        <label htmlFor="mem-embed-provider">Embeddings provider</label>
        <select
          id="mem-embed-provider"
          value={settings.memory.embeddingProviderId ?? ''}
          disabled={!settings.memory.semanticRanking}
          onChange={(e) => {
            setStatus(null);
            patchMemory({ embeddingProviderId: e.target.value || undefined });
          }}
        >
          <option value="">Default provider</option>
          {settings.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="field-hint">Anthropic serves no embeddings endpoint; point this at a local server (Ollama, LM Studio) or an OpenAI-compatible one.</span>
      </div>
      <div className="field">
        <label htmlFor="mem-embed-model">Embedding model</label>
        <input
          id="mem-embed-model"
          type="text"
          value={model}
          placeholder="nomic-embed-text"
          disabled={!settings.memory.semanticRanking}
          onChange={(e) => setModel(e.target.value)}
          onBlur={commitModel}
          onKeyDown={(e) => e.key === 'Enter' && commitModel()}
        />
        <span className="field-hint">
          <button type="button" className="btn btn-sm" onClick={() => void check()} disabled={checking || !settings.memory.semanticRanking}>
            {checking ? 'Checking…' : 'Check embedder'}
          </button>{' '}
          {status ? embeddingStatusText(status) : 'Changing the model re-embeds every memory in the background.'}
        </span>
      </div>
    </>
  );
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'general', label: 'General' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'senses', label: 'Senses' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'commands', label: 'Commands' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'browser', label: 'Browser' },
  { id: 'system', label: 'System' },
  { id: 'updates', label: 'Updates' },
  { id: 'display', label: 'Display' },
];

export function SettingsView() {
  const settings = useAppState((s) => s.settings);
  const requestedTab = useAppState((s) => s.settingsTab);
  const [tab, setTab] = useState<SettingsTab>('providers');
  // `openSettings(tab)` (e.g. a pack card's link to Permissions) asks for a tab; adopt it once and clear the request.
  useEffect(() => {
    if (!requestedTab) return;
    setTab(requestedTab);
    update((s) => ({ ...s, settingsTab: null }));
  }, [requestedTab]);
  const [editing, setEditing] = useState<{ config: ProviderConfig; isNew: boolean } | null>(null);
  const [removing, setRemoving] = useState<ProviderConfig | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<string | null>(null);
  const displayBackendManaged = useManaged('displayBackend');
  const memoryEnabledManaged = useManaged('memory.enabled');

  if (!settings) {
    return (
      <div className="view">
        <p className="muted">Settings unavailable.</p>
      </div>
    );
  }

  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...settings.runLimits };
  const patchLimits = (p: Partial<RunLimits>) => patchSettings({ runLimits: { ...limits, ...p } });

  const saveProvider = async (cfg: ProviderConfig) => {
    const exists = settings.providers.some((p) => p.id === cfg.id);
    const providers = exists ? settings.providers.map((p) => (p.id === cfg.id ? cfg : p)) : [...settings.providers, cfg];
    const patch: Partial<AppSettings> = { providers };
    if (!settings.defaultProviderId || !providers.some((p) => p.id === settings.defaultProviderId)) patch.defaultProviderId = cfg.id;
    if (await patchSettings(patch)) {
      setEditing(null);
      toast('success', `Saved ${cfg.label}`);
    }
  };

  const removeProvider = async (cfg: ProviderConfig) => {
    const providers = settings.providers.filter((p) => p.id !== cfg.id);
    const patch: Partial<AppSettings> = { providers };
    if (settings.defaultProviderId === cfg.id) patch.defaultProviderId = providers[0]?.id;
    setRemoving(null);
    await patchSettings(patch);
  };

  const newProvider = (): ProviderConfig => ({ id: newId('prov'), kind: 'anthropic', label: '', model: '' });

  return (
    <div className="view">
      <div className="view-header">
        <h1>Settings</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <section className="section" hidden={tab !== 'providers'}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 className="grow">LLM providers</h2>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ config: newProvider(), isNew: true })} disabled={editing !== null}>
            Add provider
          </button>
        </div>
        {settings.providers.length === 0 && !editing ? (
          <div className="callout callout-warning">
            No providers configured yet. Add one to start chatting — an Anthropic key, any OpenAI-compatible endpoint (Ollama, LM
            Studio, OpenRouter…) or the mock provider for testing.
          </div>
        ) : null}
        <div className="provider-list">
          {settings.providers.map((p) => (
            <div key={p.id} className="provider-row">
              <div className="item-text">
                <span className="item-title">
                  {p.label} {p.id === settings.defaultProviderId ? <span className="badge badge-accent">default</span> : null}
                </span>
                <span className="item-sub">
                  {p.kind} · {p.model || 'no model'}
                  {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                  {p.apiKey ? ` · key ${maskSecret(p.apiKey)}` : ''}
                </span>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setEditing({ config: p, isNew: false })} disabled={editing !== null}>
                Edit
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setRemoving(p)} disabled={editing !== null}>
                Remove
              </button>
            </div>
          ))}
        </div>
        {editing ? (
          <div style={{ marginTop: 10 }}>
            <ProviderEditor key={editing.config.id} initial={editing.config} isNew={editing.isNew} onSave={saveProvider} onCancel={() => setEditing(null)} />
          </div>
        ) : null}
        {settings.providers.length > 0 ? (
          <div className="field" style={{ marginTop: 12, maxWidth: 320 }}>
            <label htmlFor="default-provider">Default provider</label>
            <select id="default-provider" value={settings.defaultProviderId ?? ''} onChange={(e) => patchSettings({ defaultProviderId: e.target.value || undefined })}>
              <option value="">—</option>
              {settings.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      <section className="section" hidden={tab !== 'general'}>
        <h2>Conversation</h2>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="display-name">Your display name</label>
            <input
              id="display-name"
              type="text"
              value={name ?? settings.userDisplayName}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name !== null && name.trim() && name.trim() !== settings.userDisplayName) void patchSettings({ userDisplayName: name.trim() });
                setName(null);
              }}
            />
          </div>
          <NumberField
            id="max-rounds"
            label="Max action rounds per message"
            value={settings.maxActionRounds}
            min={1}
            hint="How many times the character may act and be called again for one of your messages."
            onCommit={(v) => patchSettings({ maxActionRounds: Math.round(v) })}
          />
          <NumberField
            id="max-repairs"
            label="Extra rounds to fix a failed action"
            value={settings.maxActionRepairs}
            min={-1}
            hint="Rounds granted on top of the limit above when an action fails in a way the character could fix by writing the code differently. The failure and how to correct it go back to it either way. 0 = none, -1 = as many as it takes."
            onCommit={(v) => patchSettings({ maxActionRepairs: Math.round(v) })}
          />
          <NumberField
            id="ctx-budget"
            label="Context token budget"
            value={settings.contextTokenBudget}
            min={1000}
            step={1000}
            hint="Approximate size of the whole request (system prompt plus transcript). The system prompt with all modules is about 10k tokens; leave the rest for conversation."
            onCommit={(v) => patchSettings({ contextTokenBudget: Math.round(v) })}
          />
          <div className="field">
            <span className="field-label">Tool calling</span>
            <label className="check">
              <input type="checkbox" checked={settings.useToolCalling} onChange={(e) => patchSettings({ useToolCalling: e.target.checked })} />
              Use native tool calling when the provider supports it
            </label>
            <span className="field-hint">Otherwise actions are exchanged as fenced ```action blocks.</span>
          </div>
          <div className="field">
            <span className="field-label">Debug</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.debug.showModelTraffic}
                onChange={(e) => patchSettings({ debug: { ...settings.debug, showModelTraffic: e.target.checked } })}
              />
              Show model traffic
            </label>
            <span className="field-hint">
              Capture every request and response sent to the model for the chat view (Model traffic button). Includes your full system
              prompt and messages; kept in memory only.
            </span>
          </div>
        </div>
      </section>

      <section className="section" hidden={tab !== 'general'}>
        <h2>Sandbox limits</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Apply to every code run by a character. Defaults are sensible; raise them only for packs you trust.
        </p>
        <div className="field-grid">
          <NumberField id="lim-timeout" label="Timeout (ms)" value={limits.timeoutMs} min={100} step={100} onCommit={(v) => patchLimits({ timeoutMs: v })} />
          <NumberField id="lim-cpu" label="CPU budget (ms)" value={limits.cpuMs} min={50} step={50} onCommit={(v) => patchLimits({ cpuMs: v })} />
          <NumberField
            id="lim-mem"
            label="Memory (MiB)"
            value={Math.round(limits.memoryBytes / (1024 * 1024))}
            min={8}
            onCommit={(v) => patchLimits({ memoryBytes: Math.round(v) * 1024 * 1024 })}
          />
          <NumberField id="lim-calls" label="Max SDK calls per run" value={limits.maxHostCalls} min={1} onCommit={(v) => patchLimits({ maxHostCalls: Math.round(v) })} />
          <NumberField
            id="lim-log"
            label="Max log output (KiB)"
            value={Math.round(limits.maxLogBytes / 1024)}
            min={1}
            onCommit={(v) => patchLimits({ maxLogBytes: Math.round(v) * 1024 })}
          />
          <NumberField
            id="lim-result"
            label="Max result size (KiB)"
            value={Math.round(limits.maxResultBytes / 1024)}
            min={1}
            onCommit={(v) => patchLimits({ maxResultBytes: Math.round(v) * 1024 })}
          />
        </div>
      </section>

      <section className="section" hidden={tab !== 'general'}>
        <h2>Autonomy</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Caps on self-triggered activity (timers, self-wakes, routines) so a character cannot run away.
        </p>
        <div className="field-grid">
          <NumberField id="au-wakes" label="Max self-wakes per hour" path="autonomy.maxSelfWakesPerHour" value={settings.autonomy.maxSelfWakesPerHour} min={0} onCommit={(v) => patchSettings({ autonomy: { ...settings.autonomy, maxSelfWakesPerHour: Math.round(v) } })} />
          <NumberField id="au-consec" label="Max consecutive self-wakes" path="autonomy.maxConsecutiveSelfWakes" value={settings.autonomy.maxConsecutiveSelfWakes} min={0} hint="Turns without a message from you in between." onCommit={(v) => patchSettings({ autonomy: { ...settings.autonomy, maxConsecutiveSelfWakes: Math.round(v) } })} />
          <NumberField id="au-timers" label="Max pending timers per session" path="autonomy.maxTimersPerSession" value={settings.autonomy.maxTimersPerSession} min={0} onCommit={(v) => patchSettings({ autonomy: { ...settings.autonomy, maxTimersPerSession: Math.round(v) } })} />
          <NumberField id="au-min-delay" label="Min timer / wake delay (seconds)" path="autonomy.minDelayMs" value={Math.round(settings.autonomy.minDelayMs / 1000)} min={1} hint="Shorter delays a character asks for are raised to this; the number is quoted in its instructions." onCommit={(v) => patchSettings({ autonomy: { ...settings.autonomy, minDelayMs: Math.max(1, Math.round(v)) * 1000 } })} />
          <NumberField id="au-repeat" label="Min repeat interval (seconds)" path="autonomy.minRepeatIntervalMs" value={Math.round(settings.autonomy.minRepeatIntervalMs / 1000)} min={1} onCommit={(v) => patchSettings({ autonomy: { ...settings.autonomy, minRepeatIntervalMs: Math.round(v) * 1000 } })} />
        </div>
      </section>

      <section className="section" hidden={tab !== 'general'}>
        <h2>Memory</h2>
        <div className="field-grid">
          <div className="field">
            <span className="field-label">
              Long-term memory
              <ManagedBadge show={memoryEnabledManaged} />
            </span>
            <label className="check">
              <input type="checkbox" checked={settings.memory.enabled} disabled={memoryEnabledManaged} onChange={(e) => patchSettings({ memory: { ...settings.memory, enabled: e.target.checked } })} />
              Consolidate memories automatically and inject them into prompts
            </label>
          </div>
          <NumberField id="mem-every" label="Consolidate every N turns" path="memory.consolidateEveryTurns" value={settings.memory.consolidateEveryTurns} min={1} onCommit={(v) => patchSettings({ memory: { ...settings.memory, consolidateEveryTurns: Math.round(v) } })} />
          <NumberField id="mem-max" label="Max memories per character" path="memory.maxEntriesPerCharacter" value={settings.memory.maxEntriesPerCharacter} min={10} step={10} onCommit={(v) => patchSettings({ memory: { ...settings.memory, maxEntriesPerCharacter: Math.round(v) } })} />
          <NumberField id="mem-budget" label="Prompt budget (tokens)" path="memory.promptBudgetTokens" value={settings.memory.promptBudgetTokens} min={100} step={100} onCommit={(v) => patchSettings({ memory: { ...settings.memory, promptBudgetTokens: Math.round(v) } })} />
          <SemanticMemoryFields settings={settings} />
        </div>
      </section>

      <section className="section" hidden={tab !== 'general'}>
        <h2>Conversation history</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>
          How a long conversation is kept inside the context window. Nothing is deleted: the chat view and storage always keep every
          message, this only shapes what is sent to the model.
        </p>
        <div className="field-grid">
          <div className="field">
            <span className="field-label">Background summarisation</span>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.history.compress}
                onChange={(e) => patchSettings({ history: { ...settings.history, compress: e.target.checked } })}
              />
              Replace the oldest messages with a rolling summary
            </label>
            <span className="field-hint">Written by the model after a turn, off the conversation, once the transcript grows past the threshold below.</span>
          </div>
          <NumberField
            id="hist-above"
            label="Summarise above (tokens)"
            path="history.compressAboveTokens"
            value={settings.history.compressAboveTokens}
            min={0}
            step={500}
            hint="Transcript size that triggers a summary. 0 (default) derives it from the context token budget, so it follows the model you use; a number here pins it instead."
            onCommit={(v) => patchSettings({ history: { ...settings.history, compressAboveTokens: Math.round(v) } })}
          />
          <NumberField
            id="hist-keep"
            label="Messages kept in full"
            path="history.keepRecentMessages"
            value={settings.history.keepRecentMessages}
            min={2}
            hint="The most recent messages, never summarised."
            onCommit={(v) => patchSettings({ history: { ...settings.history, keepRecentMessages: Math.round(v) } })}
          />
          <NumberField
            id="hist-budget"
            label="Summary budget (tokens)"
            path="history.summaryBudgetTokens"
            value={settings.history.summaryBudgetTokens}
            min={100}
            step={100}
            onCommit={(v) => patchSettings({ history: { ...settings.history, summaryBudgetTokens: Math.round(v) } })}
          />
          <NumberField
            id="hist-actions"
            label="Turns keeping action detail"
            path="history.keepActionDetailFor"
            value={settings.history.keepActionDetailFor}
            min={0}
            hint="Past turns send only their visible text; the code they ran and its results are left out. 0 (default) never re-sends past tool calls; raise it if your model needs to see recent actions. The current turn always sees its own."
            onCommit={(v) => patchSettings({ history: { ...settings.history, keepActionDetailFor: Math.round(v) } })}
          />
        </div>
      </section>

      <section className="section" hidden={tab !== 'general'}>
        <h2>Appearance & media</h2>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="theme">Theme</label>
            <select id="theme" value={settings.theme} onChange={(e) => patchSettings({ theme: e.target.value as AppSettings['theme'] })}>
              <option value="system">Follow system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="chat-zoom">Chat text size — {Math.round(settings.chatZoom * 100)}%</label>
            <input
              id="chat-zoom"
              type="range"
              min={CHAT_ZOOM_MIN}
              max={CHAT_ZOOM_MAX}
              step={CHAT_ZOOM_STEP}
              value={settings.chatZoom}
              onChange={(e) => void setChatZoom(Number(e.target.value))}
            />
            <span className="field-hint">
              Scales the messages and the message box only. <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> does the same from the chat.
            </span>
          </div>
          <div className="field">
            <span className="field-label">Media windows</span>
            <label className="check">
              <input type="checkbox" checked={settings.closeToTray} onChange={(e) => patchSettings({ closeToTray: e.target.checked })} />
              Closing the window keeps rpchat running in the tray (timers, self-wakes and the browser bridge stay active; quit from the tray menu)
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.mediaAlwaysOnTop} onChange={(e) => patchSettings({ mediaAlwaysOnTop: e.target.checked })} />
              Keep media windows above other windows
            </label>
            <span className="field-hint">Default overlay layer: above (top) or below (bottom) normal windows.</span>
          </div>
          <MediaLimitFields settings={settings} />
          <div className="field">
            <label htmlFor="display-backend">
              Display backend
              <ManagedBadge show={displayBackendManaged} />
            </label>
            <select
              id="display-backend"
              value={settings.displayBackend}
              disabled={displayBackendManaged}
              onChange={(e) => patchSettings({ displayBackend: e.target.value as AppSettings['displayBackend'] })}
            >
              <option value="auto">Auto (Hyprland when detected)</option>
              <option value="electron">Electron (generic)</option>
              <option value="hyprland">Hyprland IPC</option>
            </select>
            <span className="field-hint">Takes effect for overlays opened after the change.</span>
          </div>
        </div>
      </section>

      {tab === 'browser' ? (
        <section className="section">
          <h2>Browser extension</h2>
          <BrowserSection settings={settings} onPatch={patchSettings} />
        </section>
      ) : null}

      {tab === 'system' ? (
        <section className="section">
          <h2>System integration</h2>
          <SystemSection />
        </section>
      ) : null}

      {tab === 'system' ? (
        <section className="section">
          <h2>Encryption</h2>
          <EncryptionSection />
        </section>
      ) : null}

      {tab === 'updates' ? (
        <section className="section">
          <h2>Updates</h2>
          <UpdatesSection settings={settings} onPatch={patchSettings} />
        </section>
      ) : null}

      {tab === 'plugins' ? (
        <section className="section">
          <h2>Plugins</h2>
          <PluginsSection />
        </section>
      ) : null}

      {tab === 'display' ? (
        <section className="section">
          <h2>Display</h2>
          <DisplayInfo />
        </section>
      ) : null}

      {tab === 'permissions' ? (
        <section className="section">
          <h2>Permissions</h2>
          <PermissionsSection settings={settings} onPatch={patchSettings} />
        </section>
      ) : null}

      {tab === 'senses' ? (
        <section className="section">
          <h2>Senses</h2>
          <SensesSection settings={settings} onPatch={patchSettings} NumberField={NumberField} />
        </section>
      ) : null}

      {tab === 'integrations' ? (
        <section className="section">
          <h2>Integrations</h2>
          <IntegrationsSection settings={settings} onPatch={patchSettings} NumberField={NumberField} />
        </section>
      ) : null}

      <section className="section" hidden={tab !== 'commands'}>
        <h2>Commands</h2>
        <CommandsSection settings={settings} onPatch={patchSettings} />
        <div className="field-grid" style={{ marginTop: 14 }}>
          <NumberField
            id="max-input-lock"
            label="Max input lock (seconds)"
            path="maxInputLockMs"
            value={settings.maxInputLockMs === UNLIMITED ? UNLIMITED : Math.round(settings.maxInputLockMs / 1000)}
            min={1}
            hint="Hard cap for sdk.input.lock, whatever a character asks for."
            onCommit={(v) => patchSettings({ maxInputLockMs: Math.round(v) * 1000 })}
          />
          <div className="field">
            <label htmlFor="wallpaper-restore">Wallpaper to restore</label>
            <input
              id="wallpaper-restore"
              type="text"
              className="mono"
              value={restoreFile ?? settings.wallpaperRestoreFile}
              placeholder="/absolute/path/to/your/wallpaper.jpg"
              spellCheck={false}
              onChange={(e) => setRestoreFile(e.target.value)}
              onBlur={() => {
                if (restoreFile !== null && restoreFile.trim() !== settings.wallpaperRestoreFile) {
                  void patchSettings({ wallpaperRestoreFile: restoreFile.trim() });
                }
                setRestoreFile(null);
              }}
            />
            <span className="field-hint">Used by sdk.wallpaper.restore() after a character changed the wallpaper.</span>
          </div>
        </div>
      </section>

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          message="Sessions that override to this provider fall back to the default."
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => removeProvider(removing)}
        />
      ) : null}
    </div>
  );
}
