# Makima (unofficial fan pack)

A fan-made roleplay persona of **Makima** for rp-code. Makima is a character
created by **Tatsuki Fujimoto** (*Chainsaw Man*, Shueisha / MAPPA). This pack
is unofficial fan content, not affiliated with or endorsed by the rights
holders, and contains **no artwork, audio or text from the manga or anime**.

## Placeholder art

Every image, sound and clip in this pack is a procedural placeholder generated
by `../scripts/generate-media.mjs`: abstract compositions in her palette
(auburn hair, pale skin, yellow ringed eyes) rather than drawings of the
character. They exist so the pack works out of the box. Replace them with your
own files, keeping the **same file names** so `character.json` and `media.json`
keep pointing at them (or edit those files if you rename):

| file | what it is used for |
|------|---------------------|
| `characters/makima/avatar.png` (256×256) | the chat-list avatar |
| `characters/makima/expressions/{neutral,smile,stare,displeased}.png` | the on-screen avatar (`avatarSet`); png/gif/webp/apng or a short webm each |
| `media/images/wallpapers/red-dusk.png` (1920×1080) | wallpaper for "control" scenes (tags `wallpaper`, `control`, `dusk`) |
| `media/images/wallpapers/dim-office.png` | wallpaper for working hours (`wallpaper`, `work`, `office`) |
| `media/images/wallpapers/ring-motif.png` | wallpaper for late, quiet talk (`wallpaper`, `quiet`, `ring`) |
| `media/images/cards/*.png` (64×64, eight) | tiles for the mini games (tag `card`): one flat colour with a white shape each |
| `media/audio/attention.wav` | low two-tone chime played once before a request |
| `media/audio/click.wav` | soft click for a small acknowledgement |
| `media/video/ring-pulse.webm` | 2 s decorative ring animation |

Tags and descriptions live in `media.json`; if you add files, add an entry (or
drop them into a tagged folder such as `media/images/wallpapers/`). The
`wallpaper` tag is what the character searches for with
`sdk.pack.findAssets({ tags: ["wallpaper", "control"] })`.

## What the pack uses

- **Modules used**: `media`, `ui`, `wallpaper`, `avatar`, `presence`, `events`
  and more (the trusted modules `chat`, `state`, `memory`, `mood`, `routine`,
  `timers`, `llm`, `pack` are always available). Nothing is declared in
  `pack.json`: permissions are app-wide, set under Settings → Permissions, and
  the scripts cope with a module that is switched off.
- **Behaviours**: `on-session-start.ts` (time- and count-aware greeting, shows
  the avatar, sets her daily routine once), `on-user-message.ts` (mood nudges
  on apologies and thanks, safeword handling; never skips the model),
  `on-timer.ts` (re-asks about an assigned task with the chime), `on-event.ts`
  (`user-back` acknowledgement; one dry remark per hour when the user switches
  to a game).
- **Character**: `avatarSet` with four expressions, mood baselines, model hints,
  six example exchanges and a persona with a hard boundary section.
- **Function library**: `characters/makima/lib/glance.ts` ships one `lib`
  function, `lib.glance()`, which shows a random `portrait`-tagged image for
  five seconds and returns its path, plus the mini games below. They are in her
  prompt's `<library>` from the first install; anything she saves herself
  with `lib.register` lands in the same folder of the installed copy.

## Mini games

Six desktop games live in `characters/makima/lib/`, each one library function
that she calls from an action, e.g. `await lib.memoryGame({ onLose: "punish",
onWin: "reward", pairs: 6 })`. They run on `sdk.widgets` (HTML in a sandboxed
window, pack images through `{{asset:…}}` placeholders) and `sdk.media`
(clickable images, `media-clicked` / `media-closed` events) and are driven by
`sdk.events` handlers, so no action ever waits: the starter returns at once
and the game plays out on the desktop.

| function | what the user does | a mistake is… |
|---|---|---|
| `memoryGame({ pairs?, maxMistakes?, timeLimitS?, tags? })` | flip cards (pack images) to find the pairs, against a timer | a wrong pair; more than `maxMistakes` of them or the timer running out reshuffles |
| `simonSays({ length?, images?, flashMs?, tags? })` | watch images flash in a small window, then click the images that appear around the screen in that order | a click out of order (a new sequence starts) |
| `writeLines({ line, count? })` | type the given line `count` times, exactly | the first wrong character (the line restarts) |
| `whackAMole({ rounds?, showMs?, maxMisses?, tags? })` | click each image before it vanishes | a mole that times out; more than `maxMisses` restarts from round one |
| `reactionTest({ rounds?, thresholdMs? })` | click the panel the moment it turns green | clicking early, or slower than `thresholdMs` (the round repeats) |
| `slidingPuzzle({ image?, size?, moveLimit? })` | slide the tiles of one pack image back into place | exceeding `moveLimit` (a new shuffle) |

**The `onLose` convention.** Every starter takes `onLose` (required) and
`onWin` (optional): the *names* of library functions, because the handlers that
notice a mistake run later in a fresh isolate where no closure survives. On
**every** mistake the game calls `lib[onLose](info)` with
`{ game, event, attempt, mistakes, …details }` — `event` says what happened
(`"mistake"`, `"miss"`, `"lost"`), `mistakes` counts every mistake since the
game was started, `attempt` the current round, and the details are
game-specific (`typed`/`at`/`line`, `expected`/`clicked`, `reason`, `moves`,
`ms`…). A loss never ends a game: after the loss function returns, the game
either keeps going (a wrong keystroke, a missed mole) or restarts itself with
the same options and `attempt + 1` (a wrong Simon click, a puzzle over its move
limit, a memory game out of tries). The game ends only when it is **won**: then
`lib[onWin]({ game, result: "win", attempt, mistakes, …details })` runs (when
given), its widget and media are closed, its subscriptions removed and the
state cleared. `lib.quitGame()` is the way out: it cleans up without calling
either function.

Shipped with them:

- `punish` — Makima's loss function: a displeased expression, one line, the red
  dusk wallpaper (when `wallpaper` is available), then `sdk.llm.wake` so she
  reacts in character. `reward` — a smile and a line on a win.
- `gameSetup`, `gameLost`, `endGame`, `quitGame`, `molePop` — the shared
  machinery (session key `game`, subscription labels `game:*`); a new game of
  your own only needs a starter that calls `lib.gameSetup(...)` and handlers
  that call `lib.gameLost(...)` / `lib.endGame(...)`.

Limits worth knowing: a handler runs as its own action (about 10 s, 50 SDK
calls), and an interaction that arrives while the same handler is still busy is
dropped, so the loss function should be quick; the widget checks keystrokes and
timers itself and posts one message per mistake.

## Safety

The persona is deliberately unsettling *as fiction*: patient, polite,
controlling. It is written to stay inside the app (desktop and conversation
only), never to give harmful real-world instructions, and to drop character
immediately if the user shows real distress or says the safeword
**chainsaw**. See the "What you never do" and "Boundaries" sections of
`characters/makima/persona.md`.
