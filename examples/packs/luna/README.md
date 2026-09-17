# Luna

An example companion pack for rpchat. Luna is a warm, curious character who
occasionally shows one of her pictures, plays a soft chime and schedules a
reminder to check in on you later.

Contents:

- `characters/luna/` — character definition, persona, avatar and two behaviour scripts
- `media/images/` — two tiny generated PNGs Luna can show
- `media/audio/chime.wav` — a short generated chime (16 kHz, mono, 0.6 s)
- `media/images/teal-card.png`, `media/video/testcard.webm` — placeholder test media
- `media.json` — tags and one-line descriptions for the media, plus a tag vocabulary

Modules used: `media` (show images, play the chime) and `ui` (desktop
notifications) — on unless you switch them off under Settings → Permissions,
whole or one function at a time; packs declare no permissions. Everything else
Luna uses (`chat`, `state`, `timers`, `pack`) is trusted: it stays inside the
app's own data, and it is on by default like the rest.

The media files are produced by `../scripts/generate-media.mjs`.
