import type { CapabilityModuleSpec } from '@rp/shared';

export const inputModule: CapabilityModuleSpec = {
  id: 'input',
  version: '1.2.1',
  title: 'Input control',
  summary: "Lock the user's keyboard/mouse for a set duration, or type, press keys, click and move the mouse for them (through the system integration daemon).",
  permission: 'pack',
  apiTypeName: 'InputApi',
  typings: `/**
 * Control the user's input devices: lock keyboard/mouse for a bounded time, or synthesise typing,
 * key presses, clicks and pointer moves. Everything goes through the rp-code system integration
 * daemon (Linux); when it is not installed or not connected every call fails with
 * CAPABILITY_FAILED. Unless the user switched 'input' off in the app you may use it freely; lock
 * durations are capped by their settings and by the machine's policy, and every call is logged.
 * Synthesised input goes to whatever window is focused, so focus the right window first
 * (sdk.desktop.focusWindow) and keep sequences short.
 */
interface InputApi {
  /**
   * Lock input for a duration. Resolves once the lock is active; it is released automatically
   * when the duration elapses (or by unlock()).
   * @param durationMs 1000 .. the user's configured maximum (default 5 minutes). Longer requests are clamped.
   * @param options reason: shown in the action log; devices: 'keyboard', 'mouse' or 'both' (default 'both').
   * @returns until: ISO time the lock ends; durationMs: the effective (possibly clamped) duration; devices: what was locked.
   * @example await sdk.input.lock(30_000, { reason: "hold still for the surprise" });
   * @example await sdk.input.lock(20_000, { devices: "mouse", reason: "hands off the mouse while I show you this" });
   */
  lock(durationMs: number, options?: { reason?: string; devices?: 'keyboard' | 'mouse' | 'both' }): Promise<{ until: string; durationMs: number; devices: 'keyboard' | 'mouse' | 'both' }>;
  /** Release an active lock early. No error when nothing is locked. */
  unlock(): Promise<void>;
  /** Whether a lock is active, when it ends and which devices it covers. */
  status(): Promise<{ locked: boolean; until?: string; devices?: 'keyboard' | 'mouse' | 'both' }>;
  /**
   * Type text into the focused window as if on the keyboard.
   * @param text Text to type (newlines press Enter). Keep it short; long text is slow.
   * @example await sdk.input.type("hello from Luna");
   */
  type(text: string): Promise<void>;
  /**
   * Press a key combination in the focused window.
   * @param combo Key names joined with "+", e.g. "ctrl+s", "alt+tab", "Return", "super+2".
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
  docs: `Take the user's keyboard and mouse — lock them for a short agreed time, or type, press keys and click on their behalf. Available unless the user switched \`input\` off under Settings → Permissions. Use it when it is clearly part of the play or the user asked for it; say what you are about to do.

- Keep lock durations short; say what you are doing before locking; \`unlock()\` early if the user seems distressed.
- Synthesised input hits whatever window is focused: \`sdk.desktop.focusWindow\` first, then a few \`type\`/\`key\`/\`click\` calls at most. Never type into password fields or run destructive shortcuts.
- Needs the rp-code system integration daemon (Settings → System → Install). Without it every call fails with CAPABILITY_FAILED ("Input control needs the rp-code system integration…"); tell the user rather than retrying.

\`\`\`ts
await sdk.chat.say("Close your eyes. Ten seconds.");
const { until } = await sdk.input.lock(10_000, { reason: "surprise" });
return { until };
\`\`\``,
  methods: {
    lock: { description: 'Lock keyboard and mouse for a bounded duration (through the system daemon).', dangerous: true },
    unlock: { description: 'Release the input lock early.', dangerous: true },
    status: { description: 'Whether input is currently locked.' },
    type: { description: 'Type text into the focused window.', dangerous: true },
    key: { description: 'Press a key combination.', dangerous: true },
    click: { description: 'Click the mouse at a screen position.', dangerous: true },
    moveMouse: { description: 'Move the mouse pointer.', dangerous: true },
  },
};
