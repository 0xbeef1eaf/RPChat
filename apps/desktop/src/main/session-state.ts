/**
 * What was on screen when the app last went away, so the next launch can put it back:
 * `<userData>/data/session-state.json`.
 *
 * Written on the way out — an ordinary quit, an update restart (before the updater starts the new
 * version, so the new process never reads a stale file), and the session ending under the app —
 * and read once at startup:
 *
 * - `window`: the main window's bounds, whether it was maximized or full screen, and whether it
 *   was showing. Visibility is only honoured after an update restart: a launch the user asked for
 *   always shows the window (unless it is `--hidden`), but a restart they did not ask for should
 *   leave the app where it was — in the tray, if that is where it was.
 * - `ui`: where the main window's UI was (`UiSnapshot`, saved by the renderer as it changes).
 * - `media` / `widgets`: the `sdk.media` items and `sdk.widgets` on screen (or queued). These are
 *   put back once: the startup that restores them clears them from the file, so a crash later on
 *   does not bring back media that was long gone by then.
 *
 * Avatars have their own file (capabilities/avatar-store.ts), kept up to date as they change.
 * Everything here is tolerant: a missing or unreadable file is an empty state, and anything that
 * no longer exists (a pack since uninstalled, a session since deleted) is skipped where it is applied.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { UiSnapshot } from '@rp/shared';
import type { MediaRecord } from './capabilities/media.js';
import { parseMediaRecords } from './capabilities/media.js';
import type { WidgetRecord } from './capabilities/widgets.js';
import { parseWidgetRecords } from './capabilities/widgets.js';

export const SESSION_STATE_FILENAME = 'session-state.json';
/** A UI snapshot larger than this is not stored (the drafts are the only part that can grow). */
export const UI_SNAPSHOT_MAX_BYTES = 256 * 1024;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowStateRecord {
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
  visible: boolean;
}

export interface SessionState {
  version: 1;
  savedAt: string;
  /** `update`: written on the way into an update restart. */
  reason: 'quit' | 'update';
  window?: WindowStateRecord;
  ui?: UiSnapshot;
  media: MediaRecord[];
  widgets: WidgetRecord[];
}

export function emptySessionState(): SessionState {
  return { version: 1, savedAt: '', reason: 'quit', media: [], widgets: [] };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseWindow(raw: unknown): WindowStateRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  const b = (w.bounds && typeof w.bounds === 'object' ? w.bounds : {}) as Record<string, unknown>;
  if (!finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height) || b.width <= 0 || b.height <= 0) return undefined;
  return {
    bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
    maximized: w.maximized === true,
    fullScreen: w.fullScreen === true,
    visible: w.visible !== false,
  };
}

/** Pure: a UI snapshot from the renderer or the file, with every field the right shape (or null when it is not one). */
export function parseUiSnapshot(raw: unknown): UiSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.route !== 'string') return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const e = (u.editor && typeof u.editor === 'object' ? u.editor : {}) as Record<string, unknown>;
  const m = u.memoriesPanel && typeof u.memoriesPanel === 'object' ? (u.memoriesPanel as Record<string, unknown>) : null;
  const drafts: Record<string, string> = {};
  if (u.drafts && typeof u.drafts === 'object' && !Array.isArray(u.drafts)) {
    for (const [id, text] of Object.entries(u.drafts as Record<string, unknown>)) if (typeof text === 'string' && text.length > 0) drafts[id] = text;
  }
  return {
    route: u.route,
    activeSessionId: str(u.activeSessionId),
    settingsTab: str(u.settingsTab),
    editor: { projectKey: str(e.projectKey), section: typeof e.section === 'string' ? e.section : 'pack', characterDir: str(e.characterDir) },
    memoriesPanel: m && typeof m.characterRef === 'string' ? { characterRef: m.characterRef, ...(typeof m.sessionId === 'string' ? { sessionId: m.sessionId } : {}) } : null,
    drafts,
  };
}

/** Pure: the stored file, tolerating anything missing or malformed. */
export function parseSessionState(raw: unknown): SessionState {
  const state = emptySessionState();
  if (!raw || typeof raw !== 'object') return state;
  const r = raw as Record<string, unknown>;
  if (typeof r.savedAt === 'string') state.savedAt = r.savedAt;
  if (r.reason === 'update') state.reason = 'update';
  const window = parseWindow(r.window);
  if (window) state.window = window;
  const ui = parseUiSnapshot(r.ui);
  if (ui) state.ui = ui;
  state.media = parseMediaRecords(r.media);
  state.widgets = parseWidgetRecords(r.widgets);
  return state;
}

/**
 * Pure: the bounds to open the main window with. A window whose middle is on none of today's
 * screens (a monitor unplugged since) keeps its size but loses its position, so it opens where the
 * window manager puts new windows rather than out of sight. Sizes are held to the window's minimum.
 */
export function restoredBounds(saved: Rect, workAreas: Rect[], min: { width: number; height: number }): Partial<Rect> & { width: number; height: number } {
  const width = Math.max(min.width, saved.width);
  const height = Math.max(min.height, saved.height);
  const cx = saved.x + saved.width / 2;
  const cy = saved.y + saved.height / 2;
  const onScreen = workAreas.some((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
  return onScreen ? { x: saved.x, y: saved.y, width, height } : { width, height };
}

/** Pure: whether the restored launch should start without its window (tray only). */
export function startHidden(state: SessionState, hiddenFlag: boolean): boolean {
  if (hiddenFlag) return true;
  return state.reason === 'update' && state.window?.visible === false;
}

export class SessionStateFile {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** No file (a first run) or one that is not JSON: an empty state. */
  async load(): Promise<SessionState> {
    try {
      return parseSessionState(JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown);
    } catch {
      return emptySessionState();
    }
  }

  /** Serialised and atomic, like the avatar store: two saves racing cannot leave half a file. */
  save(state: SessionState): Promise<void> {
    const run = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.file);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
