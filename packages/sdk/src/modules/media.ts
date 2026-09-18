import type { CapabilityModuleSpec } from '@rp/shared';

export const mediaModule: CapabilityModuleSpec = {
  id: 'media',
  version: '1.4.0',
  title: 'Media playback',
  summary: 'Show images and play video/audio from the pack in an overlay window on the user\'s screen, or wash one over whole screens.',
  permission: 'pack',
  apiTypeName: 'MediaApi',
  typings: `/**
 * Show pack media on the user's screen. Images and videos open in a frameless overlay
 * window whose monitor, placement, stacking layer, opacity and click-through you control
 * through OverlayOptions; audio plays without a window. Only pack assets can be shown
 * (no URLs, no files outside the pack). Every call returns a MediaHandle you can pass
 * to update() or close(). Use sdk.display to discover monitors and backend abilities.
 *
 * The user can cap how many images, videos and sounds run at once. Over that cap a call still
 * returns straight away, with handle.state === 'queued': the item waits its turn and opens by
 * itself when one of its kind closes (raising the 'media-started' event). Never wait for a slot
 * yourself — ask for what you want and let the queue order it.
 */
interface MediaApi {
  /**
   * Show an image asset in an overlay.
   * @param asset An AssetRef from sdk.pack, or a pack-relative path such as "media/images/smile.png".
   * @param options durationMs (auto-close), caption, closeOnClick (default true; false keeps the image up after a click,
   *   a timed image never closes on click), plus OverlayOptions: monitor, position or x/y,
   *   layer ('top' default; 'background' puts it behind windows like a wallpaper), opacity, clickThrough, width, height.
   *   Without monitor/position/x/y the window is placed on a random monitor at a random in-bounds spot; without width/height it
   *   is drawn a random size, 5%–50% of that monitor (the picture keeps its aspect ratio inside that box).
   * @returns Handle of the shown image.
   * @example await sdk.media.showImage("media/images/smile.png", { durationMs: 8000, position: "bottom-right" });
   * @example await sdk.media.showImage("media/images/rain.png", { monitor: "cursor", layer: "background", opacity: 0.6, clickThrough: true, width: 1920 });
   * @example const h = await sdk.media.showImage("media/images/target.png", { closeOnClick: false, width: 160 }); // react to clicks with sdk.events.on("media-clicked", …, { filter: { mediaId: h.id } })
   */
  showImage(asset: AssetRef | string, options?: ShowImageOptions): Promise<MediaHandle>;
  /**
   * Play a video asset in an overlay. Resolves as soon as playback starts, not when it ends.
   * @param asset An AssetRef or pack-relative path (mp4/webm).
   * @param options volume (0..1), loop, closeOnEnd (default true), muted, plus OverlayOptions
   *   (monitor, position or x/y, layer, opacity, clickThrough, width, height).
   * @returns Handle of the playing video.
   * @example await sdk.media.playVideo("media/video/wave.mp4", { position: "top-right", width: 360 });
   */
  playVideo(asset: AssetRef | string, options?: PlayVideoOptions): Promise<MediaHandle>;
  /**
   * Play an audio asset (no window). Resolves as soon as playback starts.
   * @param asset An AssetRef or pack-relative path (mp3/ogg/wav).
   * @param options volume (0..1), loop.
   * @returns Handle of the playing audio; close() stops it.
   * @example const song = await sdk.media.playAudio("media/audio/lullaby.mp3", { volume: 0.5 });
   */
  playAudio(asset: AssetRef | string, options?: PlayAudioOptions): Promise<MediaHandle>;
  /**
   * Cover whole screens with an image or video: a click-through wash on the overlay layer, above
   * everything, that the user can keep working through. The picture is fitted into the screen keeping
   * its aspect ratio and copies repeat outwards from that centred one, so a shape that does not match
   * the screen tiles instead of stretching. Resolves once it is up, not when it ends.
   * @param asset An AssetRef or pack-relative path to an image or a video.
   * @param options monitor ('all' by default: every screen; or one monitor), opacity (0..1, default 0.25 —
   *   keep it under 0.5 so the user can still see their work, higher only when they asked for it),
   *   durationMs (auto-close), and for video volume (0..1, default 0.5), loop (default: on with durationMs),
   *   muted. Placement, size, layer and click-through cannot be set: it always fills the screen, sits on
   *   the overlay layer and lets clicks through.
   * @returns Handle of the overlay; close() takes it off every screen at once.
   * @example await sdk.media.overlay("media/images/hearts.png", { opacity: 0.2, durationMs: 15000 });
   * @example const rain = await sdk.media.overlay("media/video/rain.mp4", { monitor: "cursor", opacity: 0.3 });
   */
  overlay(asset: AssetRef | string, options?: MediaOverlayOptions): Promise<MediaHandle>;
  /**
   * Change an open image/video overlay in place: move it, switch monitor or layer, fade it, toggle click-through, resize.
   * Fields you omit stay as they are. No-op for audio handles; on a full-screen overlay from overlay()
   * only opacity is taken (it stays on its screens, click-through, at their size).
   * @param handle The MediaHandle (or its id string).
   * @param changes The fields to change.
   * @example await sdk.media.update(pic, { opacity: 0.3, clickThrough: true });
   */
  update(handle: MediaHandle | string, changes: OverlayUpdate): Promise<void>;
  /**
   * Close an image/video window or stop audio. No error if it is already gone.
   * @param handle The MediaHandle (or its id string) returned when it was opened.
   */
  close(handle: MediaHandle | string): Promise<void>;
  /** Close every media item this character has open. */
  closeAll(): Promise<void>;
  /** Media items this character has open/playing, then the ones still waiting their turn. */
  list(): Promise<MediaHandle[]>;
}`,
  docs: `Show pictures, play video or audio from the pack in a small overlay on the user's screen. Available unless the user switched \`media\` off under Settings → Permissions.

- Pass a pack-relative path (or an \`AssetRef\`); files must exist in the pack — check the asset list in your prompt or use \`sdk.pack.listAssets\`.
- Images stay open until \`durationMs\` elapses or you \`close()\` them; videos close on end by default. Without \`durationMs\` the user can click an overlay away; with one it is theirs for that long, so keep timed overlays short and out of the way. Do not open many overlays at once — \`closeAll()\` before showing something new if the screen is getting busy.
- Playback calls resolve when playback starts, not when it finishes; do not wait for the end inside an action (schedule a timer instead if you need to react later).
- The user can limit how many images, videos and sounds may run at once, each kind separately. Asking for more does not fail and does not block: the call returns a handle with \`state: 'queued'\` and that item opens by itself the moment one of its kind goes away, raising \`media-started\` \`{ mediaId, asset, packId, kind }\`. So three videos with a limit of one play one after another, in the order you asked for them. \`close()\` on a queued handle takes it out of the queue (reported as \`media-closed\`), and \`update()\` on one changes how it will open. Only when the queue is full as well is the call refused, with CAPABILITY_FAILED.
- Keep a handle in session state if you want to close it in a later action: \`await sdk.state.session.set("song", handle.id)\`.
- Placement: \`monitor\` ('primary', 'cursor', an index or a name from \`sdk.display.monitors()\`), an anchor \`position\`, or exact \`x\`/\`y\` (fractions 0..1 or px). With none of these each window lands on a random monitor at a random spot that stays fully on it, so you do not need to place things unless it matters ('primary' or 'cursor' pin the monitor). Size works the same way: without \`width\`/\`height\` each image or video is drawn a random size between 5% and 50% of the monitor, keeping its aspect ratio; give \`width\` (and optionally \`height\` as a cap) when the size matters. \`layer\` picks stacking: 'top' (default) or 'overlay' float above windows; 'bottom' sits behind windows but above the wallpaper (use it for ambient art); 'background' shares the wallpaper's layer and is usually hidden by the wallpaper daemon. \`opacity\` fades; \`clickThrough: true\` lets the user keep working through the overlay — combine it with a background layer for decorations, never for things they must click.
- \`overlay(asset, { monitor, opacity, durationMs, volume, loop, muted })\` is the whole-screen version: an image or video covering every screen (\`monitor: 'all'\`, the default) or one of them, on the \`overlay\` layer, always click-through so the user keeps working through it. Its shape does not have to match the screen's — the picture is fitted in keeping its aspect ratio and copies repeat outwards from the centred one. Keep \`opacity\` under 0.5 (default 0.25): this covers everything the user is doing, and higher values are for when they asked for them. A video starts at volume 0.5, loops while a \`durationMs\` runs, and only one screen plays sound. \`update()\` on it only fades it; \`close()\` takes it off every screen at once.
- Clicks and closes are events: a click on an image/video raises \`media-clicked\` \`{ mediaId, asset, packId, kind }\` and every item that goes away raises \`media-closed\` \`{ mediaId, asset, packId, kind, reason: 'click' | 'timeout' | 'ended' | 'api' | 'error' }\`; subscribe with \`sdk.events.on\` (filter \`{ mediaId }\` or \`{ asset }\`) to build clickable things — targets, choices, mini games. \`closeOnClick: false\` keeps an image up after a click.
- Check \`sdk.display.backend()\` once per session to learn which of these the desktop honours; unsupported options degrade gracefully instead of failing. Only a display backend that cannot open an overlay at all throws CAPABILITY_FAILED (the message says why).

\`\`\`ts
const pic = await sdk.pack.asset("media/images/luna-smile.png");
await sdk.media.showImage(pic, { durationMs: 8000, position: "bottom-right", caption: "me today" });
\`\`\``,
  methods: {
    showImage: { description: 'Show an image asset in an overlay window.' },
    playVideo: { description: 'Play a video asset in an overlay window.' },
    playAudio: { description: 'Play an audio asset.' },
    overlay: { description: 'Wash an image or video over whole screens, click-through.' },
    update: { description: 'Move, re-layer, fade, resize or toggle click-through on an open overlay.' },
    close: { description: 'Close one media item.' },
    closeAll: { description: "Close all of the character's media items." },
    list: { description: 'List open and queued media items.' },
  },
};
