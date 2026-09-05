import type { CapabilityModuleSpec } from '@rp/shared';

export const screenModule: CapabilityModuleSpec = {
  id: 'screen',
  version: '1.0.0',
  title: 'Screen',
  summary: "Look at the user's screen (described by a vision model) and draw pointers/annotations on it.",
  permission: 'pack',
  apiTypeName: 'ScreenApi',
  typings: `/**
 * See the screen and draw on it. look() takes a screenshot and has a vision model describe it —
 * you receive text, never the image — and always asks the user first. draw() puts temporary,
 * click-through shapes (arrows, circles, text) over the screen to point at things.
 */
interface ScreenApi {
  /**
   * Take a screenshot of one monitor and describe it. The user must confirm the call.
   * Ask a focused question to get a useful answer; the description is short.
   * @param opts monitor: which monitor (default 'primary'); question: what you want to know,
   *   e.g. "What game is this and what is happening?" (default: general description).
   * @returns description text plus the screenshot's size in logical px (use it to convert
   *   described positions to draw() coordinates).
   * @example const { description } = await sdk.screen.look({ question: "What is the user working on?" });
   */
  look(opts?: { monitor?: MonitorSelector; question?: string }): Promise<{ description: string; width: number; height: number }>;
  /**
   * Draw shapes over the screen (a click-through overlay). Coordinates 0..1 are fractions of
   * the monitor, larger values are logical px. Shapes stay until cleared or their duration ends.
   * @param shapes Arrows, circles, rects, lines or text labels.
   * @param opts monitor: which monitor (default 'primary'); durationMs: auto-remove all of them after this (default 10000).
   * @returns Ids of the drawn shapes, for clear().
   * @example await sdk.screen.draw([{ type: "circle", x: 0.5, y: 0.5, radius: 60, color: "#ff4081" }, { type: "text", x: 0.5, y: 0.58, text: "here!" }], { durationMs: 5000 });
   */
  draw(shapes: DrawShape[], opts?: { monitor?: MonitorSelector; durationMs?: number }): Promise<{ ids: string[] }>;
  /**
   * Remove drawn shapes.
   * @param ids Shape ids from draw(). Omit to clear everything you drew.
   */
  clear(ids?: string[]): Promise<void>;
}`,
  docs: `See what is on screen and point at things. Requires the \`screen\` capability; \`look()\` additionally asks the user every time.

- \`look()\` is expensive and private: use it only when the user invites you to look or it clearly helps them. Ask a specific \`question\`; you get a short text description, not pixels.
- \`draw()\` is for pointing: an arrow or circle with a short label, a few seconds long. Coordinates 0..1 are monitor fractions, so \`{ x: 0.5, y: 0.5 }\` is the centre. Keep it sparse and \`clear()\` when done.

\`\`\`ts
const look = await sdk.screen.look({ question: "Where is the Save button?" });
await sdk.screen.draw([{ type: "arrow", x: 0.5, y: 0.7, x2: 0.9, y2: 0.1, color: "#ff4081", durationMs: 6000 }]);
return { saw: look.description };
\`\`\``,
  methods: {
    look: { description: 'Take a screenshot and describe it with a vision model.', permission: 'prompt', dangerous: true },
    draw: { description: 'Draw temporary shapes over the screen.' },
    clear: { description: 'Remove drawn shapes.' },
  },
};
