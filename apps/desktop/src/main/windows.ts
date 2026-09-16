/**
 * BrowserWindow management: the main UI window, prompt windows (prompt.html,
 * one per pending question), overlay windows (media.html, one per item, driven
 * by the display backend) and the hidden audio window.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, shell } from 'electron';
import type { WebContents } from 'electron';
import type { MediaCommand, MediaWindowEvent, PromptWindowPayload } from '@rp/shared';
import { IPC_EVENT_CHANNELS } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { OverlayWindowLike } from './display/backend.js';
import type { Bounds } from './display/placement.js';

export type WindowKind = 'main' | 'media' | 'prompt';

/** The id a `PromptWindowPayload` is answered by (`permissions.respond` / `ui.respondPrompt`). */
export function promptIdOf(payload: PromptWindowPayload): string {
  return payload.kind === 'permission' ? payload.request.requestId : payload.prompt.promptId;
}

/**
 * Window title and size for one question. A permission request carries an arguments block, a
 * list of options or a multi-line answer needs room; anything taller than the window scrolls.
 */
function promptWindowChrome(payload: PromptWindowPayload): { title: string; width: number; height: number } {
  if (payload.kind === 'permission') return { title: `${payload.characterName} needs permission`, width: 620, height: 660 };
  const roomy = payload.prompt.kind === 'choose' || payload.prompt.multiline === true;
  return { title: `${payload.prompt.characterName} asks`, width: 520, height: roomy ? 460 : 380 };
}

export interface WindowManagerOptions {
  /** `out/` directory of the built app (contains main/, preload/, renderer/). */
  outDir: string;
  /** Vite dev server origin when running under `electron-vite dev`. */
  rendererUrl?: string;
  /**
   * Whether DevTools may be opened in the windows this manager creates. `false` (the policy's
   * `dev.devTools`, see dev-guard.ts) makes `openDevTools()` and the menu's Toggle Developer
   * Tools no-ops in every window, the overlays and prompt windows included. Default true.
   */
  devTools?: boolean;
  logger: Logger;
  /** Runs in the main window when it is about to close (reject pending prompts, …). */
  onMainClosed?: () => void;
  /**
   * A prompt window was closed while its question was still unanswered (the user pressed the
   * window's close button). The question must be answered with its fallback.
   */
  onPromptDismissed?: (promptId: string) => void;
}

/** Wraps a BrowserWindow hosting media.html as an `OverlayWindowLike`. */
export class ElectronOverlayWindow implements OverlayWindowLike {
  readonly id: string;
  private readonly reportListeners = new Set<(event: MediaWindowEvent) => void>();
  private readonly closedListeners = new Set<() => void>();
  private readonly ready: Promise<void>;
  private closed = false;

