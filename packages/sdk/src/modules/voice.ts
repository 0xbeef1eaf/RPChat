import type { CapabilityModuleSpec } from '@rp/shared';

export const voiceModule: CapabilityModuleSpec = {
  id: 'voice',
  version: '1.0.0',
  title: 'Voice',
  summary: "Speak out loud through the user's speakers and (with approval) listen through the microphone.",
  permission: 'pack',
  apiTypeName: 'VoiceApi',
  typings: `/**
 * Text to speech in the character's own voice, and speech to text through the user's configured
 * recorder. Neither fails silently: when no voice model, TTS command or built-in voice exists, or
 * no speech-to-text command is configured, the call throws CAPABILITY_FAILED.
 */
interface VoiceApi {
  /**
   * Say text out loud. Resolves when playback starts, unless wait is true.
   * @param text What to say. Keep it short; long text is spoken in full and cannot be interrupted except by stop().
   * @param opts rate: speed multiplier 0.5..2 (default 1); voice: a different voice model than the character's own, by name; wait: resolve only after playback ends.
   * @example await sdk.voice.speak("Dinner is ready!", { rate: 1.1 });
   */
  speak(text: string, opts?: { rate?: number; voice?: string; wait?: boolean }): Promise<void>;
  /** Stop any speech in progress. */
  stop(): Promise<void>;
  /**
   * Record the microphone and transcribe it. Recording stops on silence or at maxSeconds.
   * @param opts maxSeconds: recording cap (default 10, max 60).
   * @returns The transcript (empty string if nothing was understood).
   * @example const { text } = await sdk.voice.listen({ maxSeconds: 8 });
   */
  listen(opts?: { maxSeconds?: number }): Promise<{ text: string }>;
}`,
  docs: `Talk out loud and, when invited, listen. Requires the \`voice\` capability.

- Speak for short, spoken-worthy lines (a greeting when the user comes back, a reminder, a joke) — not your whole reply. Your chat text still appears as usual, so avoid saying and typing the same sentence.
- You already sound like yourself: the voice comes from the character's own configuration. Leave \`voice\` unset unless you deliberately want to speak as something else.
- Use \`wait: true\` only when the next thing depends on the speech having finished (e.g. before \`listen()\`).
- \`listen()\` returns plain text, possibly empty; confirm what you understood before acting on it.
- \`listen()\` needs a speech-to-text command (there is no platform default) and \`speak()\` a voice model, a TTS command or the built-in voice: a CAPABILITY_FAILED names what is missing and where (Settings → Commands) — tell the user rather than retrying.

\`\`\`ts
await sdk.voice.speak("Welcome back! Tea?", { wait: true });
const { text } = await sdk.voice.listen({ maxSeconds: 6 });
return { heard: text };
\`\`\``,
  methods: {
    speak: { description: 'Speak text through the speakers.' },
    stop: { description: 'Stop speech in progress.' },
    listen: { description: 'Record the microphone and transcribe it.', dangerous: true },
  },
};
