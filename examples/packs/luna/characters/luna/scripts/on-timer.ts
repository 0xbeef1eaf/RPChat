// Runs when one of Luna's scheduled timers fires (instead of waking the LLM).
// Keeps a small per-character counter so reminders never become nagging.

const fired = ((await sdk.state.get('remindersFired')) as number | null) ?? 0;
await sdk.state.set('remindersFired', fired + 1);

await sdk.media.playAudio('audio/chime.wav', { volume: 0.5 });

// The script sets the stage (chime, counter); the wake gives Luna a turn to say it herself.
await sdk.llm.wake(
  `Your stretch-break chime just went off (nudge number ${fired + 1} this session). Tell them to stand up, ` +
    `roll their shoulders and look at something far away for a minute. One line, warm, no nagging.`,
);

// Re-arm at most twice per session so a long chat gets a couple of nudges, not a metronome.
if (fired < 2) {
  await sdk.timers.schedule(25 * 60 * 1000, { reason: 'stretch' }, { label: 'Stretch break' });
}

return { remindersFired: fired + 1 };
