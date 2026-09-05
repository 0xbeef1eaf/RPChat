// Runs once when a new chat session with Luna starts, before the LLM's first turn.
// This is the body of an async function: `sdk` is in scope, `return` sends a value back.

const previous = (await sdk.state.get('sessions')) as number | null;
const sessions = (previous ?? 0) + 1;
await sdk.state.set('sessions', sessions);

const hour = new Date().getHours();
const partOfDay =
  hour < 5 ? 'still up at this hour, huh' :
  hour < 12 ? 'morning' :
  hour < 18 ? 'afternoon' :
  hour < 23 ? 'evening' :
  'late one tonight';

const name = (await sdk.state.get('userName')) as string | null;
const who = name ? `, ${name}` : '';

if (sessions === 1) {
  await sdk.chat.say(`Hey${who}. ${capitalize(partOfDay)}. I'm Luna. Tell me what to call you and I'll remember it.`);
  await sdk.media.showImage('images/luna-wave.png', { durationMs: 6000, position: 'bottom-right' });
} else {
  await sdk.chat.say(`Hey${who}, ${partOfDay}. Good to see you back. That makes ${sessions} chats now.`);
}

// A gentle stretch reminder twenty minutes in; on-timer.ts handles it when it fires.
await sdk.timers.schedule(20 * 60 * 1000, { reason: 'stretch' }, { label: 'Stretch break' });

return { sessions, partOfDay };

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
