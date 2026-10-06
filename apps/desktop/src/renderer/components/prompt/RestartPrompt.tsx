import { useEffect, useState } from 'react';
import type { RestartPromptPayload } from '@rp/shared';

export interface RestartPromptProps {
  payload: RestartPromptPayload;
  onRestartNow: () => void;
}

/** Whole seconds left until `deadline` (never negative). */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** `75` → `1:15`, `9` → `9 s`. */
export function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The forced-restart countdown (`settings.updates.forceRestart`). Main owns the timer and restarts
 * when it runs out whatever this window does; the page only shows how long is left and offers to
 * restart straight away.
 */
export function RestartPrompt({ payload, onRestartNow }: RestartPromptProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);
  const left = secondsLeft(payload.deadline, now);
  return (
    <>
      <p>
        rpchat {payload.version} has been downloaded.{' '}
        {payload.packaging === 'system' ? 'The system service installs it and rpchat restarts' : 'rpchat restarts to install it'}{' '}
        {left > 0 ? (
          <>
            in <strong>{formatCountdown(left)}</strong>.
          </>
        ) : (
          'now.'
        )}
      </p>
      <p className="muted small">Your conversations, the media on screen, the avatar and the open views come back after the restart. Closing this window does not stop it.</p>
      <div className="form-actions">
        <span className="grow" />
        <button type="button" className="btn btn-primary" autoFocus onClick={onRestartNow}>
          Restart now
        </button>
      </div>
    </>
  );
}
