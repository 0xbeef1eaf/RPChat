import { useState } from 'react';
import type { AppSettings, MessagingChannel } from '@rp/shared';
import { StringListEditor } from '../common/StringListEditor';

interface IntegrationsSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
  NumberField: (props: { id: string; label: string; value: number; hint?: string; min?: number; step?: number; onCommit: (v: number) => void }) => React.JSX.Element;
}

const KINDS: Array<{ value: MessagingChannel['kind']; label: string; hint: string }> = [
  { value: 'discord', label: 'Discord webhook', hint: 'Webhook URL from the channel settings.' },
  { value: 'slack', label: 'Slack webhook', hint: 'Incoming webhook URL.' },
  { value: 'telegram', label: 'Telegram bot', hint: 'https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>' },
  { value: 'generic-json', label: 'Generic JSON POST', hint: 'POSTs {"text": …} to the URL.' },
  { value: 'command', label: 'Command', hint: 'Runs a command template with {text} and {channel}.' },
];

export function IntegrationsSection({ settings, onPatch, NumberField }: IntegrationsSectionProps) {
  const web = settings.web;
  const desktop = settings.desktop;
  const channels = settings.messaging?.channels ?? [];

  return (
    <div className="stack" style={{ gap: 22 }}>
      <section>
        <h3>Web access</h3>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Hostnames <code>sdk.web.fetch</code> / <code>rss</code> may reach without asking you each time (<code>example.com</code> or{' '}
          <code>*.example.com</code>). Leave it empty to allow any site. Weather (open-meteo) is always allowed.
        </p>
        <div className="field-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="web-allow">Allowlist</label>
            <StringListEditor id="web-allow" values={web.allowlist} placeholder="*.wikipedia.org" onChange={(allowlist) => onPatch({ web: { ...web, allowlist } })} />
          </div>
          <NumberField id="web-max" label="Max response size (KiB)" value={Math.round(web.maxBytes / 1024)} min={16} onCommit={(v) => onPatch({ web: { ...web, maxBytes: Math.round(v) * 1024 } })} />
        </div>
      </section>

      <section>
        <h3>Desktop launch allowlist</h3>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Executable names <code>sdk.desktop.launch</code> may start. Leave it empty to allow any app.
        </p>
        <StringListEditor id="launch-allow" values={desktop.launchAllowlist} placeholder="firefox" onChange={(launchAllowlist) => onPatch({ desktop: { ...desktop, launchAllowlist } })} />
      </section>

      <section>
        <h3>Messaging channels</h3>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Where <code>sdk.messaging.send(channel, text)</code> can deliver. Sending is marked dangerous and audited.
        </p>
        <ChannelsEditor channels={channels} onChange={(list) => onPatch({ messaging: { ...settings.messaging, channels: list } })} />
      </section>
    </div>
  );
}

function ChannelsEditor({ channels, onChange }: { channels: MessagingChannel[]; onChange: (c: MessagingChannel[]) => Promise<boolean> }) {
  const [editing, setEditing] = useState<MessagingChannel | null>(null);
  const [isNew, setIsNew] = useState(false);

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    const clean: MessagingChannel = { name, kind: editing.kind };
    if (editing.kind === 'command') clean.command = { command: editing.command?.command ?? '', shell: editing.command?.shell || undefined };
    else if (editing.url?.trim()) clean.url = editing.url.trim();
    const next = isNew ? [...channels.filter((c) => c.name !== name), clean] : channels.map((c) => (c.name === editing.name ? clean : c));
    if (await onChange(next)) setEditing(null);
  };

  return (
    <div className="stack">
      {channels.length === 0 && !editing ? <span className="muted small">No channels configured.</span> : null}
      {channels.map((c) => (
        <div key={c.name} className="provider-row">
          <div className="item-text">
            <span className="item-title">{c.name}</span>
            <span className="item-sub">
              {c.kind}
              {c.url ? ` · ${c.url.replace(/(bot)[^/]+/, '$1…')}` : ''}
              {c.command ? ` · ${c.command.command}` : ''}
            </span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => (setEditing({ ...c }), setIsNew(false))} disabled={editing !== null}>
            Edit
          </button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onChange(channels.filter((x) => x.name !== c.name))} disabled={editing !== null}>
            Remove
          </button>
        </div>
      ))}
      {editing ? (
        <div className="card stack" style={{ padding: '10px 12px' }}>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="ch-name">Name</label>
              <input id="ch-name" type="text" value={editing.name} disabled={!isNew} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ch-kind">Kind</label>
              <select id="ch-kind" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as MessagingChannel['kind'] })}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <span className="field-hint">{KINDS.find((k) => k.value === editing.kind)?.hint}</span>
            </div>
            {editing.kind === 'command' ? (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="ch-cmd">Command</label>
                <input
                  id="ch-cmd"
                  type="text"
                  className="mono"
                  value={editing.command?.command ?? ''}
                  placeholder='notify-send "{channel}" "{text}"'
                  onChange={(e) => setEditing({ ...editing, command: { ...editing.command, command: e.target.value } })}
                />
                <label className="check small">
                  <input type="checkbox" checked={Boolean(editing.command?.shell)} onChange={(e) => setEditing({ ...editing, command: { command: editing.command?.command ?? '', shell: e.target.checked } })} />
                  Run through the platform shell
                </label>
              </div>
            ) : (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="ch-url">URL</label>
                <input id="ch-url" type="url" className="mono" value={editing.url ?? ''} placeholder="https://…" onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
              </div>
            )}
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!editing.name.trim()}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => (setEditing({ name: '', kind: 'discord' }), setIsNew(true))}>
            Add channel
          </button>
        </div>
      )}
    </div>
  );
}