  constructor(
    readonly win: BrowserWindow,
    readonly title: string,
  ) {
    this.id = String(win.id);
    this.ready = new Promise<void>((resolve) => {
      if (win.webContents.isDestroyed()) return resolve();
      win.webContents.once('did-finish-load', () => setTimeout(resolve, 120));
      win.webContents.once('did-fail-load', () => resolve());
      win.once('closed', () => resolve());
    });
    win.once('closed', () => {
      this.closed = true;
      for (const l of [...this.closedListeners]) l();
      this.closedListeners.clear();
      this.reportListeners.clear();
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  send(command: MediaCommand): void {
    if (this.isDestroyed()) return;
    this.win.webContents.send(IPC_EVENT_CHANNELS.mediaCommand, command);
  }

  onReport(listener: (event: MediaWindowEvent) => void): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    if (this.closed) listener();
    else this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  /** Called by the IPC layer for `media:report` from this window. */
  dispatchReport(event: MediaWindowEvent): void {
    for (const l of [...this.reportListeners]) l(event);
  }

  setBounds(b: Bounds): void {
    if (!this.isDestroyed()) this.win.setBounds(b);
  }

  getBounds(): Bounds {
    return this.isDestroyed() ? { x: 0, y: 0, width: 0, height: 0 } : this.win.getBounds();
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    if (this.isDestroyed()) return;
    if (level) this.win.setAlwaysOnTop(flag, level as Parameters<BrowserWindow['setAlwaysOnTop']>[1]);
    else this.win.setAlwaysOnTop(flag);
  }

  setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void {
    if (this.isDestroyed()) return;
    if (ignore) this.win.setIgnoreMouseEvents(true, { forward: opts?.forward ?? true });
    else this.win.setIgnoreMouseEvents(false);
  }

  setOpacity(v: number): void {
    if (!this.isDestroyed()) this.win.setOpacity(v);
  }

  setFocusable(flag: boolean): void {
    if (!this.isDestroyed()) this.win.setFocusable(flag);
  }

  show(): void {
    if (!this.isDestroyed() && !this.win.isVisible()) this.win.showInactive();
  }

  hide(): void {
    if (!this.isDestroyed()) this.win.hide();
  }

  blur(): void {
    if (!this.isDestroyed()) this.win.blur();
  }

  isDestroyed(): boolean {
    return this.closed || this.win.isDestroyed();
  }

  destroy(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  runScript(script: string): Promise<unknown> {
    if (this.isDestroyed()) return Promise.resolve(undefined);
    return this.win.webContents.executeJavaScript(script, true);
  }
}

export class WindowManager {
  private main: BrowserWindow | undefined;
  private readonly kinds = new Map<number, WindowKind>();
  private readonly overlays = new Map<number, ElectronOverlayWindow>();
  /** promptId → the window asking it, while it is unanswered. */
  private readonly prompts = new Map<string, { win: BrowserWindow; payload: PromptWindowPayload }>();
  /** webContents id → promptId, so a prompt page can ask which question it is showing. */
  private readonly promptSenders = new Map<number, string>();
  private audio: ElectronOverlayWindow | undefined;

  constructor(private readonly opts: WindowManagerOptions) {}

  get preloadPath(): string {
    const js = path.join(this.opts.outDir, 'preload', 'index.js');
    if (fs.existsSync(js)) return js;
    const mjs = path.join(this.opts.outDir, 'preload', 'index.mjs');
    return fs.existsSync(mjs) ? mjs : js;
  }

  get rendererDir(): string {
    return path.join(this.opts.outDir, 'renderer');
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: this.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: this.opts.devTools !== false,
    };
  }

  private load(win: BrowserWindow, page: 'index.html' | 'media.html' | 'prompt.html'): void {
    const url = this.opts.rendererUrl;
    if (url) void win.loadURL(`${url.replace(/\/+$/, '')}/${page}`);
    else void win.loadFile(path.join(this.rendererDir, page));
  }

  private track(win: BrowserWindow, kind: WindowKind): void {
    const id = win.webContents.id;
    this.kinds.set(id, kind);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (this.isAppUrl(url)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    win.once('closed', () => this.kinds.delete(id));
  }

  private isAppUrl(url: string): boolean {
    if (url.startsWith('file:')) return true;
    const dev = this.opts.rendererUrl;
    return Boolean(dev && url.startsWith(dev));
  }

  createMainWindow(options: { hidden?: boolean } = {}): BrowserWindow {
    if (this.main && !this.main.isDestroyed()) {
      if (!options.hidden) {
        this.main.show();
        this.main.focus();
      }
      return this.main;
    }
    const win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 760,
      minHeight: 520,
      show: false,
      frame: true,
      autoHideMenuBar: true,
      title: 'rp-code',
      backgroundColor: '#1b1b1f',
      webPreferences: this.webPreferences(),
    });
    this.main = win;
    this.track(win, 'main');
    if (!options.hidden) win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (this.main === win) this.main = undefined;
      this.opts.onMainClosed?.();
    });
    this.load(win, 'index.html');
    return win;
  }

  getMainWindow(): BrowserWindow | undefined {
    return this.main && !this.main.isDestroyed() ? this.main : undefined;
  }

