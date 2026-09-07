import { useState } from 'react';

interface SaveBarProps {
  dirty: boolean;
  onSave: () => Promise<boolean>;
  onDiscard?: () => void;
  label?: string;
}

export function SaveBar({ dirty, onSave, onDiscard, label = 'Save' }: SaveBarProps) {
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await onSave();
    setBusy(false);
  };
  return (
    <div className="save-bar">
      <span className="muted small">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <span className="grow" />
      {onDiscard ? (
        <button type="button" className="btn btn-sm" onClick={onDiscard} disabled={!dirty || busy}>
          Discard
        </button>
      ) : null}
      <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={!dirty || busy} title="Ctrl/Cmd+S">
        {busy ? 'Saving…' : label}
      </button>
    </div>
  );
}
