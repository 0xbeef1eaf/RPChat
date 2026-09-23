/** `sdk.desktop`: window management (Hyprland IPC), app launching (allowlist), volume/brightness/DND/theme via templates. */
import { spawn } from 'node:child_process';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import { expandHome, isMissingExecutable } from '../commands.js';
import type { HyprParser } from '../display/hypr-lua.js';
import { isLuaParserResponse, luaCloseWindowCommand, luaFocusWindowCommand, luaMoveWindowCommand, luaWorkspaceCommand } from '../display/hypr-lua.js';
import type { HyprClientJson, HyprMonitorJson, HyprTransport } from '../display/hyprland.js';
import { normalizeAddress } from '../display/hyprland.js';
import { OVERLAY_TITLE_PREFIX } from '../display/layers.js';
import { isLaunchAllowed } from './allowlist.js';
import type { CommandRunner } from './commands-runner.js';

export interface DesktopWindow {
  id: string;
  title: string;
  app: string;
  monitor?: string;
  workspace?: string;
  focused: boolean;
}

export interface WindowMatch {
  id?: string;
  title?: string;
  app?: string;
}

export interface MoveTarget {
  monitor?: string | number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  workspace?: string | number;
}

// ---- pure Hyprland helpers ----------------------------------------------------

export function windowsFromHyprClients(clients: HyprClientJson[], monitors: HyprMonitorJson[], activeAddress?: string): DesktopWindow[] {
  const active = activeAddress ? normalizeAddress(activeAddress) : undefined;
  return clients
    .filter((c) => c.mapped !== false && !c.hidden && typeof c.address === 'string')
    .map((c) => {
      const w: DesktopWindow = { id: normalizeAddress(c.address), title: c.title ?? '', app: c.class ?? '', focused: active !== undefined && normalizeAddress(c.address) === active };
      const mon = typeof c.monitor === 'number' ? monitors.find((m) => m.id === c.monitor) : undefined;
      if (mon) w.monitor = mon.name;
      const ws = (c as { workspace?: { id?: number; name?: string } }).workspace;
      if (ws?.name !== undefined) w.workspace = ws.name;
      else if (ws?.id !== undefined) w.workspace = String(ws.id);
      return w;
    });
}

export function matchWindow(windows: DesktopWindow[], match: WindowMatch): DesktopWindow | undefined {
  if (match.id) return windows.find((w) => w.id.toLowerCase() === match.id?.toLowerCase());
  const title = match.title?.toLowerCase();
  const app = match.app?.toLowerCase();
  if (!title && !app) return undefined;
  return windows.find((w) => (!title || w.title.toLowerCase().includes(title)) && (!app || w.app.toLowerCase().includes(app)));
}

export function hyprFocusCommand(address: string): string {
  return `dispatch focuswindow address:${normalizeAddress(address)}`;
}

/** A close *request* (what the close button sends): the app may still ask to save, or refuse. */
export function hyprCloseCommand(address: string): string {
  return `dispatch closewindow address:${normalizeAddress(address)}`;
}

/**
 * Addresses of the windows this app owns — its own process's (chat, prompts, audio) and the
 * overlays it drew. A character may see them in `listWindows()` but may never close them.
 */
export function ownWindowIds(clients: HyprClientJson[], ownPid: number): Set<string> {
  const out = new Set<string>();
  for (const c of clients) {
    if (typeof c.address !== 'string') continue;
    if (c.pid === ownPid || (c.title ?? '').startsWith(OVERLAY_TITLE_PREFIX)) out.add(normalizeAddress(c.address));
  }
  return out;
}

export function hyprMoveWindowCommands(address: string, to: MoveTarget, monitorName?: string): string[] {
  const a = normalizeAddress(address);
  const out: string[] = [];
  if (to.workspace !== undefined) out.push(`dispatch movetoworkspacesilent ${String(to.workspace)},address:${a}`);
  if (monitorName !== undefined) out.push(`dispatch movewindow mon:${monitorName},address:${a}`);
  if (to.width !== undefined || to.height !== undefined) {
    out.push(`dispatch resizewindowpixel exact ${Math.round(to.width ?? 0) || '0'} ${Math.round(to.height ?? 0) || '0'},address:${a}`);
  }
  if (to.x !== undefined || to.y !== undefined) out.push(`dispatch movewindowpixel exact ${Math.round(to.x ?? 0)} ${Math.round(to.y ?? 0)},address:${a}`);
  return out;
}

export function hyprWorkspaceCommand(target: string | number): string {
  const t = typeof target === 'number' ? String(Math.round(target)) : target.trim();
  if (!/^[a-zA-Z0-9_:+\-]{1,32}$/.test(t)) throw new RpError('INVALID_ARGUMENT', 'workspace must be a number or a short name');
  return `dispatch workspace ${t}`;
}

