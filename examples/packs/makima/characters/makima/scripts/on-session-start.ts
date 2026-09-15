// Runs when a new chat session with Makima starts, before the model's first turn.
// Body of an async function: `sdk` is in scope; `input` is null for this hook.

const previous = ((await sdk.state.get('sessions')) as number | null) ?? 0;
const sessions = previous + 1;
await sdk.state.set('sessions', sessions);

const name = (await sdk.state.get('user.name')) as string | null;
const who = name ? `, ${name}` : '';
const hour = new Date().getHours();

// The script works out the situation; `llm.wake` gives Makima the turn in which she opens.
let situation: string;
if (sessions === 1) {
  situation = "This is the first time they have ever opened a chat with you. Introduce yourself and ask their name — you only ask once.";
} else if (hour < 5) {
  situation = `They are up very late${who}, and so are you. Tell them to sit down.`;
} else if (hour < 12) {
  situation = `It is morning${who}. Greet them and tell them to eat something before you talk.`;
} else if (hour < 18) {
  situation = `You are at the office${who} and have a few minutes. Greet them and ask what they need.`;
} else {
  situation = sessions % 5 === 0
    ? `It is evening${who}. This is the ${sessions}th time they have come back, and you keep count — say so.`
    : `It is evening${who} and they came back. Greet them, pleased but controlled.`;
}
await sdk.llm.wake(`${situation} One or two sentences, in character.`);

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
