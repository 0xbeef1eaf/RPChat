// (games) the per-mistake hook: counts the mistake, calls lib[onLose]({ game, event, attempt, mistakes, ...details }) and, when details.restart is true, starts the next attempt of the same game with the same options (its media closed, its widget replaced); the game never ends here — only a win ends it
async (details: { event?: string; restart?: boolean; [key: string]: unknown } = {}) => {
  const game = (await sdk.state.session.get("game")) as { [key: string]: any } | null | undefined;
  if (!game) return null;
  const { restart, ...rest } = details;
  const attempt = Number(game.attempt ?? 1);
  const mistakes = Number(game.mistakes ?? 0) + 1;
  await sdk.state.session.set("game", { ...game, mistakes });
  const report = { game: String(game.game), event: "mistake", ...rest, attempt, mistakes };
  let outcome: unknown = null;
  if (typeof game.onLose === "string" && typeof lib[game.onLose] === "function") {
    try {
      outcome = await lib[game.onLose](report);
    } catch (err) {
      outcome = { error: String(err) };
    }
  }
  if (restart !== true) return { ...report, restarted: false, outcome };
  if (game.usesMedia) {
    try { await sdk.media.closeAll(); } catch { /* media switched off */ }
  }
  const next = await lib[String(game.starter)]({ ...(game.options ?? {}), attempt: attempt + 1, mistakes });
  return { ...report, restarted: true, next, outcome };
}
