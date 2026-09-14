// (game) memory: flip pairs of pack images in a widget. Every wrong pair calls lib[onLose]({ game: "memory", event: "mistake", attempt, mistakes, roundMistakes, moves }); more than maxMistakes wrong pairs or the timer running out calls it with event "lost" and reshuffles a new attempt; matching every pair calls lib[onWin] and ends the game. Options { onLose, onWin?, pairs?: 6, maxMistakes?: pairs * 2, timeLimitS?: 90, tags?: ["card"] }
async (opts: { onLose: string; onWin?: string; pairs?: number; maxMistakes?: number; timeLimitS?: number; tags?: string[]; attempt?: number; mistakes?: number }) => {
  const pairs = Math.max(2, Math.min(12, Math.round(opts.pairs ?? 6)));
  const maxMistakes = Math.max(0, Math.round(opts.maxMistakes ?? pairs * 2));
  const timeLimitS = Math.max(10, Math.round(opts.timeLimitS ?? 90));
  let faces = await sdk.pack.findAssets({ kind: "image", anyTags: opts.tags ?? ["card"], limit: 50 });
  if (faces.length < pairs) faces = await sdk.pack.listAssets("media/images", "image");
  if (faces.length < pairs) throw new Error(`memoryGame needs ${pairs} different images; the pack has ${faces.length}`);
  const shuffle = <T>(list: T[]): T[] => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    return list;
  };
  const picked = shuffle(faces.map((f) => f.path)).slice(0, pairs);
  const deck = shuffle(picked.flatMap((_p, k) => [k, k]));
  const cols = deck.length <= 12 ? 4 : deck.length <= 16 ? 4 : 6;
  const rows = Math.ceil(deck.length / cols);
  const cards = deck.map((k) => `<div class="c" data-k="${k}"><div class="f"><img src="{{asset:${picked[k]}}}" alt=""></div></div>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#16161a;color:#eee;font:13px system-ui,sans-serif;user-select:none}
#t{display:flex;justify-content:space-between;padding:6px 10px}
#g{display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:0 8px 8px}
.c{aspect-ratio:1;border-radius:8px;background:#3a2a2e;border:2px solid #6b3b45;cursor:pointer;position:relative}
.c .f{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:#222;border-radius:6px}
.c.o .f,.c.m .f{display:flex}.c.m{border-color:#e8c547;cursor:default}.f img{max-width:88%;max-height:88%}
</style><div id="t"><span id="s">0 mistakes</span><span id="k">${timeLimitS}s</span></div><div id="g">${cards}</div><script>
const P=${pairs},MAX=${maxMistakes},LIMIT=${timeLimitS},post=(m)=>parent.postMessage(m,"*");
const cards=[...document.querySelectorAll(".c")];let open=[],lock=false,moves=0,mistakes=0,matched=0,left=LIMIT;
const timer=setInterval(()=>{left--;document.getElementById("k").textContent=left+"s";
 if(left<=0){clearInterval(timer);lock=true;post({event:"lost",reason:"timeout",moves,mistakes});}},1000);
for(const c of cards)c.onclick=()=>{
 if(lock||open.includes(c)||c.classList.contains("m"))return;
 c.classList.add("o");open.push(c);if(open.length<2)return;
 moves++;lock=true;const [a,b]=open;
 if(a.dataset.k===b.dataset.k){a.classList.add("m");b.classList.add("m");matched++;open=[];lock=false;
  if(matched===P){clearInterval(timer);post({event:"won",moves,seconds:LIMIT-left});}return;}
 mistakes++;document.getElementById("s").textContent=mistakes+" mistake"+(mistakes===1?"":"s");
 const over=mistakes>MAX;post({event:"mistake",mistakes,moves,over});
 setTimeout(()=>{a.classList.remove("o");b.classList.remove("o");open=[];lock=over;if(over)clearInterval(timer);},700);};
</script>`;
  const game = await lib.gameSetup({
    game: "memory", starter: "memoryGame", options: opts, widgetId: "game-memory", pairs, maxMistakes, timeLimitS,
    subscriptions: [{
      event: "widget-message", filter: { widgetId: "game-memory" }, label: "game:memory",
      handler: async (input: any) => {
        const m = (input.data && input.data.message) || {};
        if (m.event === "mistake") return await lib.gameLost({ event: m.over ? "lost" : "mistake", reason: m.over ? "mistakes" : undefined, roundMistakes: m.mistakes, moves: m.moves, restart: m.over === true });
        if (m.event === "lost") return await lib.gameLost({ event: "lost", reason: m.reason, roundMistakes: m.mistakes, moves: m.moves, restart: true });
        if (m.event === "won") return await lib.endGame({ moves: m.moves, seconds: m.seconds });
        return null;
      },
    }],
  });
  await sdk.widgets.show({ id: "game-memory", title: `Memory — attempt ${game.attempt}`, html, width: cols * 78 + 16, height: rows * 78 + 44, position: "center" });
  return { started: "memory", attempt: game.attempt, pairs, maxMistakes, timeLimitS };
}
