// (game) Simon says: a small centred widget flashes a sequence of pack images one at a time, then those images (plus decoys) appear around the screen and must be clicked in the flashed order; a wrong click calls lib[onLose]({ game: "simon", event: "mistake", expected, clicked, progress, attempt, mistakes }) and a new sequence starts; clicking the whole sequence calls lib[onWin]. Options { onLose, onWin?, length?: 4, images?: 4, flashMs?: 700, tags?: ["card"] }
async (opts: { onLose: string; onWin?: string; length?: number; images?: number; flashMs?: number; tags?: string[]; attempt?: number; mistakes?: number }) => {
  const images = Math.max(2, Math.min(8, Math.round(opts.images ?? 4)));
  const length = Math.max(2, Math.min(images, Math.round(opts.length ?? 4)));
  const flashMs = Math.max(200, Math.min(3000, Math.round(opts.flashMs ?? 700)));
  let faces = await sdk.pack.findAssets({ kind: "image", anyTags: opts.tags ?? ["card"], limit: 50 });
  if (faces.length < images) faces = await sdk.pack.listAssets("media/images", "image");
  if (faces.length < images) throw new Error(`simonSays needs ${images} different images; the pack has ${faces.length}`);
  const shuffle = <T>(list: T[]): T[] => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    return list;
  };
  const pool = shuffle(faces.map((f) => f.path)).slice(0, images);
  const sequence = shuffle(pool.slice()).slice(0, length);
  const slides = sequence.map((p, i) => `<img data-i="${i}" src="{{asset:${p}}}" alt="">`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#16161a;color:#eee;font:13px system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}
#s{width:150px;height:150px;display:flex;align-items:center;justify-content:center;background:#222;border-radius:12px}
#s img{display:none;max-width:90%;max-height:90%}#s img.on{display:block}
</style><div id="s">${slides}</div><p id="m">Watch the order…</p><script>
const imgs=[...document.querySelectorAll("#s img")],FLASH=${flashMs};let i=0;
const step=()=>{imgs.forEach(x=>x.classList.remove("on"));if(i>=imgs.length){document.getElementById("m").textContent="Now click them in that order.";parent.postMessage({event:"shown"},"*");return;}
 setTimeout(()=>{imgs[i].classList.add("on");i++;setTimeout(step,FLASH);},250);};
setTimeout(step,600);
</script>`;
  // Both the click and the click-close of an image lead here; whichever runs first consumes the item.
  const onClick = async (input: any) => {
    const game = (await sdk.state.session.get("game")) as any;
    const id = input.data && input.data.mediaId;
    if (!game || game.game !== "simon" || !game.shown || !(id in game.shown)) return null;
    const clicked = game.shown[id];
    const expected = game.sequence[game.progress];
    const shown = { ...game.shown };
    delete shown[id];
    if (clicked !== expected) return await lib.gameLost({ event: "mistake", expected, clicked, progress: game.progress, restart: true });
    const progress = game.progress + 1;
    if (progress >= game.sequence.length) return await lib.endGame({ length: game.sequence.length });
    await sdk.state.session.set("game", { ...game, shown, progress });
    return { progress };
  };
  const game = await lib.gameSetup({
    game: "simon", starter: "simonSays", options: opts, widgetId: "game-simon", usesMedia: true, sequence, pool, progress: 0, shown: null,
    subscriptions: [
      {
        event: "widget-message", filter: { widgetId: "game-simon" }, label: "game:simon-shown",
        handler: async (input: any) => {
          const m = input.data && input.data.message;
          const game = (await sdk.state.session.get("game")) as any;
          if (!m || m.event !== "shown" || !game || game.game !== "simon") return null;
          try { await sdk.widgets.close("game-simon"); } catch { /* already gone */ }
          const shown: Record<string, string> = {};
          for (const path of game.pool) {
            const h = await sdk.media.showImage(path, { closeOnClick: true, width: 150 });
            shown[h.id] = path;
          }
          await sdk.state.session.set("game", { ...game, shown, progress: 0 });
          return { spawned: Object.keys(shown).length };
        },
      },
      { event: "media-clicked", label: "game:simon-click", handler: onClick },
      { event: "media-closed", filter: { reason: "click" }, label: "game:simon-closed", handler: onClick },
    ],
  });
  await sdk.widgets.show({ id: "game-simon", title: `Simon says — attempt ${game.attempt}`, html, width: 220, height: 230, position: "center" });
  return { started: "simon", attempt: game.attempt, length, images, flashMs };
}
