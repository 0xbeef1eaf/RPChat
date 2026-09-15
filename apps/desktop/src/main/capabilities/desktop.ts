/** `sdk.desktop`: window management (Hyprland IPC), app launching (allowlist), volume/brightness/DND/theme via templates. */
import { spawn } from 'node:child_process';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError } from '@rp/shared';
import { expandHome, isMissingExecutable } from '../commands.js';
import type { HyprClientJson, HyprMonitorJson, HyprTransport } from '../display/hyprland.js';
import { normalizeAddress } from '../display/hyprland.js';
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
  'Window and workspace control (sdk.desktop.listWindows/focusWindow/moveWindow/workspace/currentWorkspace) is only available when the app runs under Hyprland; this desktop session is not Hyprland, so there is nothing to configure';

export interface DesktopHandlerDeps {
  commands: CommandRunner;
  hypr?: HyprTransport;
  launchAllowlist(): Promise<string[]>;
  spawnImpl?: (file: string, args: string[]) => { pid?: number | undefined; unref(): void; on(event: 'error', cb: (err: Error) => void): unknown };
  logger: Pick<Console, 'warn' | 'debug'>;
}

export class DesktopHandler implements CapabilityHandler {
  readonly moduleId = 'desktop';

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
        await this.hyprOk(hyprFocusCommand(w.id));
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
        for (const cmd of hyprMoveWindowCommands(w.id, to, monitorName)) await this.hyprOk(cmd);
        return true;
      }
      case 'workspace':
        if (typeof args[0] !== 'string' && typeof args[0] !== 'number') throw new RpError('INVALID_ARGUMENT', 'target must be a workspace name or number');
        await this.hyprOk(hyprWorkspaceCommand(args[0]));
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
    if (!this.deps.hypr) throw new RpError('CAPABILITY_FAILED', HYPRLAND_REQUIRED_MESSAGE);
    const [clients, monitors, active] = await Promise.all([
      this.hyprJson<HyprClientJson[]>('j/clients'),
      this.hyprJson<HyprMonitorJson[]>('j/monitors'),
      this.hyprJson<{ address?: string }>('j/activewindow').catch(() => ({}) as { address?: string }),
    ]);
    return windowsFromHyprClients(Array.isArray(clients) ? clients : [], Array.isArray(monitors) ? monitors : [], active.address);
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

  private async hyprOk(command: string): Promise<void> {
    if (!this.deps.hypr) throw new RpError('CAPABILITY_FAILED', HYPRLAND_REQUIRED_MESSAGE);
    const res = await this.deps.hypr.request(command);
    if (res.trim().toLowerCase() !== 'ok') throw new RpError('CAPABILITY_FAILED', `Hyprland answered "${res.trim()}" to ${command}`);
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
