import type { CapabilityModuleSpec } from '@rp/shared';

export const mediaModule: CapabilityModuleSpec = {
  id: 'media',
  version: '1.0.0',
  title: 'Media playback',
  summary: 'Show images and play video/audio from the pack in an overlay window on the user\'s screen.',
  permission: 'pack',
  apiTypeName: 'MediaApi',
  typings: `/**
 * Show pack media on the user's screen. Images and videos open in a small frameless
 * overlay window on the primary display; audio plays without a window. Only pack
 * assets can be shown (no URLs, no files outside the pack). Every call returns a
 * MediaHandle you can pass to close().
 */
interface MediaApi {
  /**
   * Show an image asset in an overlay.
   * @param asset An AssetRef from sdk.pack, or a pack-relative path such as "media/images/smile.png".
   * @param options durationMs (auto-close), position, width (px, default 480), caption.
   * @returns Handle of the shown image.
   * @example await sdk.media.showImage("media/images/smile.png", { durationMs: 8000, position: "bottom-right" });
   */
  showImage(asset: AssetRef | string, options?: ShowImageOptions): Promise<MediaHandle>;
  /**
   * Play a video asset in an overlay. Resolves as soon as playback starts, not when it ends.
   * @param asset An AssetRef or pack-relative path (mp4/webm).
   * @param options position, width, volume (0..1), loop, closeOnEnd (default true), muted.
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
   * Close an image/video window or stop audio. No error if it is already gone.
   * @param handle The MediaHandle (or its id string) returned when it was opened.
   */
  close(handle: MediaHandle | string): Promise<void>;
  /** Close every media item this character has open. */
  closeAll(): Promise<void>;
  /** Media items currently open/playing for this character. */
  list(): Promise<MediaHandle[]>;
}`,
  docs: `Show pictures, play video or audio from the pack in a small overlay on the user's screen. Requires the \`media\` capability granted to the pack.

- Pass a pack-relative path (or an \`AssetRef\`); files must exist in the pack — check the asset list in your prompt or use \`sdk.pack.listAssets\`.
- Images stay open until \`durationMs\` elapses or you \`close()\` them; videos close on end by default. Do not open many overlays at once — \`closeAll()\` before showing something new if the screen is getting busy.
- Playback calls resolve when playback starts, not when it finishes; do not wait for the end inside an action (schedule a timer instead if you need to react later).
- Keep a handle in session state if you want to close it in a later action: \`await sdk.state.session.set("song", handle.id)\`.

\`\`\`ts
const pic = await sdk.pack.asset("media/images/luna-smile.png");
await sdk.media.showImage(pic, { durationMs: 8000, position: "bottom-right", caption: "me today" });
\`\`\``,
  methods: {
    showImage: { description: 'Show an image asset in an overlay window.' },
    playVideo: { description: 'Play a video asset in an overlay window.' },
    playAudio: { description: 'Play an audio asset.' },
    close: { description: 'Close one media item.' },
    closeAll: { description: "Close all of the character's media items." },
    list: { description: 'List open media items.' },
  },
};
