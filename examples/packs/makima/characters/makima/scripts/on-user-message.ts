// Runs after every user message, before the model replies. `input` is `{ text: string }`.
// Nudges mood on apologies and thanks; handles the safeword; never skips the model.

const text = String((input as { text: string }).text ?? '');

// Safeword: step out of the scene at once. The model sees the message too and stays out of character.
if (/\bchainsaw\b/i.test(text)) {
  await sdk.state.session.set('outOfCharacter', true);
  try { await sdk.avatar.hide(); } catch { /* not shown */ }
  try { await sdk.wallpaper.restore(); } catch { /* no wallpaper command configured */ }
  try { await sdk.media.closeAll(); } catch { /* nothing open */ }
  return { skipLlm: false, safeword: true };
}

if (/\b(sorry|apolog\w*|my bad|forgive me)\b/i.test(text)) {
  await sdk.mood.nudge({ mood: 0.05 }, 'they apologised');
}
if (/\b(thank(s| you)|thx|ty)\b/i.test(text)) {
  await sdk.mood.nudge({ mood: 0.1 }, 'they thanked me');
}

// Remember a name if they give one ("I'm Sam", "call me Sam").
const named = /\b(?:i am|i'm|call me|my name is)\s+([A-Z][a-z]{1,20})\b/.exec(text);
if (named && !(await sdk.state.get('user.name'))) {
  await sdk.state.set('user.name', named[1]!);
}

return { skipLlm: false };
