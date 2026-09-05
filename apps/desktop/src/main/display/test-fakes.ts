/** Test doubles shared by the display backend tests (not part of the app bundle). */
import type { MediaCommand, MediaWindowEvent } from '@rp/shared';
import type { OverlayWindowLike } from './backend.js';
import type { ScreenLike } from './electron.js';
import type { Bounds } from './placement.js';

export function fakeScreen(): ScreenLike {
  const displays = [
    { id: 11, label: 'Main', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 30, width: 1920, height: 1050 }, scaleFactor: 1 },
    { id: 12, label: '', bounds: { x: 1920, y: 0, width: 1280, height: 720 }, workArea: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  ];
  return {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0]!,
    getCursorScreenPoint: () => ({ x: 2000, y: 100 }),
  };
}

export class FakeOverlayWindow implements OverlayWindowLike {
  static counter = 0;
  readonly id = String(++FakeOverlayWindow.counter);
  readonly sent: MediaCommand[] = [];
  readonly calls: string[] = [];
  bounds: Bounds = { x: 0, y: 0, width: 480, height: 320 };
  shown = false;
  destroyed = false;
  focusable = true;
  alwaysOnTop: { flag: boolean; level?: string } | undefined;
  ignoreMouse: boolean | undefined;
  opacity: number | undefined;
  /** When set, `send` of a show command answers with this content size. */
  autoContentSize: { width: number; height: number } | undefined;
  private readonly reportListeners = new Set<(event: MediaWindowEvent) => void>();
  private readonly closedListeners = new Set<() => void>();

  constructor(readonly title: string) {}

  async whenReady(): Promise<void> {
    this.calls.push('whenReady');
  }

  send(command: MediaCommand): void {
    this.sent.push(command);
    if (this.autoContentSize && (command.type === 'show-image' || command.type === 'play-video')) {
      const size = this.autoContentSize;
      queueMicrotask(() => this.report({ type: 'content-size', id: command.id, width: size.width, height: size.height }));
    }
  }

  report(event: MediaWindowEvent): void {
    for (const l of [...this.reportListeners]) l(event);
  }

  onReport(listener: (event: MediaWindowEvent) => void): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  setBounds(b: Bounds): void {
    this.calls.push(`setBounds ${b.x},${b.y} ${b.width}x${b.height}`);
    this.bounds = { ...b };
  }

  getBounds(): Bounds {
    return { ...this.bounds };
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.alwaysOnTop = level === undefined ? { flag } : { flag, level };
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    this.ignoreMouse = ignore;
  }

  setOpacity(v: number): void {
    this.opacity = v;
  }

  setFocusable(flag: boolean): void {
    this.focusable = flag;
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.shown = false;
  }

  blur(): void {
    this.calls.push('blur');
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const l of [...this.closedListeners]) l();
  }
}
