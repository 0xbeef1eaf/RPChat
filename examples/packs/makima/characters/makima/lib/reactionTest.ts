// (game) reaction test in a widget: the panel turns green after a random wait and must be clicked at once; clicking early or slower than thresholdMs repeats the round and calls lib[onLose]({ game: "reaction", event: "mistake", reason: "early" | "slow", ms, round, attempt, mistakes }); `rounds` clean rounds call lib[onWin]. Options { onLose, onWin?, rounds?: 5, thresholdMs?: 500 }
async (opts: { onLose: string; onWin?: string; rounds?: number; thresholdMs?: number; attempt?: number; mistakes?: number }) => {
  const rounds = Math.max(1, Math.min(30, Math.round(opts.rounds ?? 5)));
  const thresholdMs = Math.max(150, Math.min(5000, Math.round(opts.thresholdMs ?? 500)));
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#16161a;color:#eee;font:14px system-ui,sans-serif;user-select:none}
#p{height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#7a2b36;cursor:pointer;transition:background .1s}
#p.go{background:#2e8b57}#p b{font-size:22px}#s{padding:6px 10px;font-size:12px;color:#aaa;display:flex;justify-content:space-between}
</style><div id="p"><b id="t">Wait for green…</b><span id="h">then click as fast as you can</span></div><div id="s"><span id="r">Round 1 of ${rounds}</span><span id="e">0 mistakes</span></div><script>
const ROUNDS=${rounds},MAX=${thresholdMs},post=(m)=>parent.postMessage(m,"*"),p=document.getElementById("p"),t=document.getElementById("t");
let round=1,mistakes=0,armed=false,at=0,timer=0,times=[];
const arm=()=>{p.classList.remove("go");armed=false;t.textContent="Wait for green…";timer=setTimeout(()=>{p.classList.add("go");t.textContent="CLICK!";armed=true;at=performance.now();},1500+Math.random()*2500);};
const miss=(reason,ms)=>{mistakes++;document.getElementById("e").textContent=mistakes+" mistake"+(mistakes===1?"":"s");post({event:"mistake",reason,ms,round,mistakes});t.textContent=reason==="early"?"Too early!":"Too slow ("+ms+" ms)";setTimeout(arm,900);};
p.onclick=()=>{if(!armed){clearTimeout(timer);if(!p.classList.contains("go"))miss("early",0);return;}
 const ms=Math.round(performance.now()-at);armed=false;if(ms>MAX){miss("slow",ms);return;}
 times.push(ms);t.textContent=ms+" ms";round++;
 if(round>ROUNDS){post({event:"won",times,mistakes});p.onclick=null;return;}
 document.getElementById("r").textContent="Round "+round+" of "+ROUNDS;setTimeout(arm,900);};
arm();
</script>`;
  const game = await lib.gameSetup({
    game: "reaction", starter: "reactionTest", options: opts, widgetId: "game-reaction", rounds, thresholdMs,
    subscriptions: [{
      event: "widget-message", filter: { widgetId: "game-reaction" }, label: "game:reaction",
      handler: async (input: any) => {
        const m = (input.data && input.data.message) || {};
        if (m.event === "mistake") return await lib.gameLost({ event: "mistake", reason: m.reason, ms: m.ms, round: m.round, roundMistakes: m.mistakes });
        if (m.event === "won") return await lib.endGame({ times: m.times });
        return null;
      },
    }],
  });
  await sdk.widgets.show({ id: "game-reaction", title: `Reaction — attempt ${game.attempt}`, html, width: 300, height: 190, position: "center" });
  return { started: "reaction", attempt: game.attempt, rounds, thresholdMs };
}
