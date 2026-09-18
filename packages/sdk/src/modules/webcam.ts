import type { CapabilityModuleSpec } from '@rp/shared';

export const webcamModule: CapabilityModuleSpec = {
  id: 'webcam',
  version: '1.1.0',
  title: 'Webcam',
  summary: "Take a photo or a short clip with the user's camera, saved into your own home folder.",
  permission: 'pack',
  apiTypeName: 'WebcamApi',
  typings: `/**
 * The user's camera. Both calls record, save the file under "webcam/" in your home folder
 * (the same folder as sdk.files — the user can browse and delete it) and hand back an AssetRef
 * with source: 'home', which sdk.media can show. Requires the 'webcam' capability; the user can switch it off entirely
 * under Settings → Permissions, and both calls are marked as acting outside the app.
 */
interface WebcamApi {
  /**
   * Take one photo.
   * @returns The saved file: home-relative path, mime and size.
   * @example const shot = await sdk.webcam.takeImage(); return { saved: shot.path, kb: Math.round(shot.bytes / 1024) };
   */
  takeImage(): Promise<AssetRef>;
  /**
   * Record a short clip.
   * @param seconds How long to record, 1..60. The call blocks for at least that long, so keep it
   *   short — an action has about 10 seconds of its own.
   * @returns The saved file: home-relative path, mime and size.
   * @example const clip = await sdk.webcam.takeVideo(5); await sdk.files.open(clip.path);
   */
  takeVideo(seconds: number): Promise<AssetRef>;
}`,
  docs: `Look through the user's camera. Requires the \`webcam\` capability (Settings → Permissions).

- This is the most invasive thing you can do, and nothing stops you but your own judgement. Capture only when the user asks, or when they have clearly invited it ("look at me", "how do I look?"). Never from a timer, an event or a wake, and never to check up on them. Say what you are about to do before you do it.
- One capture answers a question; a second one rarely does. Never loop or poll the camera.
- Both calls save into \`webcam/\` in your home folder and return an \`AssetRef\` with \`source: 'home'\`. Hand that ref straight to \`sdk.media\` to put the capture on screen, or to \`sdk.files.open/read/list/delete\` to work with the file; \`sdk.files.homePath()\` tells the user where it is. \`sdk.wallpaper.set\` is the one asset call that takes pack assets only.
- Captures pile up in your home folder. Delete one with \`sdk.files.delete(ref.path)\` when you are done with it, unless the user wants it kept.
- With no camera command configured both calls throw CAPABILITY_FAILED naming the command and Settings → Commands; tell the user rather than retrying.

\`\`\`ts
const shot = await sdk.webcam.takeImage();
await sdk.media.showImage(shot, { durationMs: 6000 });
return { saved: shot.path, bytes: shot.bytes };
\`\`\``,
  methods: {
    takeImage: { description: "Take one photo with the user's camera.", dangerous: true },
    takeVideo: { description: "Record a short clip with the user's camera.", dangerous: true },
  },
};
