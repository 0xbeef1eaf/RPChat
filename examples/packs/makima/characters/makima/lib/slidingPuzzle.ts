// (game) sliding puzzle: one pack image cut into a 3x3 or 4x4 grid with one gap, shuffled by legal moves; clicking a tile next to the gap slides it. Solving it calls lib[onWin]; exceeding moveLimit calls lib[onLose]({ game: "puzzle", event: "lost", reason: "moves", moves, attempt, mistakes }) and reshuffles a new attempt. Options { onLose, onWin?, image?: pack path (default: a "puzzle" or "wallpaper" tagged image), size?: 3, moveLimit?: 40 * (size - 2) }
async (opts: { onLose: string; onWin?: string; image?: string; size?: 3 | 4; moveLimit?: number; attempt?: number; mistakes?: number }) => {
  const size = opts.size === 4 ? 4 : 3;
  const moveLimit = Math.max(size * size, Math.round(opts.moveLimit ?? 40 * (size - 2)));
  let image = typeof opts.image === "string" ? (await sdk.pack.asset(opts.image)).path : "";
  if (!image) {
    const found = await sdk.pack.findAssets({ kind: "image", anyTags: ["puzzle", "wallpaper"], limit: 20 });
    const pick = found.length > 0 ? found : await sdk.pack.listAssets("media/images", "image");
    if (pick.length === 0) throw new Error("slidingPuzzle needs an image in the pack");
    image = pick[Math.floor(Math.random() * pick.length)]!.path;
  }
  const board = 300;
  const tile = board / size;
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#16161a;color:#eee;font:13px system-ui,sans-serif;user-select:none}
#s{display:flex;justify-content:space-between;padding:6px 10px}
#b{position:relative;width:${board}px;height:${board}px;margin:0 auto;background:#222}
.t{position:absolute;width:${tile - 2}px;height:${tile - 2}px;background-image:url({{asset:${image}}});background-size:${board}px ${board}px;border-radius:4px;cursor:pointer;transition:left .12s,top .12s}
</style><div id="s"><span id="m">0 moves</span><span>limit ${moveLimit}</span></div><div id="b"></div><script>
const N=${size},T=${tile},LIMIT=${moveLimit},post=(m)=>parent.postMessage(m,"*"),b=document.getElementById("b");
let pos=[...Array(N*N).keys()],gap=N*N-1,moves=0,done=false;// pos[slot]=tile id; the last id is the gap
const adj=(a,c)=>{const ar=Math.floor(a/N),ac=a%N,cr=Math.floor(c/N),cc=c%N;return Math.abs(ar-cr)+Math.abs(ac-cc)===1;};
const swap=(a,c)=>{[pos[a],pos[c]]=[pos[c],pos[a]];gap=pos[a]===N*N-1?a:c;};
for(let k=0,last=-1;k<60*N;k++){const n=[gap-N,gap+N,gap-1,gap+1].filter((s)=>s>=0&&s<N*N&&adj(s,gap)&&s!==last);const s=n[Math.floor(Math.random()*n.length)];last=gap;swap(s,gap);}
if(pos.every((v,i)=>v===i)){swap(gap-1,gap);}
const els=[];for(let id=0;id<N*N-1;id++){const e=document.createElement("div");e.className="t";e.style.backgroundPosition=(-(id%N)*T)+"px "+(-Math.floor(id/N)*T)+"px";b.appendChild(e);els[id]=e;
 e.onclick=()=>{if(done)return;const slot=pos.indexOf(id);if(!adj(slot,gap))return;swap(slot,gap);moves++;document.getElementById("m").textContent=moves+" moves";draw();
  if(pos.every((v,i)=>v===i)){done=true;post({event:"won",moves});}else if(moves>LIMIT){done=true;post({event:"lost",reason:"moves",moves});}};}
const draw=()=>{pos.forEach((id,slot)=>{if(id===N*N-1)return;els[id].style.left=(slot%N)*T+1+"px";els[id].style.top=Math.floor(slot/N)*T+1+"px";});};draw();
</script>`;
  const game = await lib.gameSetup({
    game: "puzzle", starter: "slidingPuzzle", options: opts, widgetId: "game-puzzle", image, size, moveLimit,
    subscriptions: [{
      event: "widget-message", filter: { widgetId: "game-puzzle" }, label: "game:puzzle",
      handler: async (input: any) => {
        const m = (input.data && input.data.message) || {};
        if (m.event === "lost") return await lib.gameLost({ event: "lost", reason: m.reason, moves: m.moves, restart: true });
        if (m.event === "won") return await lib.endGame({ moves: m.moves });
        return null;
      },
    }],
  });
  await sdk.widgets.show({ id: "game-puzzle", title: `Puzzle ${size}×${size} — attempt ${game.attempt}`, html, width: board + 16, height: board + 40, position: "center" });
  return { started: "puzzle", attempt: game.attempt, image, size, moveLimit };
}
