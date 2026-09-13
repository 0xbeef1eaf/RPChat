import { useState } from 'react';
import type { PackInspection } from '@rp/shared';
import { Markdown } from '../common/Markdown';
import { Modal } from '../common/Modal';
import { MediaSummary } from './MediaSummary';

interface InspectModalProps {
  sourcePath: string;
  inspection: PackInspection;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** What a pack contains, shown before it is installed. */
export function InspectModal({ sourcePath, inspection, onConfirm, onCancel }: InspectModalProps) {
  const [busy, setBusy] = useState(false);
  const [readme, setReadme] = useState(false);
  const m = inspection.manifest;

  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    setBusy(false);
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

      <p className="field-hint">
        Permissions are not part of a pack: what its character may do on this PC is what you allow for every character under
        Settings → Permissions.
      </p>

      <MediaSummary assetCounts={inspection.assetCounts} assetTags={inspection.assetTags} />

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
