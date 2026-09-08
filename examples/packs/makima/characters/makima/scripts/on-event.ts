// Runs for host events that no `sdk.events.on` subscription handled. `input` is `{ event, data }`.
// user-back: a brief acknowledgement. window-changed to a game: one dry remark, at most once per hour.

const { event, data } = input as { event: string; data: Record<string, unknown> | null };

if (await sdk.state.session.get('outOfCharacter')) {
  return { skipped: 'out of character' };
}

if (event === 'user-back') {
  const idleMin = Math.round((Number(data?.idleMs) || 0) / 60_000);
  try { await sdk.avatar.animate('nod'); } catch { /* avatar hidden */ }
  await sdk.chat.say(idleMin >= 30 ? `${idleMin} minutes. I noticed. Welcome back.` : 'There you are.');
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
  const remarks = [
    'A game. In the middle of our conversation. I see.',
    "Go on, then. I'll remember how long it takes you to come back.",
    "I don't mind. Dogs need to run too.",
  ];
  await sdk.chat.say(remarks[Math.floor(now / 3_600_000) % remarks.length] ?? remarks[0]!);
  return { event, remarked: true };
}

return { event, ignored: true };
