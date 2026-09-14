// (game) write lines: a widget shows a line to copy and an input; the widget checks every keystroke against the line, and the first wrong character clears the input, restarts that line and calls lib[onLose]({ game: "lines", event: "mistake", typed, at, line, attempt, mistakes }); the game keeps going until every line is typed cleanly, which calls lib[onWin]. Options { onLose, onWin?, line: string, count?: 5 }
async (opts: { onLose: string; onWin?: string; line: string; count?: number; attempt?: number; mistakes?: number }) => {
  const line = String(opts.line ?? "").replace(/\s+/g, " ").trim();
  if (line.length === 0) throw new Error("writeLines needs a line to copy");
  const count = Math.max(1, Math.min(50, Math.round(opts.count ?? 5)));
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:10px;background:#16161a;color:#eee;font:14px system-ui,sans-serif}
#l{padding:8px 10px;background:#222;border-radius:8px;letter-spacing:.3px;line-height:1.4}
#p{margin:8px 0 6px;font-size:12px;color:#aaa;display:flex;justify-content:space-between}
input{width:100%;box-sizing:border-box;padding:8px;font:14px system-ui,sans-serif;border-radius:8px;border:2px solid #444;background:#111;color:#eee;outline:none}
input.bad{border-color:#d33;animation:sh .25s}@keyframes sh{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
</style><div id="l">${escape(line)}</div><div id="p"><span id="n">Line 1 of ${count}</span><span id="e">0 mistakes</span></div><input id="i" autofocus autocomplete="off" spellcheck="false"><script>
const LINE=${JSON.stringify(line)},COUNT=${count},post=(m)=>parent.postMessage(m,"*"),i=document.getElementById("i");
let n=0,mistakes=0;i.focus();
i.oninput=()=>{const v=i.value;
 if(!LINE.startsWith(v)){let at=0;while(at<v.length&&v[at]===LINE[at])at++;mistakes++;
  document.getElementById("e").textContent=mistakes+" mistake"+(mistakes===1?"":"s");
  post({event:"mistake",typed:v,at,line:n+1,mistakes});i.value="";i.classList.add("bad");setTimeout(()=>i.classList.remove("bad"),300);return;}
 if(v===LINE){n++;i.value="";if(n>=COUNT){i.disabled=true;post({event:"won",mistakes});return;}
  document.getElementById("n").textContent="Line "+(n+1)+" of "+COUNT;}};
</script>`;
  const game = await lib.gameSetup({
    game: "lines", starter: "writeLines", options: opts, widgetId: "game-lines", line, count,
    subscriptions: [{
      event: "widget-message", filter: { widgetId: "game-lines" }, label: "game:lines",
      handler: async (input: any) => {
        const m = (input.data && input.data.message) || {};
        if (m.event === "mistake") return await lib.gameLost({ event: "mistake", typed: m.typed, at: m.at, line: m.line, roundMistakes: m.mistakes });
        if (m.event === "won") return await lib.endGame({ lines: (await sdk.state.session.get("game") as any)?.count ?? null });
        return null;
      },
    }],
  });
  await sdk.widgets.show({ id: "game-lines", title: `Write it ${count} times — attempt ${game.attempt}`, html, width: 420, height: 170, position: "center" });
  return { started: "lines", attempt: game.attempt, line, count };
}
