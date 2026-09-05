import { useCallback, useEffect, useState } from 'react';
import type { MoodState, RoutineEntry, RoutineStatus } from '@rp/shared';
import { api } from '../../api';
import { describeMood, describeRoutine, energyWord, moodGlyph, moodWord } from '../../lib/mood';
import { useAppState } from '../../store/store';

interface CharacterStatusProps {
  characterRef: string;
}

const ROUTINE_CLS: Record<RoutineStatus['state'], string> = {
  available: 'badge badge-success',
  busy: 'badge badge-warning',
  away: 'badge',
  asleep: 'badge',
};

/** Mood, energy and routine state for the chat header; re-fetched on mood/routine events. */
export function CharacterStatus({ characterRef }: CharacterStatusProps) {
  const version = useAppState((s) => s.characterStatusVersion[characterRef] ?? 0);
  const [status, setStatus] = useState<{ mood: MoodState; routine: RoutineStatus; routineEntries: RoutineEntry[] } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api().characters.status(characterRef));
      setFailed(false);
    } catch (err) {
      console.error('characters.status failed', err);
      setFailed(true);
    }
  }, [characterRef]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (failed) return null;
  if (!status) return <span className="muted small">…</span>;
  const { mood, routine } = status;
  const recent = mood.recent[0]?.reason;
  return (
    <span className="char-status row" style={{ gap: 6 }}>
      <span className="badge" title={`${describeMood(mood)}${recent ? `\nrecent: ${recent}` : ''}`}>
        {moodGlyph(mood.mood)} {moodWord(mood.mood)} · {energyWord(mood.energy)}
      </span>
      <span className={ROUTINE_CLS[routine.state] ?? 'badge'} title={describeRoutine(routine)}>
        {routine.state}
        {routine.label ? ` · ${routine.label}` : ''}
      </span>
    </span>
  );
}
