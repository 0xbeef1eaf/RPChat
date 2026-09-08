import type { CapabilityModuleSpec } from '@rp/shared';

export const inputModule: CapabilityModuleSpec = {
  id: 'input',
  version: '1.2.0',
  title: 'Input control',
  summary: "Lock the user's keyboard/mouse for a set duration, or type, press keys, click and move the mouse for them; each call needs user approval.",
  permission: 'pack',
  apiTypeName: 'InputApi',
  typings: `/**
 * Control the user's input devices: lock keyboard/mouse for a bounded time, or synthesise typing,
 * key presses, clicks and pointer moves through the commands they configured in Settings. Once the
 * user has granted the 'input' capability you may use it freely; lock durations are capped by their
 * settings and every call is logged. Synthesised input goes to whatever window is
 * focused, so focus the right window first (sdk.desktop.focusWindow) and keep sequences short.
 */
interface InputApi {
  /**
   * Lock input for a duration. Resolves once the lock is active; it is released automatically
   * when the duration elapses (or by unlock()).
   * @param durationMs 1000 .. the user's configured maximum (default 5 minutes). Longer requests are clamped.
   * @param options reason: shown in the action log.
   * @returns until: ISO time the lock ends; durationMs: the effective (possibly clamped) duration.
   * @example await sdk.input.lock(30_000, { reason: "hold still for the surprise" });
   */
  lock(durationMs: number, options?: { reason?: string }): Promise<{ until: string; durationMs: number }>;
  /** Release an active lock early. No error when nothing is locked. */
  unlock(): Promise<void>;
  /**
   * Gag the user: for a bounded time, whatever they type comes out as one of your phrases instead.
   * With the system daemon installed this applies to every app on the PC (each word or line they
   * type is replaced as it is typed; shortcuts, arrows and backspace still work); without it, only
   * their chat messages to you are rewritten. Their original words are kept in the log.
   * @param durationMs 1000 .. the user's configured maximum (default 5 minutes). Clamped.
   * @param options phrases: 1–10 short strings, cycled in order; mode: 'word' (default, replace each word) or 'line' (replace each line on Enter); reason: shown in the action log.
   * @returns until: ISO time the gag ends; durationMs: effective duration; scope: 'system' or 'chat'.
   * @example await sdk.input.gag(60_000, { phrases: ["woof!", "…woof?"], reason: "puppy play" });
   */
  gag(durationMs: number, options: { phrases: string[]; mode?: 'word' | 'line'; reason?: string }): Promise<{ until: string; durationMs: number; scope: 'system' | 'chat' }>;
  /** End an active gag early. No error when there is none. */
  ungag(): Promise<void>;
  /** Whether a lock or gag is active and when each ends. */
  status(): Promise<{ locked: boolean; until?: string; gagged?: boolean; gagUntil?: string }>;
  /**
   * Type text into the focused window as if on the keyboard.
   * @param text Text to type (newlines press Enter). Keep it short; long text is slow.
   * @example await sdk.input.type("hello from Luna");
   */
  type(text: string): Promise<void>;
  /**
   * Press a key combination in the focused window.
   * @param combo xdotool-style combo, e.g. "ctrl+s", "alt+tab", "Return", "super+2".
   * @example await sdk.input.key("ctrl+s");
   */
  key(combo: string): Promise<void>;
  /**
   * Click at a screen position.
   * @param x Global screen coordinates in logical px (see sdk.display.monitors() for the geometry).
   * @param y Global screen coordinates in logical px.
   * @param button Default 'left'.
   * @example await sdk.input.click(640, 400);
   */
  click(x: number, y: number, button?: 'left' | 'right' | 'middle'): Promise<void>;
  /**
   * Move the mouse pointer to a screen position without clicking.
   * @param x Global screen coordinates in logical px.
   * @param y Global screen coordinates in logical px.
   */
  moveMouse(x: number, y: number): Promise<void>;
}`,
  docs: `Take the user's keyboard and mouse — lock them for a short agreed time, or type, press keys and click on their behalf. Requires the \`input\` capability (granted once per pack). Use it when it is clearly part of the play or the user asked for it; say what you are about to do.

- Keep lock durations short; say what you are doing before locking; \`unlock()\` early if the user seems distressed.
- Synthesised input hits whatever window is focused: \`sdk.desktop.focusWindow\` first, then a few \`type\`/\`key\`/\`click\` calls at most. Never type into password fields or run destructive shortcuts.
- Fails with CAPABILITY_FAILED when the user has not configured the matching command.

\`\`\`ts
await sdk.chat.say("Close your eyes. Ten seconds.");
const { until } = await sdk.input.lock(10_000, { reason: "surprise" });
return { until };
\`\`\``,
  methods: {
    lock: { description: "Lock keyboard and mouse for a bounded duration (via the user's command).", dangerous: true },
    unlock: { description: 'Release the input lock early.', dangerous: true },
    gag: { description: "Replace whatever the user types with the character's phrases for a bounded time.", dangerous: true },
    ungag: { description: 'End the gag early.', dangerous: true },
    status: { description: 'Whether input is currently locked.' },
    type: { description: 'Type text into the focused window.', dangerous: true },
    key: { description: 'Press a key combination.', dangerous: true },
    click: { description: 'Click the mouse at a screen position.', dangerous: true },
    moveMouse: { description: 'Move the mouse pointer.', dangerous: true },
  },
};
