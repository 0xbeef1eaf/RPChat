import { useState } from 'react';
import type { AppSettings, MessagingChannel, TelegramChat } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { channelForEditing, channelForSaving, channelSummary } from '../../lib/messaging';
import { StringListEditor } from '../common/StringListEditor';
import { ManagedBadge, useManaged } from './Managed';

interface IntegrationsSectionProps {
  settings: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => Promise<boolean>;
  NumberField: (props: { id: string; label: string; value: number; hint?: string; min?: number; step?: number; path?: string; onCommit: (v: number) => void }) => React.JSX.Element;
}

const KINDS: Array<{ value: MessagingChannel['kind']; label: string; hint: string }> = [
  { value: 'discord', label: 'Discord webhook', hint: 'Webhook URL from the channel settings.' },
  { value: 'slack', label: 'Slack webhook', hint: 'Incoming webhook URL.' },
  { value: 'telegram', label: 'Telegram bot', hint: 'The bot token from @BotFather, plus the chat to send to.' },
  { value: 'generic-json', label: 'Generic JSON POST', hint: 'POSTs {"text": …} to the URL.' },
  { value: 'command', label: 'Command', hint: 'Runs a command template with {text} and {channel}.' },
];

export function IntegrationsSection({ settings, onPatch, NumberField }: IntegrationsSectionProps) {
  const web = settings.web;
  const desktop = settings.desktop;
  const channels = settings.messaging?.channels ?? [];
  const webManaged = useManaged('web.allowlist');
  const launchManaged = useManaged('desktop.launchAllowlist');

  return (
    <div className="stack" style={{ gap: 22 }}>
      <section>
        <h3>Web access</h3>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Hostnames <code>sdk.web.fetch</code> / <code>rss</code> may reach (<code>example.com</code> or <code>*.example.com</code>). Leave it
          empty to allow any http(s) site; with entries, other hosts fail with PERMISSION_DENIED and the character is told to ask you.
          Weather (open-meteo) is always allowed.
        </p>
        <div className="field-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="web-allow">
              Allowlist
              <ManagedBadge show={webManaged} />
            </label>
            <StringListEditor id="web-allow" values={web.allowlist} disabled={webManaged} placeholder="*.wikipedia.org" onChange={(allowlist) => onPatch({ web: { ...web, allowlist } })} />
          </div>
          <NumberField id="web-max" label="Max response size (KiB)" path="web.maxBytes" value={Math.round(web.maxBytes / 1024)} min={16} onCommit={(v) => onPatch({ web: { ...web, maxBytes: Math.round(v) * 1024 } })} />
        </div>
      </section>

      <section>
        <h3>Desktop launch allowlist</h3>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Executable names <code>sdk.desktop.launch</code> may start. Leave it empty to allow any app; with entries, other apps fail with
          PERMISSION_DENIED and the character is told to ask you.
        </p>
        <StringListEditor id="launch-allow" values={desktop.launchAllowlist} placeholder="firefox" onChange={(launchAllowlist) => onPatch({ desktop: { ...desktop, launchAllowlist } })} />
      </section>

      <section>
        <h3>Messaging channels</h3>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Where <code>sdk.messaging.send(channel, text)</code> can deliver. Sending is marked dangerous and audited; without channels the
          character gets a NOT_FOUND error pointing here.
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
    const clean = channelForSaving(editing);
    if (!clean.name) return;
    const next = isNew ? [...channels.filter((c) => c.name !== clean.name), clean] : channels.map((c) => (c.name === editing.name ? clean : c));
    if (await onChange(next)) setEditing(null);
  };

  return (
    <div className="stack">
      {channels.length === 0 && !editing ? <span className="muted small">No channels configured.</span> : null}
      {channels.map((c) => (
        <div key={c.name} className="provider-row">
          <div className="item-text">
            <span className="item-title">{c.name}</span>
            <span className="item-sub">{channelSummary(c)}</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => (setEditing(channelForEditing(c)), setIsNew(false))} disabled={editing !== null}>
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
            ) : editing.kind === 'telegram' ? (
              <TelegramFields channel={editing} onChange={setEditing} />
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

/**
 * Token and recipient for a Telegram bot. Telegram will not tell a bot which chats exist, so the
 * chat id only becomes knowable once someone has written to the bot: "Find chats" asks the bot for
 * its recent updates and offers whatever chats turn up.
 */
function TelegramFields({ channel, onChange }: { channel: MessagingChannel; onChange: (c: MessagingChannel) => void }) {
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chats, setChats] = useState<TelegramChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = channel.token ?? '';

  const findChats = async () => {
    setBusy(true);
    setError(null);
    setChats(null);
    try {
      setChats(await api().settings.telegramChats(token));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="field" style={{ gridColumn: '1 / -1' }}>
        <label htmlFor="ch-token">Bot token</label>
        <div className="input-with-btn">
          <input
            id="ch-token"
            type={showToken ? 'text' : 'password'}
            className="mono"
            autoComplete="off"
            value={token}
            placeholder="123456789:AAE…"
            onChange={(e) => onChange({ ...channel, token: e.target.value })}
          />
          <button type="button" className="btn btn-sm" onClick={() => setShowToken((v) => !v)} aria-pressed={showToken}>
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className="field-hint">
          Message <code>@BotFather</code> on Telegram, send <code>/newbot</code>, and it replies with this token.
        </span>
      </div>
      <div className="field" style={{ gridColumn: '1 / -1' }}>
        <label htmlFor="ch-chat">Send to (chat id)</label>
        <div className="input-with-btn">
          <input
            id="ch-chat"
            type="text"
            className="mono"
            value={channel.chatId ?? ''}
            placeholder="123456789 or @mychannel"
            onChange={(e) => onChange({ ...channel, chatId: e.target.value })}
          />
          <button type="button" className="btn btn-sm" onClick={findChats} disabled={busy || !token.trim()}>
            {busy ? 'Looking…' : 'Find chats'}
          </button>
        </div>
        <span className="field-hint">
          Your own chat with the bot, a group it was added to, or <code>@name</code> for a public channel. Say hello to the bot in Telegram
          first, then press Find chats — a bot cannot see a chat that has never written to it.
        </span>
        {error ? <div className="callout callout-danger">{error}</div> : null}
        {chats ? (
          chats.length === 0 ? (
            <span className="field-hint">
              No chats yet. Open Telegram, send the bot any message (or add it to the group and post there), then try again.
            </span>
          ) : (
            <div className="stack" style={{ gap: 4, marginTop: 4 }}>
              {chats.map((c) => (
                <button key={c.id} type="button" className="btn btn-sm" onClick={() => onChange({ ...channel, chatId: c.id })}>
                  {c.title} · {c.type} · <span className="mono">{c.id}</span>
                </button>
              ))}
            </div>
          )
        ) : null}
      </div>
    </>
  );
}
