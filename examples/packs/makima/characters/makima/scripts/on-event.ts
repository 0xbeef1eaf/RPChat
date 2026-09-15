// Runs for host events that no `sdk.events.on` subscription handled. `input` is `{ event, data }`.
// user-back: a brief acknowledgement. window-changed to a game: one dry remark, at most once per hour.
// The script sets the beat (avatar, throttling); `llm.wake` gives her the turn in which she speaks.

const { event, data } = input as { event: string; data: Record<string, unknown> | null };

if (await sdk.state.session.get('outOfCharacter')) {
  return { skipped: 'out of character' };
}

if (event === 'user-back') {
  const idleMin = Math.round((Number(data?.idleMs) || 0) / 60_000);
  try { await sdk.avatar.animate('nod'); } catch { /* avatar hidden */ }
  try {
    await sdk.llm.wake(`They just came back after ${idleMin} minutes away. Acknowledge it in one short line, in character.`);
  } catch { /* autonomy limits */ }
  return { event, idleMin };
}

if (event === 'window-changed') {
  const app = String(data?.app ?? '').toLowerCase();
  const title = String(data?.title ?? '').toLowerCase();
  const isGame = /\b(steam|game|minecraft|league of legends|valorant|dota|fortnite|epic games|elden|stardew)\b/.test(`${app} ${title}`);
  if (!isGame) return { event, ignored: true };

  const last = ((await sdk.state.session.get('lastGameRemarkAt')) as number | null) ?? 0;
  const now = Date.now();
  if (now - last < 60 * 60_000) return { event, throttled: true };
  await sdk.state.session.set('lastGameRemarkAt', now);

  try { await sdk.avatar.set({ expression: 'stare' }); } catch { /* avatar hidden */ }
  try {
    await sdk.llm.wake(`They just switched to a game (${app || title}) in the middle of your conversation. One dry remark, in character.`);
  } catch { /* autonomy limits */ }
  return { event, remarked: true };
}

return { event, ignored: true };
