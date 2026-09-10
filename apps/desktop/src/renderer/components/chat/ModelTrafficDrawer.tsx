import { useState } from 'react';
import type { ContentPart, LlmMessage, ModelExchange } from '@rp/shared';
import { formatBytes, formatDuration, formatTime, prettyJson } from '../../lib/format';
import { clearModelTraffic, reportError, toast } from '../../store/actions';
import { runtimeFor } from '../../store/state';
import { useAppState } from '../../store/store';

interface ModelTrafficDrawerProps {
  sessionId: string;
  onClose: () => void;
}

const KIND_LABEL: Record<ModelExchange['kind'], string> = { turn: 'turn', 'llm.ask': 'llm.ask', memory: 'memory', history: 'history' };

function kindLabel(x: ModelExchange): string {
  return x.kind === 'turn' && x.round !== undefined ? `turn · round ${x.round}` : KIND_LABEL[x.kind];
}

function tokens(x: ModelExchange): string {
  if (!x.response) return '';
  return `${x.response.usage.inputTokens}↑ ${x.response.usage.outputTokens}↓`;
}

async function copy(label: string, value: unknown): Promise<void> {
  try {
    await navigator.clipboard.writeText(prettyJson(value));
    toast('success', `Copied ${label}`);
  } catch (err) {
    reportError(`Could not copy ${label}`, err);
  }
}

/** One content part of a request or response message, rendered by type. Nothing is truncated. */
function Part({ part }: { part: ContentPart }) {
  switch (part.type) {
    case 'text':
      return (
        <pre className="traffic-pre">
          <code>{part.text}</code>
        </pre>
      );
    case 'tool_use':
      return (
        <pre className="traffic-pre">
          <code>
            {part.name}({prettyJson(part.input)})
          </code>
        </pre>
      );
    case 'tool_result': {
      let body: string;
      try {
        body = prettyJson(JSON.parse(part.content));
      } catch {
        body = part.content;
      }
      return (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row small">
            <span className="muted mono">→ result for {part.toolUseId}</span>
            {part.isError ? <span className="badge badge-danger">error</span> : null}
          </div>
          <pre className="traffic-pre">
            <code>{body}</code>
          </pre>
        </div>
      );
    }
    case 'image':
      return (
        <div className="muted small mono">
          [image {part.mime}, {formatBytes(Math.floor((part.data.length * 3) / 4))}]
        </div>
      );
    default:
      return null;
  }
}

function MessageBlock({ message }: { message: LlmMessage }) {
  return (
    <div className="traffic-message">
      <div className={`traffic-role traffic-role-${message.role}`}>{message.role}</div>
      <div className="stack" style={{ gap: 6 }}>
        {message.content.map((part, i) => (
          <Part key={i} part={part} />
        ))}
      </div>
    </div>
  );
}

function Section({ title, children, open }: { title: React.ReactNode; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="action traffic-section" open={open}>
      <summary>
        <span className="action-purpose">{title}</span>
      </summary>
      <div className="action-body">{children}</div>
    </details>
  );
}

