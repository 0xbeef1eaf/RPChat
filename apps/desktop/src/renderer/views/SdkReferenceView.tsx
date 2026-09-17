import { useEffect, useState } from 'react';
import type { CapabilityInfo } from '@rp/shared';
import { api, errorMessage } from '../api';
import { useAppState } from '../store/store';

const PERMISSION_LABEL: Record<CapabilityInfo['permission'], { text: string; cls: string; hint: string }> = {
  trusted: { text: 'inside the app', cls: 'badge badge-success', hint: 'Effects stay inside the app. On unless switched off under Settings → Permissions.' },
  pack: { text: 'on unless switched off', cls: 'badge badge-accent', hint: 'Reaches outside the app. On for every character unless switched off under Settings → Permissions.' },
  prompt: { text: 'asks each call', cls: 'badge badge-warning', hint: 'On unless switched off under Settings → Permissions, and asks on every call.' },
};

export function SdkReferenceView() {
  const caps: CapabilityInfo[] | null = useAppState((s) => s.capabilities);
  const [typings, setTypings] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Typings follow the registry: re-fetch whenever the module list changes (e.g. plugins).
  useEffect(() => {
    api()
      .capabilities.typings()
      .then(setTypings)
      .catch((err) => setError(errorMessage(err)));
  }, [caps]);

  return (
    <div className="view">
      <div className="view-header">
        <h1>SDK reference</h1>
      </div>
      <p className="muted" style={{ marginBottom: 16, maxWidth: 720 }}>
        Characters act by writing TypeScript against this SDK. The code runs in a sandbox and can only reach your PC through the
        modules below. Every character gets every module unless you switch it off under Settings → Permissions. This is exactly
        what the model is shown.
      </p>
      {error ? <div className="callout callout-danger">{error}</div> : null}

      {caps ? (
        <section className="section">
          <h2>Capability modules</h2>
          <div className="cap-cards">
            {caps.map((c) => {
              const perm = PERMISSION_LABEL[c.permission];
              return (
                <div key={c.id} className="card cap-card">
                  <div className="row">
                    <h3 className="grow">
                      {c.title} <span className="muted mono small">sdk.{c.id}</span>
                    </h3>
                    <span className={perm.cls} title={perm.hint}>
                      {perm.text}
                    </span>
                  </div>
                  <p className="muted small">{c.summary}</p>
                  <ul>
                    {c.methods.map((m) => (
                      <li key={m.name}>
                        <code>{m.name}()</code>
                        {m.dangerous ? (
                          <span className="badge badge-danger" style={{ marginLeft: 6 }}>
                            dangerous
                          </span>
                        ) : null}{' '}
                        <span className="muted">{m.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {typings !== null ? (
        <section className="section">
          <h2>sdk.d.ts</h2>
          <pre className="typings">
            <code>{typings}</code>
          </pre>
        </section>
      ) : null}
    </div>
  );
}
