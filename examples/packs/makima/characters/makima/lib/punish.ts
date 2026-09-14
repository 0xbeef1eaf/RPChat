// Makima's loss function for the games (pass its name as onLose): a displeased look, one line about the mistake, the red dusk wallpaper, then she wakes to react in character; receives { game, event, attempt, mistakes, ...details } from lib.gameLost on every mistake
async (info: { game?: string; event?: string; attempt?: number; mistakes?: number; [key: string]: unknown } = {}) => {
  const game = String(info.game ?? "game");
  const mistakes = Math.max(1, Number(info.mistakes ?? 1));
  const attempt = Math.max(1, Number(info.attempt ?? 1));
  try { await sdk.avatar.set({ expression: "displeased" }); } catch { /* avatar hidden or switched off */ }
  const lines = [
    `A mistake. ${mistakes === 1 ? "Your first." : `Number ${mistakes}.`} I'm counting.`,
    "Again. We'll do it until you get it right; I have time.",
    `Attempt ${attempt}. You're not concentrating. Look at me, then look at the ${game}.`,
  ];
  await sdk.chat.say(lines[(mistakes - 1) % lines.length]!);
  try {
    const scene = (await sdk.pack.findAssets({ tags: ["wallpaper", "control"], kind: "image", fallback: false }))[0];
    if (scene) await sdk.wallpaper.set(scene);
  } catch { /* wallpaper switched off or no command configured */ }
  try {
    await sdk.llm.wake(`The user just made a mistake in the ${game} you set them (${String(info.event ?? "mistake")}; mistake ${mistakes}, attempt ${attempt}). React in character in one or two sentences. The game goes on by itself; do not restart it.`);
  } catch { /* autonomy limits */ }
  return { punished: true, game, mistakes, attempt };
}
