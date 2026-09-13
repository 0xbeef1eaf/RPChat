import type { CapabilityModuleSpec } from '@rp/shared';

export const mediaModule: CapabilityModuleSpec = {
  id: 'media',
  version: '1.1.0',
  title: 'Media playback',
  summary: 'Show images and play video/audio from the pack in an overlay window on the user\'s screen.',
  permission: 'pack',
  apiTypeName: 'MediaApi',
  typings: `/**
 * Show pack media on the user's screen. Images and videos open in a frameless overlay
 * window whose monitor, placement, stacking layer, opacity and click-through you control
 * through OverlayOptions; audio plays without a window. Only pack assets can be shown
 * (no URLs, no files outside the pack). Every call returns a MediaHandle you can pass
 * to update() or close(). Use sdk.display to discover monitors and backend abilities.
 */
interface MediaApi {
  /**
   * Show an image asset in an overlay.
   * @param asset An AssetRef from sdk.pack, or a pack-relative path such as "media/images/smile.png".
   * @param options durationMs (auto-close), caption, plus OverlayOptions: monitor, position or x/y,
   *   layer ('top' default; 'background' puts it behind windows like a wallpaper), opacity, clickThrough, width, height.
   *   Without monitor/position/x/y the window is placed on a random monitor at a random in-bounds spot.
   * @returns Handle of the shown image.
   * @example await sdk.media.showImage("media/images/smile.png", { durationMs: 8000, position: "bottom-right" });
   * @example await sdk.media.showImage("media/images/rain.png", { monitor: "cursor", layer: "background", opacity: 0.6, clickThrough: true, width: 1920 });
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
   * Change an open image/video overlay in place: move it, switch monitor or layer, fade it, toggle click-through, resize.
   * Fields you omit stay as they are. No-op for audio handles.
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
  /** Media items currently open/playing for this character. */
  list(): Promise<MediaHandle[]>;
}`,
  docs: `Show pictures, play video or audio from the pack in a small overlay on the user's screen. Available unless the user switched \`media\` off under Settings → Permissions.

- Pass a pack-relative path (or an \`AssetRef\`); files must exist in the pack — check the asset list in your prompt or use \`sdk.pack.listAssets\`.
- Images stay open until \`durationMs\` elapses or you \`close()\` them; videos close on end by default. Without \`durationMs\` the user can click an overlay away; with one it is theirs for that long, so keep timed overlays short and out of the way. Do not open many overlays at once — \`closeAll()\` before showing something new if the screen is getting busy.
- Playback calls resolve when playback starts, not when it finishes; do not wait for the end inside an action (schedule a timer instead if you need to react later).
- Keep a handle in session state if you want to close it in a later action: \`await sdk.state.session.set("song", handle.id)\`.
- Placement: \`monitor\` ('primary', 'cursor', an index or a name from \`sdk.display.monitors()\`), an anchor \`position\`, or exact \`x\`/\`y\` (fractions 0..1 or px). With none of these each window lands on a random monitor at a random spot that stays fully on it, so you do not need to place things unless it matters ('primary' or 'cursor' pin the monitor). \`layer\` picks stacking: 'top' (default) or 'overlay' float above windows; 'bottom' sits behind windows but above the wallpaper (use it for ambient art); 'background' shares the wallpaper's layer and is usually hidden by the wallpaper daemon. \`opacity\` fades; \`clickThrough: true\` lets the user keep working through the overlay — combine it with a background layer for decorations, never for things they must click.
- Check \`sdk.display.backend()\` once per session to learn which of these the desktop honours; unsupported options degrade gracefully instead of failing. Only a display backend that cannot open an overlay at all throws CAPABILITY_FAILED (the message says why).

\`\`\`ts
const pic = await sdk.pack.asset("media/images/luna-smile.png");
await sdk.media.showImage(pic, { durationMs: 8000, position: "bottom-right", caption: "me today" });
\`\`\``,
  methods: {
    showImage: { description: 'Show an image asset in an overlay window.' },
    playVideo: { description: 'Play a video asset in an overlay window.' },
    playAudio: { description: 'Play an audio asset.' },
    update: { description: 'Move, re-layer, fade, resize or toggle click-through on an open overlay.' },
    close: { description: 'Close one media item.' },
    closeAll: { description: "Close all of the character's media items." },
    list: { description: 'List open media items.' },
  },
};
