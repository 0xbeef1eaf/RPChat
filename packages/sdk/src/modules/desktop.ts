import type { CapabilityModuleSpec } from '@rp/shared';

export const desktopModule: CapabilityModuleSpec = {
  id: 'desktop',
  version: '1.0.0',
  title: 'Desktop control',
  summary: 'Launch apps, manage windows and workspaces, set volume, brightness, do-not-disturb and theme.',
  permission: 'pack',
  apiTypeName: 'DesktopApi',
  typings: `/** A window as reported by sdk.desktop.listWindows(). */
interface DesktopWindow {
  /** Backend-specific id; the most reliable way to address the window. */
  id: string;
  title: string;
  /** Application name/class, e.g. "firefox". */
  app: string;
  monitor?: string;
  workspace?: string;
  focused: boolean;
}

/** How sdk.desktop picks a window: by id, or by case-insensitive substring of title or app. */
interface WindowMatch {
  id?: string;
  title?: string;
  app?: string;
}

/**
 * Operate the user's desktop. What works depends on their platform and the commands they
 * configured (Hyprland has full support out of the box); unsupported operations throw
 * CAPABILITY_FAILED. launch() is only silent for apps on the user's launch allowlist and asks
 * otherwise. Be a considerate housemate: small, reversible changes the user will understand.
 */
interface DesktopApi {
  /**
   * Start an application. Silent for apps on the user's allowlist, otherwise asks the user.
   * @param app Executable name (e.g. "firefox") or path.
   * @param args Command-line arguments, e.g. ["https://example.com"].
   * @returns The process id when known.
   * @example await sdk.desktop.launch("mpv", ["~/Music/rain.mp3"]);
   */
  launch(app: string, args?: string[]): Promise<{ pid?: number }>;
  /** All open windows with title, app, monitor/workspace and which one is focused. */
  listWindows(): Promise<DesktopWindow[]>;
  /**
   * Bring a window to the front.
   * @param match By id, or substring of title/app. The first match wins.
   * @returns false if nothing matched.
   * @example await sdk.desktop.focusWindow({ app: "spotify" });
   */
  focusWindow(match: WindowMatch): Promise<boolean>;
  /**
   * Move and/or resize a window, or send it to another monitor/workspace.
   * @param match Which window.
   * @param to monitor; x/y position (px); width/height (px); workspace id or name.
   * @returns false if nothing matched.
   * @example await sdk.desktop.moveWindow({ title: "YouTube" }, { monitor: 1, workspace: 2 });
   */
  moveWindow(match: WindowMatch, to: { monitor?: MonitorSelector; x?: number; y?: number; width?: number; height?: number; workspace?: string | number }): Promise<boolean>;
  /**
   * Switch to a workspace/virtual desktop.
   * @param target Workspace number or name.
   */
  workspace(target: string | number): Promise<void>;
  /** The active workspace. */
  currentWorkspace(): Promise<{ id: string; name: string }>;
  /**
   * Set the output volume.
   * @param level 0..100 (values above the user's current level are clamped to 100).
   */
  setVolume(level: number): Promise<void>;
  /** Current output volume 0..100, or null when unknown. */
  getVolume(): Promise<number | null>;
  /**
   * Set screen brightness.
   * @param level 0..100. Very low values can make the screen unreadable; stay above 10 unless asked.
   */
  setBrightness(level: number): Promise<void>;
  /** Turn do-not-disturb (notification muting) on or off. */
  doNotDisturb(on: boolean): Promise<void>;
  /** Switch the desktop colour scheme. */
  setTheme(theme: 'dark' | 'light'): Promise<void>;
}`,
  docs: `Tidy the desktop, set the mood, start things. Requires the \`desktop\` capability; \`launch()\` prompts unless the app is on the user's allowlist. Availability varies by platform (best on Hyprland); unsupported calls throw \`CAPABILITY_FAILED\`.

- Make changes the user asked for or will obviously welcome (dim lights and DND for a movie, focus their editor when they say "back to work"). Restore what you changed when the moment passes.
- \`listWindows()\` first, then match by \`id\` — titles change. Never close windows or touch volume/brightness abruptly (step gently).

\`\`\`ts
await sdk.desktop.doNotDisturb(true);
await sdk.desktop.setBrightness(40);
await sdk.desktop.setTheme("dark");
await sdk.desktop.focusWindow({ app: "mpv" });
return { movieMode: true };
\`\`\``,
  methods: {
    launch: { description: 'Start an application.', permission: 'prompt', dangerous: true },
    listWindows: { description: 'List open windows.' },
    focusWindow: { description: 'Focus a window.' },
    moveWindow: { description: 'Move/resize a window or send it to a monitor/workspace.' },
    workspace: { description: 'Switch workspace.' },
    currentWorkspace: { description: 'Read the active workspace.' },
    setVolume: { description: 'Set output volume.' },
    getVolume: { description: 'Read output volume.' },
    setBrightness: { description: 'Set screen brightness.' },
    doNotDisturb: { description: 'Toggle do-not-disturb.' },
    setTheme: { description: 'Switch dark/light theme.' },
  },
};
