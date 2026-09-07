import { useId, useState, type KeyboardEvent } from 'react';
import { parseTags } from '../../lib/memory';

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  'aria-label'?: string;
}

/** Chips input with datalist suggestions; Enter/comma adds, Backspace on empty removes the last. */
export function TagInput({ tags, onChange, suggestions = [], placeholder = 'add tag', 'aria-label': ariaLabel }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const commit = () => {
    const extra = parseTags(draft).filter((t) => !tags.includes(t));
    if (extra.length > 0) onChange([...tags, ...extra]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };
  return (
    <span className="chips">
      {tags.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        className="chip-input"
        list={suggestions.length ? listId : undefined}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel ?? 'Add tag'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
      {suggestions.length ? (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      ) : null}
    </span>
  );
}
