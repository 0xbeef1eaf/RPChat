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

// The script sets the scene; `llm.wake` gives Luna a turn so the greeting is hers, not a canned string.
if (sessions === 1) {
  await sdk.media.showImage('images/luna-wave.png', { durationMs: 6000, position: 'bottom-right' });
  await sdk.llm.wake(
    `This is your first conversation with them and it is ${partOfDay}. Introduce yourself as Luna and ask what to call them, so you can remember it.`,
  );
} else {
  await sdk.llm.wake(
    `They are back${who} and it is ${partOfDay} — chat number ${sessions}. Greet them briefly and warmly.`,
  );
}

// A gentle stretch reminder twenty minutes in; on-timer.ts handles it when it fires.
await sdk.timers.schedule(20 * 60 * 1000, { reason: 'stretch' }, { label: 'Stretch break' });

return { sessions, partOfDay };
