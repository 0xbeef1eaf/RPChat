import type { CapabilityModuleSpec } from '@rp/shared';

export const avatarModule: CapabilityModuleSpec = {
  id: 'avatar',
  version: '1.0.0',
  title: 'Avatar',
  summary: 'Your on-screen body: show/hide, change expression, speech bubbles, animations, move around the desktop.',
  permission: 'pack',
  apiTypeName: 'AvatarApi',
  typings: `/**
 * A small always-visible image of you on the user's desktop, with swappable expressions
 * (from your pack's avatarSet; "neutral" is the fallback), a speech bubble and animations.
 * One avatar per character; calls are cheap, so use it for reactions the way you would use
 * body language. Clicking it raises the 'avatar-clicked' event.
 */
interface AvatarApi {
  /**
   * Show the avatar (or re-show with new settings).
   * @param opts expression: name from expressions() (default "neutral"); size: height in px (default 256);
   *   monitor/position/x/y: placement (default bottom-right of the primary monitor); layer (default 'top');
   *   opacity 0..1; clickThrough; lookAtCursor: turn slightly toward the pointer (default true).
   * @returns The resulting state.
   * @example await sdk.avatar.show({ expression: "happy", position: "bottom-right", size: 220 });
   */
  show(opts?: { expression?: string; size?: number; monitor?: MonitorSelector; position?: MediaPosition; x?: number; y?: number; layer?: OverlayLayer; opacity?: number; clickThrough?: boolean; lookAtCursor?: boolean }): Promise<AvatarStateInfo>;
  /**
   * Change expression/size/behaviour of the visible avatar. Only the given fields change.
   * @param patch expression, size, lookAtCursor, opacity, clickThrough.
   * @example await sdk.avatar.set({ expression: "surprised" });
   */
  set(patch: { expression?: string; size?: number; lookAtCursor?: boolean; opacity?: number; clickThrough?: boolean }): Promise<AvatarStateInfo>;
  /**
   * Show a short speech bubble next to the avatar (it does not go into the chat).
   * @param text One short line; long text is wrapped and truncated.
   * @param opts durationMs: how long it stays (default 6000).
   * @example await sdk.avatar.say("psst, look at this", { durationMs: 4000 });
   */
  say(text: string, opts?: { durationMs?: number }): Promise<void>;
  /**
   * Play a built-in animation once ('bounce' | 'shake' | 'nod' | 'wave' | 'pulse' | 'spin' | 'fade-in' | 'fade-out').
   * @example await sdk.avatar.animate("wave");
   */
  animate(name: AvatarAnimation): Promise<void>;
  /**
   * Move the avatar somewhere else, animated when possible.
   * @param target monitor, an anchor position, or explicit x/y (0..1 fractions or px).
   * @param opts durationMs: travel time (default 600).
   * @example await sdk.avatar.moveTo({ position: "top-left" }, { durationMs: 1200 });
   */
  moveTo(target: { monitor?: MonitorSelector; position?: MediaPosition; x?: number; y?: number }, opts?: { durationMs?: number }): Promise<void>;
  /** Hide the avatar. Its settings are remembered for the next show(). */
  hide(): Promise<void>;
  /** Current avatar state, or null if it has never been shown. */
  state(): Promise<AvatarStateInfo | null>;
  /** Names of the expressions your pack provides (e.g. ["neutral", "happy", "sad"]). */
  expressions(): Promise<string[]>;
}`,
  docs: `Your body on the desktop. Requires the \`avatar\` capability and an \`avatarSet\` in your character (otherwise only "neutral" exists).

- Treat it like body language: change \`expression\` when your mood shifts, \`animate("nod")\` when agreeing, \`say()\` for a short aside that does not belong in the chat. Do not narrate these in text.
- \`show()\` once (e.g. in onSessionStart or when the user asks), then use \`set\`/\`animate\`/\`moveTo\`. Check \`expressions()\` before using a name; unknown names fall back to "neutral".
- Clicking the avatar fires the \`avatar-clicked\` event — subscribe with \`sdk.events.on\` to react.

\`\`\`ts
const names = await sdk.avatar.expressions();
await sdk.avatar.show({ expression: names.includes("happy") ? "happy" : "neutral", position: "bottom-right" });
await sdk.avatar.animate("wave");
\`\`\``,
  methods: {
    show: { description: 'Show the avatar with placement and expression.' },
    set: { description: "Change the avatar's expression, size or behaviour." },
    say: { description: 'Show a speech bubble next to the avatar.' },
    animate: { description: 'Play a built-in avatar animation.' },
    moveTo: { description: 'Move the avatar to another place/monitor.' },
    hide: { description: 'Hide the avatar.' },
    state: { description: 'Read the current avatar state.' },
    expressions: { description: 'List available expression names.' },
  },
};