  /**
   * Open a focused window asking one question (prompt.html). One window per question, so a
   * request that arrives while the app is in the background reaches the user instead of waiting
   * on a chat window they are not looking at. Returns false when no window could be opened, so
   * the caller can fall back to the main window's in-app modal.
   */
  openPromptWindow(payload: PromptWindowPayload): boolean {
    const id = promptIdOf(payload);
    if (this.prompts.has(id)) return true;
    const { title, width, height } = promptWindowChrome(payload);
    let win: BrowserWindow;
    try {
      win = new BrowserWindow({
        width,
        height,
        minWidth: 380,
        minHeight: 260,
        show: false,
        center: true,
        frame: true,
        autoHideMenuBar: true,
        alwaysOnTop: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title,
        backgroundColor: '#1b1b1f',
        webPreferences: this.webPreferences(),
      });
    } catch (err) {
      this.opts.logger.warn('[windows] could not open a prompt window', err);
      return false;
    }
    win.setMenuBarVisibility(false);
    // The page sets its own <title>; keep the one the question was opened with.
    win.on('page-title-updated', (event) => event.preventDefault());
    this.track(win, 'prompt');
    const contentsId = win.webContents.id;
    this.prompts.set(id, { win, payload });
    this.promptSenders.set(contentsId, id);
    win.once('ready-to-show', () => {
      // A question the user has not seen is worth interrupting for: show it in front, focused.
      win.show();
      win.moveTop();
      win.focus();
    });
    win.once('closed', () => {
      this.promptSenders.delete(contentsId);
      // Still registered → the user closed the window instead of answering.
      if (this.prompts.get(id)?.win === win) {
        this.prompts.delete(id);
        this.opts.onPromptDismissed?.(id);
      }
    });
    this.load(win, 'prompt.html');
    return true;
  }

  /** Whether this question is being asked in a window of its own. */
  hasPromptWindow(promptId: string): boolean {
    return this.prompts.has(promptId);
  }

  /** Close the window of an answered question (no-op when it has none). */
  closePromptWindow(promptId: string): void {
    const entry = this.prompts.get(promptId);
    if (!entry) return;
    this.prompts.delete(promptId);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  /** The question a prompt page is showing, for `prompts.pending()`. */
  promptPayloadFor(sender: WebContents): PromptWindowPayload | null {
    const id = this.promptSenders.get(sender.id);
    return (id && this.prompts.get(id)?.payload) || null;
  }

  /** Send a push event to the main window. Returns false when there is no window. */
  sendToMain(channel: string, payload: unknown): boolean {
    const win = this.getMainWindow();
    if (!win || win.webContents.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  }

  /** Transparent, frameless, non-focusable overlay window hosting media.html (hidden until placed). */
  createOverlayWindow(title: string): OverlayWindowLike {
    const win = new BrowserWindow({
      width: 480,
      height: 320,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title,
      webPreferences: this.webPreferences(),
    });
    win.setMenuBarVisibility(false);
    // Keep the title stable: the page's <title> would otherwise replace it (Hyprland matches windows by title).
    win.on('page-title-updated', (event) => event.preventDefault());
    this.track(win, 'media');
    const wrapped = new ElectronOverlayWindow(win, title);
    const contentsId = win.webContents.id; // read now: webContents is gone by the time 'closed' fires
    this.overlays.set(contentsId, wrapped);
    win.once('closed', () => this.overlays.delete(contentsId));
    this.load(win, 'media.html');
    return wrapped;
  }

  /** One hidden window for audio playback (never shown), created on first use. */
  audioWindow(): OverlayWindowLike {
    if (this.audio && !this.audio.isDestroyed()) return this.audio;
    const win = new BrowserWindow({
      width: 320,
      height: 120,
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      title: 'rp-audio',
      webPreferences: this.webPreferences(),
    });
    win.setMenuBarVisibility(false);
    this.track(win, 'media');
    const wrapped = new ElectronOverlayWindow(win, 'rp-audio');
    const audioContentsId = win.webContents.id;
    this.overlays.set(audioContentsId, wrapped);
    win.once('closed', () => {
      this.overlays.delete(audioContentsId);
      if (this.audio === wrapped) this.audio = undefined;
    });
    this.audio = wrapped;
    this.load(win, 'media.html');
    return wrapped;
  }

  kindOf(sender: WebContents): WindowKind | undefined {
    return this.kinds.get(sender.id);
  }

  isOurs(sender: WebContents): boolean {
    return this.kinds.has(sender.id);
  }

  /** Route a `media:report` from a media window to its overlay wrapper. */
  dispatchReport(sender: WebContents, event: MediaWindowEvent): boolean {
    const wrapped = this.overlays.get(sender.id);
    if (!wrapped) return false;
    wrapped.dispatchReport(event);
    return true;
  }

  closeAll(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}
