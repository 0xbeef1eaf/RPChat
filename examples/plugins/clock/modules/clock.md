Precise time and countdowns. Always available (trusted); no prompt is shown.

- Prefer the time in your `<senses>` line for small talk; call `now()` when the exact minute,
  date or weekday matters (birthdays, deadlines, "how long until…").
- `countdown(seconds, label)` is the easy way to be woken later: it raises `custom:countdown`
  when it ends. Subscribe **before** starting it, usually with `once: true`, and keep the
  handler short.
- Countdowns are remembered across app restarts; `pending()` lists the ones still running.

```ts
await sdk.events.on("custom:countdown", async (input) => {
  await sdk.llm.wake(`The countdown "${input.data.label}" you set just finished. Tell them so.`);
}, { once: true, label: "tea timer" });
const { endsAt } = await sdk.clock.countdown(240, "tea");
return { endsAt };
```
