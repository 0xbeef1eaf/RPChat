// (game, internal) whack-a-mole: pop the next mole — one random pool image at a random spot for showMs (click closes it) — and remember it as the current one in the "game" session state
async () => {
  const game = (await sdk.state.session.get("game")) as { [key: string]: any } | null | undefined;
  if (!game || game.game !== "mole") return null;
  const pool = game.pool as string[];
  const path = pool[Math.floor(Math.random() * pool.length)]!;
  const h = await sdk.media.showImage(path, { durationMs: Number(game.showMs), closeOnClick: true, width: 140 });
  const round = Number(game.round ?? 0) + 1;
  await sdk.state.session.set("game", { ...game, current: h.id, round });
  return { round, mediaId: h.id, asset: path };
}