function ExchangeDetails({ x }: { x: ModelExchange }) {
  const r = x.request;
  const stable = r.systemStablePrefixChars;
  return (
    <div className="stack traffic-details" style={{ gap: 6 }}>
      <div className="row wrap small muted" style={{ gap: 10 }}>
        <span>
          provider <strong>{r.provider}</strong> · model <strong>{r.model}</strong>
        </span>
        {r.temperature !== undefined ? <span>temperature {r.temperature}</span> : null}
        {r.maxTokens !== undefined ? <span>max tokens {r.maxTokens}</span> : null}
        {x.turnId ? <span className="mono">turn {x.turnId.slice(0, 8)}</span> : null}
        {x.messageId ? <span className="mono">message {x.messageId.slice(0, 8)}</span> : null}
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={() => void copy('request JSON', r)}>
          Copy request JSON
        </button>
        <button type="button" className="btn btn-sm" disabled={!x.response} onClick={() => void copy('response JSON', x.response)}>
          Copy response JSON
        </button>
      </div>
      <Section
        title={
          <>
            System prompt{' '}
            <span className="muted">
              ({r.system.length.toLocaleString()} chars
              {stable !== undefined ? `, stable prefix ${stable.toLocaleString()} chars` : ''})
            </span>
          </>
        }
      >
        {stable !== undefined ? (
          <p className="muted small">
            The first {stable.toLocaleString()} characters are identical from turn to turn (rules, persona, pack, SDK reference) and are
            marked cacheable for providers with prompt caching; the rest (memory, mood, time, state) is sent uncached.
          </p>
        ) : null}
        <pre className="traffic-pre">
          <code>{r.system}</code>
        </pre>
      </Section>
      <Section
        title={
          <>
            Messages <span className="muted">({r.messages.length})</span>
          </>
        }
      >
        <div className="stack" style={{ gap: 8 }}>
          {r.messages.map((m, i) => (
            <MessageBlock key={i} message={m} />
          ))}
        </div>
      </Section>
      {r.tools ? (
        <Section
          title={
            <>
              Tools <span className="muted">({r.tools.map((t) => t.name).join(', ')})</span>
            </>
          }
        >
          <pre className="traffic-pre">
            <code>{prettyJson(r.tools)}</code>
          </pre>
        </Section>
      ) : null}
      {x.response ? (
        <Section
          open
          title={
            <>
              Response <span className="muted">(stop: {x.response.stopReason}, {tokens(x)}, {x.response.model})</span>
            </>
          }
        >
          <MessageBlock message={x.response.message} />
        </Section>
      ) : null}
      {x.error ? (
        <div className="callout callout-danger small">
          <div>
            <strong>{x.error.code}</strong> — {x.error.message}
          </div>
          {x.error.stack ? (
            <pre className="traffic-pre" style={{ marginTop: 6 }}>
              <code>{x.error.stack}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Every request sent to the model for the session and what came back (`settings.debug.showModelTraffic`). */
export function ModelTrafficDrawer({ sessionId, onClose }: ModelTrafficDrawerProps) {
  const exchanges = useAppState((s) => runtimeFor(s, sessionId).exchanges);
  const [openId, setOpenId] = useState<string | null>(null);
  const newestFirst = exchanges.slice().reverse();

  return (
    <div className="session-panel">
      <div className="session-panel-inner">
        <div className="row">
          <h3 className="grow">Model traffic</h3>
          <button type="button" className="btn btn-sm" onClick={() => clearModelTraffic(sessionId)} disabled={exchanges.length === 0}>
            Clear
          </button>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted small">
          Every request this session sent to the model (chat turn rounds, <code>sdk.llm.ask</code>, memory extraction) with the full system
          prompt, messages, tools and the response. Kept in memory only; the last 40 are shown, newest first.
        </p>
        {newestFirst.length === 0 ? (
          <p className="muted small">Nothing captured yet. Send a message to see the next request.</p>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {newestFirst.map((x) => {
              const open = openId === x.id;
              return (
                <div key={x.id} className="cap-row traffic-row" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
                  <button type="button" className="traffic-summary row wrap" onClick={() => setOpenId(open ? null : x.id)} aria-expanded={open}>
                    <span className="mono muted">{formatTime(x.startedAt)}</span>
                    <span className="badge">{kindLabel(x)}</span>
                    <span className="mono">{x.request.model}</span>
                    {x.response ? <span className="muted">stop: {x.response.stopReason}</span> : null}
                    {x.response ? <span className="mono muted">{tokens(x)}</span> : null}
                    {x.durationMs !== undefined ? <span className="muted nowrap">{formatDuration(x.durationMs)}</span> : null}
                    {x.error ? <span className="badge badge-danger">error</span> : null}
                    {!x.response && !x.error ? (
                      <span className="badge badge-accent row">
                        <span className="spinner" /> pending
                      </span>
                    ) : null}
                  </button>
                  {open ? <ExchangeDetails x={x} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
