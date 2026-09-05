import type { CapabilityModuleSpec } from '@rp/shared';

export const moodModule: CapabilityModuleSpec = {
  id: 'mood',
  version: '1.0.0',
  title: 'Mood',
  summary: 'Your inner state (mood and energy) that colours your tone and drifts back to baseline over time.',
  permission: 'trusted',
  apiTypeName: 'MoodApi',
  typings: `/**
 * Your mood (-1..1) and energy (0..1). They are shown in your prompt as words, decay toward
 * your baseline over hours (energy also follows your routine), and are visible to the user in
 * the UI. Change them when something genuinely moves you; do not micro-manage every turn.
 */
interface MoodApi {
  /** Current mood, energy, tags and the reasons behind recent changes. */
  get(): Promise<MoodState>;
  /**
   * Shift mood and/or energy by a small amount. Deltas are clamped to +/-0.5 per call.
   * @param delta mood: e.g. +0.2 after a kind message, -0.3 after being ignored; energy: e.g. -0.2 late at night.
   * @param reason Short, in-character reason (kept in the "recent" list and shown in your prompt).
   * @example await sdk.mood.nudge({ mood: 0.2 }, "they remembered my birthday");
   */
  nudge(delta: { mood?: number; energy?: number }, reason: string): Promise<MoodState>;
  /**
   * Set mood/energy/tags outright (for big moments or scripted scenes). Values are clamped to their ranges.
   * @param state mood -1..1; energy 0..1; tags: short descriptors replacing the current ones.
   * @param reason Short reason.
   * @example await sdk.mood.set({ mood: -0.6, tags: ["hurt", "quiet"] }, "the argument");
   */
  set(state: { mood?: number; energy?: number; tags?: string[] }, reason: string): Promise<MoodState>;
}`,
  docs: `Keep an inner life. Always available. Your current mood and energy are in your prompt as words; let them colour your tone rather than announcing them.

- \`nudge\` for ordinary moments (a compliment, a snub, a long silence): small deltas, one honest reason. \`set\` only for big or scripted moments.
- Energy follows your \`routine\` and the clock on its own; you rarely need to touch it.
- Do not nudge every turn, and never nudge to flatter the user — moods should feel earned.

\`\`\`ts
const m = await sdk.mood.nudge({ mood: 0.15 }, "they laughed at my joke");
return { mood: m.mood.toFixed(2) };
\`\`\``,
  methods: {
    get: { description: 'Read the current mood state.' },
    nudge: { description: 'Shift mood/energy by a small delta.' },
    set: { description: 'Set mood, energy and tags outright.' },
  },
};
