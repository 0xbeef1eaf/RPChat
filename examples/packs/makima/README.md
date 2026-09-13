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
| `media/audio/attention.wav` | low two-tone chime played once before a request |
| `media/audio/click.wav` | soft click for a small acknowledgement |
| `media/video/ring-pulse.webm` | 2 s decorative ring animation |

Tags and descriptions live in `media.json`; if you add files, add an entry (or
drop them into a tagged folder such as `media/images/wallpapers/`). The
`wallpaper` tag is what the character searches for with
`sdk.pack.findAssets({ tags: ["wallpaper", "control"] })`.

## What the pack uses

- **Capabilities**: `media`, `ui`, `wallpaper`, `avatar`, `presence`, `events`
  (the trusted modules `chat`, `state`, `memory`, `mood`, `routine`, `timers`,
  `llm`, `pack` are always available).
- **Behaviours**: `on-session-start.ts` (time- and count-aware greeting, shows
  the avatar, sets her daily routine once), `on-user-message.ts` (mood nudges
  on apologies and thanks, safeword handling; never skips the model),
  `on-timer.ts` (re-asks about an assigned task with the chime), `on-event.ts`
  (`user-back` acknowledgement; one dry remark per hour when the user switches
  to a game).
- **Character**: `avatarSet` with four expressions, mood baselines, model hints,
  six example exchanges and a persona with a hard boundary section.
- **Function library**: `characters/makima/lib/glance.ts` ships one `sdk.lib`
  function, `lib.glance()`, which shows a random `portrait`-tagged image for
  five seconds and returns its path. It is in her prompt's `<library>` from the
  first install; anything she defines herself with `sdk.lib.define` lands in the
  same folder of the installed copy.

## Safety

The persona is deliberately unsettling *as fiction*: patient, polite,
controlling. It is written to stay inside the app (desktop and conversation
only), never to give harmful real-world instructions, and to drop character
immediately if the user shows real distress or says the safeword
**chainsaw**. See the "What you never do" and "Boundaries" sections of
`characters/makima/persona.md`.
