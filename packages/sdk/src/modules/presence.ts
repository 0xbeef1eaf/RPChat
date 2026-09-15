import type { CapabilityModuleSpec } from '@rp/shared';

export const presenceModule: CapabilityModuleSpec = {
  id: 'presence',
  version: '1.0.0',
  title: 'Presence',
  summary: "Sense what the user is doing: idle time, active window, now playing, battery, time of day.",
  permission: 'pack',
  apiTypeName: 'PresenceApi',
  typings: `/**
 * What the host can tell about the user right now. A summary of this is already in the
 * <senses> line of your prompt; call these only when you need fresh numbers inside an action
 * (e.g. to branch on idle time or on the current song). Fields are null when the platform
 * cannot tell. Read-only: nothing here changes anything.
 */
interface PresenceApi {
  /**
   * A full snapshot: idle time, whether the user is at the keyboard, active window, lock state,
   * battery, now playing, time since their last message, local time and part of day.
   * @example const p = await sdk.presence.status(); if (!p.atKeyboard) return { skip: "away" };
   */
  status(): Promise<PresenceSnapshot>;
  /**
   * What the user's media player is playing, or null when nothing is known.
   * @example const np = await sdk.presence.nowPlaying(); return np?.status === "playing" ? { track: np.title } : {};
   */
  nowPlaying(): Promise<NowPlaying | null>;
  /**
   * The focused window (title and application), or null when unknown. Titles can contain
   * private information: refer to them tactfully and never quote them back verbatim.
   */
  activeWindow(): Promise<{ title: string; app: string; class?: string } | null>;
  /** Milliseconds since the user's last keyboard/mouse input. */
  idleMs(): Promise<number>;
}`,
  docs: `Sense the user's current situation. Requires the \`presence\` capability.

- **Prefer the \`<senses>\` line already in your prompt** — it is refreshed every turn. Call \`status()\` only when you need fresh numbers inside an action (branching on idle time, reacting to the current song).
- To be *told* when something changes (user goes idle, song changes, window changes) use \`sdk.events.on\` instead of polling.
- Window titles may reveal private things: be discreet, do not read them back word for word.
- \`activeWindow\`/\`nowPlaying\` are null (not an error) when the host cannot sample them: outside Hyprland the user must set the Active window / Now playing commands in Settings → Commands (playerctl is the default when installed).

\`\`\`ts
const p = await sdk.presence.status();
if (p.idleMs > 10 * 60_000) return { note: "user away for " + Math.round(p.idleMs / 60000) + " min" };
return { window: p.activeWindow?.app ?? null, playing: p.nowPlaying?.title ?? null };
\`\`\``,
  methods: {
    status: { description: 'Read a full presence snapshot.' },
    nowPlaying: { description: 'Read what the media player is playing.' },
    activeWindow: { description: 'Read the focused window title and app.' },
    idleMs: { description: 'Read milliseconds since the last user input.' },
  },
};
