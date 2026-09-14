// (games) the win path: closes the game's widget and media, removes its subscriptions, clears the state and calls lib[onWin]({ game, result: "win", attempt, mistakes, ...details }) when the game set one; returns that report (or onWin's result)
async (details: { [key: string]: unknown } = {}) => {
  const game = (await lib.quitGame()) as { game: string; attempt: number; mistakes: number; onWin?: string | null } | null;
  if (!game) return null;
  const report = { game: game.game, result: "win", attempt: game.attempt, mistakes: game.mistakes, ...details };
  if (typeof game.onWin === "string" && typeof lib[game.onWin] === "function") {
    try {
      return await lib[game.onWin](report);
    } catch (err) {
      return { ...report, error: String(err) };
    }
  }
  return report;
}
