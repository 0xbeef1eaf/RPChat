// (games, internal) start or restart a game round: puts a different running game away, stores the game record under session key "game" (attempt and mistakes carry over on a restart), (re)subscribes the given event handlers with labels "game:<name>" so restarts never stack duplicates, and returns the stored record
async (record: { game: string; starter: string; options: Record<string, unknown>; widgetId: string; usesMedia?: boolean; subscriptions?: Array<{ event: string; handler: (input: any) => unknown; filter?: Record<string, unknown>; label: string }>; [key: string]: unknown }) => {
  const opts = record.options as { onLose?: string; onWin?: string; attempt?: number; mistakes?: number };
  const previous = (await sdk.state.session.get("game")) as { starter?: string } | null | undefined;
  const restart = typeof opts.attempt === "number" && opts.attempt > 1 && Boolean(previous && previous.starter === record.starter);
  if (previous && !restart) await lib.quitGame(); // a fresh start: the old game goes without callbacks
  const { subscriptions = [], ...rest } = record;
  const game = {
    ...rest,
    onLose: typeof opts.onLose === "string" ? opts.onLose : null,
    onWin: typeof opts.onWin === "string" ? opts.onWin : null,
    attempt: restart ? Number(opts.attempt) : 1,
    mistakes: restart ? Number(opts.mistakes ?? 0) : 0,
    startedAt: Date.now(),
  };
  await sdk.state.session.set("game", game as any);
  // Handlers run later in a fresh run (no closures): they read the record back from session state.
  const existing = await sdk.events.list();
  for (const s of subscriptions) {
    const found = existing.find((e) => e.label === s.label);
    if (found && restart) continue; // keep the live subscription across attempts
    if (found) await sdk.events.off(found.id);
    await sdk.events.on(s.event as any, s.handler, { ...(s.filter ? { filter: s.filter as any } : {}), label: s.label });
  }
  return game;
}
