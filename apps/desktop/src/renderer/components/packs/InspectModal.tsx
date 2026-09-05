import { useState } from 'react';
import type { CapabilityInfo, PackInspection } from '@rp/shared';
import { Markdown } from '../common/Markdown';
import { Modal } from '../common/Modal';

interface InspectModalProps {
  sourcePath: string;
  inspection: PackInspection;
  capabilities: Map<string, CapabilityInfo>;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** What a pack asks for, shown before it is installed. */
export function InspectModal({ sourcePath, inspection, capabilities, onConfirm, onCancel }: InspectModalProps) {
  const [busy, setBusy] = useState(false);
  const [readme, setReadme] = useState(false);
  const m = inspection.manifest;
  const assets = Object.entries(inspection.assetCounts).filter(([, n]) => n > 0);

  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    setBusy(false);
  };

  const capRow = (id: string, cls: string, label: string) => {
    const info = capabilities.get(id);
    return (
      <div key={id} className="cap-row">
        <div className="item-text">
          <span className="item-title">
            {info?.title ?? id} <span className="muted mono small">{id}</span>
            {info?.methods.some((x) => x.dangerous) ? <span className="badge badge-danger" style={{ marginLeft: 6 }}>dangerous</span> : null}
          </span>
          {info?.summary ? <span className="item-sub">{info.summary}</span> : null}
        </div>
        <span className={cls}>{label}</span>
      </div>
    );
  };

  return (
    <Modal title={`Install ${m.name}?`} onClose={busy ? undefined : onCancel}>
      <div className="pack-title">
        <span className="badge">{m.version}</span>
        <span className="muted small mono">{m.id}</span>
        {m.author ? <span className="muted small">by {m.author.name}</span> : null}
        {m.license ? <span className="muted small">{m.license}</span> : null}
      </div>
      {m.description ? <p>{m.description}</p> : null}
      <p className="muted small mono" style={{ overflowWrap: 'anywhere' }}>
        {sourcePath}
      </p>

      <div>
        <div className="field-label">Characters</div>
        {inspection.characters.length === 0 ? <span className="muted small">none</span> : null}
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {inspection.characters.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>
              {c.tagline ? <span className="muted"> — {c.tagline}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="field-label">Capabilities it asks for</div>
        {inspection.requestedCapabilities.length === 0 ? <span className="muted small">Only trusted capabilities.</span> : null}
        <div className="cap-list" style={{ marginTop: 4 }}>
          {inspection.allowedByPolicy.map((id) => capRow(id, 'badge badge-success', 'will be granted'))}
          {inspection.blockedByPolicy.map((id) => capRow(id, 'badge badge-warning', 'blocked by your policy'))}
          {inspection.unknownCapabilities.map((id) => capRow(id, 'badge badge-danger', 'unknown to this app'))}
        </div>
        {inspection.blockedByPolicy.length > 0 ? (
          <p className="field-hint" style={{ marginTop: 6 }}>
            Blocked modules stay off until you allow them in Settings → Permissions; the pack still installs.
          </p>
        ) : null}
      </div>

      {assets.length > 0 ? (
        <div className="muted small">
          Assets: {assets.map(([k, n]) => `${n} ${k}`).join(', ')}
        </div>
      ) : null}

      {inspection.readme ? (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setReadme((v) => !v)} aria-expanded={readme}>
            {readme ? 'Hide README' : 'Show README'}
          </button>
          {readme ? (
            <div className="readme">
              <Markdown source={inspection.readme} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={confirm} disabled={busy}>
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>
    </Modal>
  );
}
