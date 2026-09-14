// (games) stop the running game without calling onWin or onLose: closes its widget and media, removes its "game:*" event subscriptions and clears session key "game"; returns the record that was stopped, or null when no game was running
async () => {
  const game = (await sdk.state.session.get("game")) as { [key: string]: any } | null | undefined;
  if (!game) return null;
  try { await sdk.widgets.close(String(game.widgetId)); } catch { /* widgets switched off or already closed */ }
  if (game.usesMedia) {
    try { await sdk.media.closeAll(); } catch { /* media switched off */ }
  }
  for (const s of await sdk.events.list()) {
    if (typeof s.label === "string" && s.label.startsWith("game:")) {
      try { await sdk.events.off(s.id); } catch { /* already gone */ }
    }
  }
  await sdk.state.session.delete("game");
  return game;
}
