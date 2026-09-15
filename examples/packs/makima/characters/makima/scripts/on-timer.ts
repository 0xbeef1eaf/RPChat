// Runs when a timer Makima scheduled fires. `input` is `{ timer: { id, payload, label? } }`.
// Task checks re-ask about the assigned task with the attention chime; anything else is a plain reminder.

const { timer } = input as { timer: { id: string; payload: unknown; label?: string } };
const payload = (timer.payload && typeof timer.payload === 'object' ? timer.payload : {}) as {
  reason?: string;
  task?: string;
};

if (await sdk.state.session.get('outOfCharacter')) {
  return { skipped: 'out of character' };
}

const asked = ((await sdk.state.get('taskChecks')) as number | null) ?? 0;
await sdk.state.set('taskChecks', asked + 1);

if (payload.reason === 'task-check' && payload.task) {
  await sdk.media.playAudio('media/audio/attention.wav', { volume: 0.5 });
  try { await sdk.avatar.set({ expression: 'stare' }); } catch { /* avatar hidden */ }
  await sdk.llm.wake(
    `The check-in timer for the task you set them — "${payload.task}" — just fired (check number ${asked + 1}). ` +
      `Ask whether it is done. One line, in character.`,
  );
  // If they're away, make sure they see it when they come back.
  try {
    const p = await sdk.presence.status();
    if (!p.atKeyboard || p.idleMs > 10 * 60_000) await sdk.ui.notify('Makima', `About the ${payload.task}.`);
  } catch { /* presence switched off or unavailable */ }
  return { reAsked: payload.task };
}

await sdk.media.playAudio('media/audio/click.wav', { volume: 0.4 });
await sdk.llm.wake(
  payload.reason
    ? `A reminder you set for them just fired: ${payload.reason}. Deliver it in one line, in character.`
    : `A reminder they asked you for just fired, with no stated reason. Remind them anyway, in one dry line.`,
);
return { reminded: timer.id };
