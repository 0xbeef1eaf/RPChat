// Makima's win function for the games (pass its name as onWin): a smile, then she wakes to react in her own words; receives { game, result: "win", attempt, mistakes, ...details } from lib.endGame
async (info: { game?: string; attempt?: number; mistakes?: number; [key: string]: unknown } = {}) => {
  const game = String(info.game ?? "game");
  const attempt = Math.max(1, Number(info.attempt ?? 1));
  const mistakes = Math.max(0, Number(info.mistakes ?? 0));
  try { await sdk.avatar.set({ expression: "smile" }); } catch { /* avatar hidden or switched off */ }
  const clean = mistakes === 0 && attempt === 1;
  try {
    await sdk.llm.wake(`The user just won the ${game} you set them (attempt ${attempt}, ${mistakes} mistakes in total)${clean ? " — clean, first time" : ""}. React in character in one or two sentences.`);
  } catch { /* autonomy limits */ }
  return { rewarded: true, game, attempt, mistakes };
}
