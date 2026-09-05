import type { CapabilityModuleSpec } from '@rp/shared';

export const wallpaperModule: CapabilityModuleSpec = {
  id: 'wallpaper',
  version: '1.0.0',
  title: 'Desktop wallpaper',
  summary: "Change the user's desktop wallpaper to a pack image (runs the user's configured wallpaper command).",
  permission: 'pack',
  apiTypeName: 'WallpaperApi',
  typings: `/**
 * Set the desktop wallpaper to an image from the pack. The app runs the wallpaper command
 * the user configured in Settings (e.g. swww, hyprpaper, gsettings, or a Windows/macOS default),
 * so the effect depends on their setup. Requires the 'wallpaper' capability.
 */
interface WallpaperApi {
  /**
   * Set the wallpaper to a pack image.
   * @param asset An AssetRef or pack-relative path of an image.
   * @param options monitor: restrict to one monitor when the user's command supports {monitor}.
   * @returns Which asset is now set (as this app knows it).
   * @example await sdk.wallpaper.set("media/images/night-sky.png");
   */
  set(asset: AssetRef | string, options?: { monitor?: MonitorSelector }): Promise<{ asset: string }>;
  /**
   * Restore the wallpaper the user configured as their default in Settings. Resolves to false
   * (without error) when they have not configured one.
   */
  restore(): Promise<boolean>;
  /** The pack asset this app last set as wallpaper in this session, or null. */
  current(): Promise<{ asset: string | null }>;
}`,
  docs: `Swap the user's wallpaper for a picture from the pack. Requires the \`wallpaper\` capability and a wallpaper command configured by the user; if none is configured the call fails with CAPABILITY_FAILED and you should simply carry on.

- Use it sparingly and purposefully (a scene change, a reward, a mood), and offer \`restore()\` when the moment passes.
- Prefer large images; check \`sdk.display.monitors()\` for resolutions if the pack has several sizes.

\`\`\`ts
await sdk.wallpaper.set("media/images/forest-dawn.png");
await sdk.timers.schedule(30 * 60 * 1000, { restoreWallpaper: true }, { label: "restore wallpaper" });
\`\`\``,
  methods: {
    set: { description: "Change the desktop wallpaper to a pack image (via the user's command).", dangerous: true },
    restore: { description: "Restore the user's configured default wallpaper." },
    current: { description: 'Which pack image is currently set as wallpaper by this app.' },
  },
};
