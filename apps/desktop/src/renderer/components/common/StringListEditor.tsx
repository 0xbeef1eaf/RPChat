import { useState } from 'react';

interface StringListEditorProps {
  id: string;
  values: string[];
  placeholder?: string;
  addLabel?: string;
  mono?: boolean;
  disabled?: boolean;
  onChange: (values: string[]) => void;
}

/** Small add/remove list for allowlists, paths and URLs. */
export function StringListEditor({ id, values, placeholder, addLabel = 'Add', mono = true, disabled = false, onChange }: StringListEditorProps) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {values.length === 0 ? <span className="muted small">Nothing yet.</span> : null}
      {values.map((v) => (
        <div key={v} className="row list-row">
          <span className={mono ? 'mono grow' : 'grow'} style={{ overflowWrap: 'anywhere' }}>
            {v}
          </span>
          <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${v}`} disabled={disabled} onClick={() => onChange(values.filter((x) => x !== v))}>
            ×
          </button>
        </div>
      ))}
      <div className="input-with-btn">
        <input
          id={id}
          type="text"
          className={mono ? 'mono' : undefined}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={disabled || !draft.trim()}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
