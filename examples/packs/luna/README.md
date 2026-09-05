# Luna

An example companion pack for rp-code. Luna is a warm, curious character who
occasionally shows one of her pictures, plays a soft chime and schedules a
reminder to check in on you later.

Contents:

- `characters/luna/` — character definition, persona, avatar and two behaviour scripts
- `media/images/` — two tiny generated PNGs Luna can show
- `media/audio/chime.wav` — a short generated chime (16 kHz, mono, 0.6 s)

Requested capabilities: `media` (show images, play the chime) and `ui`
(desktop notifications). Everything else Luna uses (`chat`, `state`, `timers`,
`pack`) is trusted and always available.

The media files are produced by `../scripts/generate-media.mjs`.