/** `wpctl get-volume` ("Volume: 0.45 [MUTED]") or `pactl` ("... 45% ...") → 0..100. */
export function parseVolumeOutput(text: string): number | null {
  const wp = /Volume:\s*([0-9]*\.?[0-9]+)/i.exec(text);
  if (wp?.[1]) return Math.round(Number(wp[1]) * 100);
  const pct = /(\d{1,3})%/.exec(text);
  if (pct?.[1]) return Math.min(100, Number(pct[1]));
  const num = Number(text.trim());
  return Number.isFinite(num) ? Math.round(num <= 1 ? num * 100 : num) : null;
}

export function clampLevel(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RpError('INVALID_ARGUMENT', 'level must be a number 0..100');
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ---- handler ------------------------------------------------------------------

/** Window/workspace methods have no backend outside Hyprland (no template covers them). */
export const HYPRLAND_REQUIRED_MESSAGE =
  'Window and workspace control (sdk.desktop.listWindows/focusWindow/moveWindow/closeWindow/workspace/currentWorkspace) is only available when the app runs under Hyprland; this desktop session is not Hyprland, so there is nothing to configure';

/** Refusing to close one of our own windows: a character may not shut the app it lives in. */
export const OWN_WINDOW_MESSAGE = 'That window belongs to rpchat itself; a character cannot close the app it lives in';

export interface DesktopHandlerDeps {
  commands: CommandRunner;
  hypr?: HyprTransport;
  launchAllowlist(): Promise<string[]>;
  spawnImpl?: (file: string, args: string[]) => { pid?: number | undefined; unref(): void; on(event: 'error', cb: (err: Error) => void): unknown };
  /** This app's process id, used to recognise its own windows (defaults to `process.pid`). */
  ownPid?: number;
  logger: Pick<Console, 'warn' | 'debug'>;
}

/** One window operation in both Hyprland config dialects; the handler learns which one to speak. */
interface HyprCommands {
  legacy: string[];
  lua: string[];
}

export class DesktopHandler implements CapabilityHandler {
  readonly moduleId = 'desktop';
  /** Which config dialect this session speaks; learned from Hyprland's first answer, never guessed. */
  private parser: HyprParser | undefined;

  constructor(private readonly deps: DesktopHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'launch': {
        const allowlist = await this.deps.launchAllowlist();
        if (allowlist.length > 0 && !(typeof args[0] === 'string' && isLaunchAllowed(args[0], allowlist))) {
          throw new RpError('PERMISSION_DENIED', `"${String(args[0])}" is not on the user's launch allowlist; they can add it under Settings → Integrations → Desktop launch allowlist`, {
            app: String(args[0]),
            allowlist,
          });
        }
        return (await this.launch(args[0], args[1])) as unknown as Json;
      }
      case 'listWindows':
        return (await this.listWindows()) as unknown as Json;
      case 'focusWindow': {
        const w = matchWindow(await this.listWindows(), asMatch(args[0]));
        if (!w) return false;
        await this.hyprDispatch({ legacy: [hyprFocusCommand(w.id)], lua: [luaFocusWindowCommand(w.id)] });
        return true;
      }
      case 'moveWindow': {
        const w = matchWindow(await this.listWindows(), asMatch(args[0]));
        if (!w) return false;
        const to = (args[1] && typeof args[1] === 'object' ? args[1] : {}) as MoveTarget;
        let monitorName: string | undefined;
        if (to.monitor !== undefined) {
          const monitors = await this.hyprJson<HyprMonitorJson[]>('j/monitors');
          const m = typeof to.monitor === 'number' ? monitors[to.monitor] : monitors.find((x) => x.name.toLowerCase() === String(to.monitor).toLowerCase());
          if (!m) throw new RpError('NOT_FOUND', `Unknown monitor ${String(to.monitor)}`);
          monitorName = m.name;
        }
        const lua = luaMoveWindowCommand(w.id, to, monitorName);
        await this.hyprDispatch({ legacy: hyprMoveWindowCommands(w.id, to, monitorName), lua: lua ? [lua] : [] });
        return true;
      }
      case 'closeWindow': {
        const { windows, own } = await this.windowSnapshot();
        const w = matchWindow(windows, asMatch(args[0]));
        if (!w) return false;
        if (own.has(w.id)) throw new RpError('PERMISSION_DENIED', OWN_WINDOW_MESSAGE, { id: w.id, title: w.title, app: w.app });
        await this.hyprDispatch({ legacy: [hyprCloseCommand(w.id)], lua: [luaCloseWindowCommand(w.id)] });
        return true;
      }
      case 'workspace':
        if (typeof args[0] !== 'string' && typeof args[0] !== 'number') throw new RpError('INVALID_ARGUMENT', 'target must be a workspace name or number');
        await this.hyprDispatch({ legacy: [hyprWorkspaceCommand(args[0])], lua: [luaWorkspaceCommand(args[0])] });
        return;
      case 'currentWorkspace': {
        const ws = await this.hyprJson<{ id?: number; name?: string }>('j/activeworkspace');
        return { id: ws.id ?? 0, name: ws.name ?? String(ws.id ?? '') };
      }
      case 'setVolume':
        await this.deps.commands.runChecked('volumeSet', { level: String(clampLevel(args[0])) });
        return;
      case 'getVolume': {
        if (!(await this.deps.commands.isConfigured('volumeGet'))) return null;
        const r = await this.deps.commands.run('volumeGet', {}, 'volume');
        return r.code === 0 ? parseVolumeOutput(r.stdout) : null;
      }
      case 'setBrightness':
        await this.deps.commands.runChecked('brightness', { level: String(clampLevel(args[0])) });
        return;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.desktop.${method}`);
    }
  }

  private async launch(appArg: unknown, argsArg: unknown): Promise<{ pid?: number }> {
    if (typeof appArg !== 'string' || appArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'app must be a non-empty string');
    const args = argsArg === undefined || argsArg === null ? [] : argsArg;
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new RpError('INVALID_ARGUMENT', 'args must be an array of strings');
    const app = expandHome(appArg.trim());
    if (await this.deps.commands.isConfigured('launch')) {
      await this.deps.commands.runChecked('launch', { app, args: (args as string[]).join(' ') });
      return {};
    }
    const spawnImpl = this.deps.spawnImpl ?? ((file: string, a: string[]) => spawn(file, a, { detached: true, stdio: 'ignore', windowsHide: false }));
    return new Promise((resolve, reject) => {
      const child = spawnImpl(app, args as string[]);
      child.on('error', (err) =>
        reject(
          new RpError(
            'CAPABILITY_FAILED',
            isMissingExecutable(err) ? `Cannot launch "${app}": it is not installed or not on PATH` : `Cannot launch "${app}": ${err.message}`,
            { app, ...(isMissingExecutable(err) ? { code: 'ENOENT' } : {}) },
            { cause: err },
          ),
        ),
      );
      setTimeout(() => {
        child.unref();
        resolve(child.pid !== undefined ? { pid: child.pid } : {});
      }, 150);
    });
  }

  async listWindows(): Promise<DesktopWindow[]> {
    return (await this.windowSnapshot()).windows;
  }

  /** One round of Hyprland queries: the list a character sees, plus the addresses it may not close. */
  private async windowSnapshot(): Promise<{ windows: DesktopWindow[]; own: Set<string> }> {
    if (!this.deps.hypr) throw new RpError('CAPABILITY_FAILED', HYPRLAND_REQUIRED_MESSAGE);
    const [clients, monitors, active] = await Promise.all([
      this.hyprJson<HyprClientJson[]>('j/clients'),
      this.hyprJson<HyprMonitorJson[]>('j/monitors'),
      this.hyprJson<{ address?: string }>('j/activewindow').catch(() => ({}) as { address?: string }),
    ]);
    const list = Array.isArray(clients) ? clients : [];
    return {
      windows: windowsFromHyprClients(list, Array.isArray(monitors) ? monitors : [], active.address),
      own: ownWindowIds(list, this.deps.ownPid ?? process.pid),
    };
  }

  private async hyprJson<T>(command: string): Promise<T> {
    if (!this.deps.hypr) throw new RpError('CAPABILITY_FAILED', HYPRLAND_REQUIRED_MESSAGE);
    const text = await this.deps.hypr.request(command);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RpError('CAPABILITY_FAILED', `Hyprland returned invalid JSON for ${command}`);
    }
  }

  /**
   * Send one operation, learning the session's config dialect from the answer
   * (docs/spec/overlay.md §1.2.2): a Lua-config Hyprland rejects a legacy
   * `dispatch …` with a Lua syntax error. That answer comes from the parser, so
   * nothing was applied and the whole operation is re-sent as `eval`.
   */
  private async hyprDispatch(commands: HyprCommands): Promise<void> {
    if (!this.deps.hypr) throw new RpError('CAPABILITY_FAILED', HYPRLAND_REQUIRED_MESSAGE);
    if (this.parser !== 'lua') {
      for (const command of commands.legacy) {
        const res = await this.request(command);
        if (isLuaParserResponse(res)) {
          this.parser = 'lua';
          this.deps.logger.debug('[desktop] Hyprland runs a Lua config: window commands go through `eval` from here on');
          break;
        }
        this.parser = 'legacy';
        this.expectOk(res, command);
      }
      if (this.parser !== 'lua') return;
    }
    for (const command of commands.lua) this.expectOk(await this.request(command), command);
  }

  private async request(command: string): Promise<string> {
    if (!this.deps.hypr) throw new RpError('CAPABILITY_FAILED', HYPRLAND_REQUIRED_MESSAGE);
    return (await this.deps.hypr.request(command)).trim();
  }

  /** Hyprland answers `ok` or the reason it refused; a failed line of an `eval` is reported the same way. */
  private expectOk(res: string, command: string): void {
    if (res.toLowerCase() !== 'ok') throw new RpError('CAPABILITY_FAILED', `Hyprland answered "${res}" to ${command}`);
  }
}

function asMatch(v: unknown): WindowMatch {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const out: WindowMatch = {};
  if (typeof o.id === 'string') out.id = o.id;
  if (typeof o.title === 'string') out.title = o.title;
  if (typeof o.app === 'string') out.app = o.app;
  return out;
}
