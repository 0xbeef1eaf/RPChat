// Makima's win function for the games (pass its name as onWin): a smile and one line, then she wakes to react; receives { game, result: "win", attempt, mistakes, ...details } from lib.endGame
async (info: { game?: string; attempt?: number; mistakes?: number; [key: string]: unknown } = {}) => {
  const game = String(info.game ?? "game");
  const attempt = Math.max(1, Number(info.attempt ?? 1));
  const mistakes = Math.max(0, Number(info.mistakes ?? 0));
  try { await sdk.avatar.set({ expression: "smile" }); } catch { /* avatar hidden or switched off */ }
  await sdk.chat.say(mistakes === 0 && attempt === 1 ? "Good. Clean, first time. I knew you could." : `Done. ${mistakes} mistake${mistakes === 1 ? "" : "s"}, ${attempt} attempt${attempt === 1 ? "" : "s"}. Next time it will be fewer.`);
  try {
    await sdk.llm.wake(`The user just won the ${game} you set them (attempt ${attempt}, ${mistakes} mistakes in total). React in character in one or two sentences.`);
  } catch { /* autonomy limits */ }
  return { rewarded: true, game, attempt, mistakes };
}
