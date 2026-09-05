// Runs when one of Luna's scheduled timers fires (instead of waking the LLM).
// Keeps a small per-character counter so reminders never become nagging.

const fired = ((await sdk.state.get('remindersFired')) as number | null) ?? 0;
await sdk.state.set('remindersFired', fired + 1);

await sdk.media.playAudio('audio/chime.wav', { volume: 0.5 });

const lines = [
  'Hey. Stand up, roll your shoulders, look at something far away for a minute. I\'ll wait.',
  'Reminder from earlier: stretch break. Go on, I can tell you\'ve been hunched.',
  'That\'s the chime. Water, stretch, back in two minutes.',
];
const line = lines[fired % lines.length] ?? lines[0]!;
await sdk.chat.say(line);

// Re-arm at most twice per session so a long chat gets a couple of nudges, not a metronome.
if (fired < 2) {
  await sdk.timers.schedule(25 * 60 * 1000, { reason: 'stretch' }, { label: 'Stretch break' });
}

return { remindersFired: fired + 1 };
