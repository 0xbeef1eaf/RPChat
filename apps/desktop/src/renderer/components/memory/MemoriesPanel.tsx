import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { MemoryEntry, MemoryImportance } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { formatDateTime, formatRelative } from '../../lib/format';
import { clampImportance, filterMemories, IMPORTANCE_LEVELS, parseTags, sortMemories } from '../../lib/memory';
import { closeMemories, reportError, toast } from '../../store/actions';
import { useAppState } from '../../store/store';
import { ConfirmDialog, Modal } from '../common/Modal';

/** Shortest query worth asking the engine to rank; below it the local filter is the whole answer. */
const SEMANTIC_QUERY_MIN = 3;

/** How many ranked hits to offer beside the filtered list, and how long to wait for typing to settle. */
const SEMANTIC_HITS = 5;
const SEMANTIC_DEBOUNCE_MS = 250;

const SOURCE_LABEL: Record<MemoryEntry['source'], { text: string; cls: string; hint: string }> = {
  character: { text: 'character', cls: 'badge badge-accent', hint: 'Remembered by the character during a chat' },
  consolidation: { text: 'auto', cls: 'badge', hint: 'Extracted automatically from a conversation' },
  user: { text: 'you', cls: 'badge badge-success', hint: 'Added by you' },
};

