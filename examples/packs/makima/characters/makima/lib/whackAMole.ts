// (game) whack-a-mole: pack images pop up one at a time at random spots for showMs and must be clicked before they vanish; a click scores and pops the next one, a mole that times out calls lib[onLose]({ game: "mole", event: "miss", round, hits, misses, attempt, mistakes }) and pops the next one, more than maxMisses misses calls it with event "lost" and restarts from round one; `rounds` hits call lib[onWin]. Options { onLose, onWin?, rounds?: 10, showMs?: 1500, maxMisses?: rounds / 2, tags?: ["card"] }
async (opts: { onLose: string; onWin?: string; rounds?: number; showMs?: number; maxMisses?: number; tags?: string[]; attempt?: number; mistakes?: number }) => {
  const rounds = Math.max(1, Math.min(50, Math.round(opts.rounds ?? 10)));
  const showMs = Math.max(400, Math.min(10000, Math.round(opts.showMs ?? 1500)));
  const maxMisses = Math.max(0, Math.round(opts.maxMisses ?? rounds / 2));
  let faces = await sdk.pack.findAssets({ kind: "image", anyTags: opts.tags ?? ["card"], limit: 50 });
  if (faces.length === 0) faces = await sdk.pack.listAssets("media/images", "image");
  if (faces.length === 0) throw new Error("whackAMole needs at least one pack image");
  await lib.gameSetup({
    game: "mole", starter: "whackAMole", options: opts, widgetId: "game-mole", usesMedia: true,
    pool: faces.map((f) => f.path), rounds, showMs, maxMisses, round: 0, hits: 0, misses: 0, current: null,
    subscriptions: [
      {
        event: "media-clicked", label: "game:mole-hit",
        handler: async (input: any) => {
          const game = (await sdk.state.session.get("game")) as any;
          if (!game || game.game !== "mole" || !game.current || input.data.mediaId !== game.current) return null;
          const hits = Number(game.hits) + 1;
          await sdk.state.session.set("game", { ...game, hits, current: null });
          if (hits >= game.rounds) return await lib.endGame({ hits, misses: game.misses });
          return await lib.molePop();
        },
      },
      {
        event: "media-closed", filter: { reason: "timeout" }, label: "game:mole-miss",
        handler: async (input: any) => {
          const game = (await sdk.state.session.get("game")) as any;
          if (!game || game.game !== "mole" || !game.current || input.data.mediaId !== game.current) return null;
          const misses = Number(game.misses) + 1;
          await sdk.state.session.set("game", { ...game, misses, current: null });
          const over = misses > game.maxMisses;
          const lost = await lib.gameLost({ event: over ? "lost" : "miss", round: game.round, hits: game.hits, misses, restart: over });
          return over ? lost : await lib.molePop();
        },
      },
    ],
  });
  const first = await lib.molePop();
  return { started: "mole", attempt: Number(opts.attempt ?? 1), rounds, showMs, maxMisses, first };
}
