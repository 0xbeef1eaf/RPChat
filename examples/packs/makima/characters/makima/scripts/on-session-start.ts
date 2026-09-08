// Runs when a new chat session with Makima starts, before the model's first turn.
// Body of an async function: `sdk` is in scope; `input` is null for this hook.

const previous = ((await sdk.state.get('sessions')) as number | null) ?? 0;
const sessions = previous + 1;
await sdk.state.set('sessions', sessions);

const name = (await sdk.state.get('user.name')) as string | null;
const who = name ? `, ${name}` : '';
const hour = new Date().getHours();

let line: string;
if (sessions === 1) {
  line = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}. I'm Makima. Tell me your name; I'll only ask once.`;
} else if (hour < 5) {
  line = `You're up late${who}. So am I. Sit down.`;
} else if (hour < 12) {
  line = `Good morning${who}. Eat something before we talk.`;
} else if (hour < 18) {
  line = `I'm at the office${who}. I have a few minutes. What do you need?`;
} else {
  line = sessions % 5 === 0
    ? `Good evening${who}. That makes ${sessions} times you've come back. I keep count.`
    : `Good evening${who}. You came back. Good.`;
}
await sdk.chat.say(line);

// Her face, small, in the corner. Expressions come from character.json's avatarSet.
await sdk.avatar.show({ expression: 'neutral', position: 'bottom-right', size: 160, lookAtCursor: true });

// A daily routine, set once and kept per character.
const routine = await sdk.routine.get();
if (routine.entries.length === 0) {
  await sdk.routine.set([
    { at: '07:00', state: 'available', label: 'morning, walking the dogs' },
    { at: '09:00', state: 'busy', label: 'at the office' },
    { at: '18:00', state: 'available', label: 'evening, free' },
    { at: '01:00', state: 'asleep', label: 'asleep' },
  ]);
}

return { sessions, hour };