/** Modal listing and editing one character's long-term memories. */
export function MemoriesPanel() {
  const target = useAppState((s) => s.memoriesPanel);
  const characters = useAppState((s) => s.characters);
  const version = useAppState((s) => s.memoryVersion);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [related, setRelated] = useState<MemoryEntry[]>([]);
  const [forgetting, setForgetting] = useState<MemoryEntry | null>(null);
  const canForget = useAppState((x) => x.restrictions.allowDeleteMemories);
  const [consolidating, setConsolidating] = useState(false);

  const characterRef = target?.characterRef ?? null;
  const character = useMemo(() => characters.find((c) => c.ref === characterRef), [characters, characterRef]);

  const load = useCallback(async () => {
    if (!characterRef) return;
    try {
      setEntries(await api().memories.list(characterRef));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setEntries([]);
    }
  }, [characterRef]);

  useEffect(() => {
    setEntries(null);
    setQuery('');
    void load();
  }, [load]);

  // Re-fetch when the engine adds memories while the panel is open.
  useEffect(() => {
    if (version > 0) void load();
  }, [version, load]);

  const visible = useMemo(() => (entries ? sortMemories(filterMemories(entries, query)) : []), [entries, query]);

  // The box above filters on the words that are there; this asks the engine what is *about* the
  // same thing, which is the only way a memory that never says "sister" answers a search for one.
  useEffect(() => {
    const q = query.trim();
    if (!characterRef || q.length < SEMANTIC_QUERY_MIN) {
      setRelated([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api()
        .memories.search(characterRef, q, SEMANTIC_HITS)
        .then((hits) => {
          if (!cancelled) setRelated(hits);
        })
        .catch(() => {
          if (!cancelled) setRelated([]);
        });
    }, SEMANTIC_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [characterRef, query, version]);

  const alsoRelated = useMemo(() => {
    const shown = new Set(visible.map((e) => e.id));
    return related.filter((e) => !shown.has(e.id));
  }, [related, visible]);

  if (!target || !characterRef) return null;
  const name = character?.name ?? characterRef.split('/').pop() ?? 'Character';

  const replace = (entry: MemoryEntry) => {
    setEntries((list) => (list ? list.map((e) => (e.id === entry.id ? entry : e)) : list));
    setRelated((list) => list.map((e) => (e.id === entry.id ? entry : e)));
  };

  const save = async (entry: MemoryEntry) => {
    try {
      replace(await api().memories.update(entry));
    } catch (err) {
      reportError('Could not update memory', err);
      await load();
    }
  };

  const forget = async (entry: MemoryEntry) => {
    setForgetting(null);
    try {
      await api().memories.remove(entry.id);
      setEntries((list) => (list ? list.filter((e) => e.id !== entry.id) : list));
      setRelated((list) => list.filter((e) => e.id !== entry.id));
    } catch (err) {
      reportError('Could not forget memory', err);
    }
  };

  const add = async (text: string, tags: string[], importance: MemoryImportance) => {
    try {
      const entry = await api().memories.add(characterRef, text, { tags, importance });
      setEntries((list) => [entry, ...(list ?? [])]);
      return true;
    } catch (err) {
      reportError('Could not add memory', err);
      return false;
    }
  };

  const consolidate = async () => {
    if (!target.sessionId) return;
    setConsolidating(true);
    try {
      const added = await api().memories.consolidate(target.sessionId);
      toast('success', added.length === 0 ? 'Nothing new to remember' : `Remembered ${added.length} new thing${added.length === 1 ? '' : 's'}`);
      await load();
    } catch (err) {
      reportError('Consolidation failed', err);
    } finally {
      setConsolidating(false);
    }
  };

  return (
    <Modal title={`${name}'s memories`} onClose={closeMemories}>
      <p className="muted small">
        What {name} remembers about you across sessions. Memories are ranked into the prompt by importance, recency and how closely they
        match the conversation — in wording and, with an embedder configured, in meaning. Edit or forget anything here.
      </p>
      <div className="row">
        <input
          type="text"
          placeholder="Search text or #tag"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search memories"
        />
        {target.sessionId ? (
          <button type="button" className="btn btn-sm nowrap" onClick={consolidate} disabled={consolidating} title="Extract new memories from the current session now">
            {consolidating ? 'Consolidating…' : 'Consolidate now'}
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={closeMemories}>
          Close
        </button>
      </div>
      <AddMemoryForm onAdd={add} />
      {error ? <div className="callout callout-danger small">{error}</div> : null}
      {entries === null ? (
        <div className="row muted small">
          <span className="spinner" /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <p className="muted">Nothing remembered yet. Memories form as you chat, or add one above.</p>
      ) : visible.length === 0 && alsoRelated.length === 0 ? (
        <p className="muted">No memories match “{query}”.</p>
      ) : (
        <div className="memory-list">
          {visible.map((e) => (
            <MemoryRow key={e.id} entry={e} onSave={save} onForget={canForget ? () => setForgetting(e) : undefined} />
          ))}
          {alsoRelated.length > 0 ? (
            <>
              <p className="muted small">Not a word match, but about the same thing:</p>
              {alsoRelated.map((e) => (
                <MemoryRow key={e.id} entry={e} onSave={save} onForget={canForget ? () => setForgetting(e) : undefined} />
              ))}
            </>
          ) : null}
          <p className="muted small">
            {visible.length} of {entries.length}
          </p>
        </div>
      )}
      {forgetting ? (
        <ConfirmDialog
          title="Forget this memory?"
          message={<em>“{forgetting.text}”</em>}
          confirmLabel="Forget"
          danger
          onCancel={() => setForgetting(null)}
          onConfirm={() => forget(forgetting)}
        />
      ) : null}
    </Modal>
  );
}

function Stars({ value, onChange, label }: { value: MemoryImportance; onChange: (v: MemoryImportance) => void; label: string }) {
  return (
    <span className="stars" role="radiogroup" aria-label={label}>
      {IMPORTANCE_LEVELS.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === value}
          aria-label={`${n} of 5`}
          className={n <= value ? 'star on' : 'star'}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </span>
  );
}

function TagChips({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');
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
          #{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        className="chip-input"
        value={draft}
        placeholder={tags.length === 0 ? 'add tag' : '+'}
        aria-label="Add tag"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
    </span>
  );
}

function MemoryRow({ entry, onSave, onForget }: { entry: MemoryEntry; onSave: (e: MemoryEntry) => Promise<void>; /** Omitted while the policy forbids deleting memories. */ onForget?: (() => void) | undefined }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const src = SOURCE_LABEL[entry.source] ?? SOURCE_LABEL.character;

  const commitText = async () => {
    const t = text.trim();
    setEditing(false);
    if (!t || t === entry.text) {
      setText(entry.text);
      return;
    }
    await onSave({ ...entry, text: t });
  };

  return (
    <div className="memory">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          {editing ? (
            <textarea
              value={text}
              autoFocus
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void commitText();
                } else if (e.key === 'Escape') {
                  setText(entry.text);
                  setEditing(false);
                }
              }}
              onBlur={commitText}
            />
          ) : (
            <button type="button" className="memory-text" onClick={() => setEditing(true)} title="Click to edit">
              {entry.text}
            </button>
          )}
        </div>
        <span className={src.cls} title={src.hint}>
          {src.text}
        </span>
      </div>
      <div className="row wrap small" style={{ gap: 10 }}>
        <Stars value={clampImportance(entry.importance)} label="Importance" onChange={(importance) => onSave({ ...entry, importance })} />
        <TagChips tags={entry.tags} onChange={(tags) => onSave({ ...entry, tags })} />
        <span className="grow" />
        <span className="muted nowrap" title={`Created ${formatDateTime(entry.createdAt)}${entry.lastRecalledAt ? `, last recalled ${formatDateTime(entry.lastRecalledAt)}` : ''}`}>
          {formatRelative(entry.createdAt)}
          {entry.recallCount > 0 ? ` · recalled ${entry.recallCount}×` : ''}
        </span>
        {onForget ? (
  <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={onForget}>
            Forget
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AddMemoryForm({ onAdd }: { onAdd: (text: string, tags: string[], importance: MemoryImportance) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [importance, setImportance] = useState<MemoryImportance>(3);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <div>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          Add memory
        </button>
      </div>
    );
  }

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    const ok = await onAdd(t, tags, importance);
    setBusy(false);
    if (ok) {
      setText('');
      setTags([]);
      setImportance(3);
      setOpen(false);
    }
  };

  return (
    <div className="card stack" style={{ padding: '10px 12px' }}>
      <div className="field">
        <label htmlFor="mem-text">New memory (in the character's voice)</label>
        <textarea
          id="mem-text"
          value={text}
          maxLength={500}
          placeholder="e.g. They take their coffee black and hate mornings."
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Stars value={importance} label="Importance" onChange={setImportance} />
        <TagChips tags={tags} onChange={setTags} />
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={submit} disabled={busy || !text.trim()}>
          Remember
        </button>
      </div>
    </div>
  );
}
