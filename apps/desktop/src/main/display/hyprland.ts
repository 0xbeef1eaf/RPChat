/**
 * Hyprland display backend (docs/spec/overlay.md §1.2), two tiers:
 *
 * 1. `hyprland` — the native wlr-layer-shell helper (`rp-overlay-wlr`) drives
 *    real layer surfaces; see `helper-backend.ts`.
 * 2. `hyprland-ipc` — fallback when the helper is missing: Electron windows
 *    manipulated through Hyprland's IPC socket (same syntax as `hyprctl`,
 *    `j/` prefix for JSON) with a `hyprctl` CLI fallback.
 *
 * Command construction is pure (`buildCommands`) and the transport is
 * injected so the IPC tier is unit-testable without a Hyprland session.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { DisplayBackendInfo, MonitorInfo, OverlayLayer, OverlayUpdate } from '@rp/shared';
import type { BackendContext, DisplayBackend } from './backend.js';
import type { ElectronOverlay } from './electron.js';
import { ElectronBackend, OVERLAY_TITLE_PREFIX } from './electron.js';
import { HelperBackend } from './helper-backend.js';
import { HelperProcess } from './helper-process.js';
import { clampOpacity, isOverlayLayer } from './layers.js';
import type { Bounds } from './placement.js';

export { OVERLAY_TITLE_PREFIX };
export const HYPRLAND_LAYERS: readonly OverlayLayer[] = ['background', 'bottom', 'top', 'overlay'];

export type HyprEventListener = (event: string, data: string) => void;

/** Request/response transport to Hyprland. `request` resolves with the raw response text. */
export interface HyprTransport {
  request(command: string): Promise<string>;
  /** Best effort event stream (`.socket2.sock`). Returns an unsubscribe. */
  subscribe?(listener: HyprEventListener): () => void;
  close?(): Promise<void> | void;
}

export interface HyprSocketPaths {
  request: string;
  events: string;
}

/** Socket paths for the running instance, or undefined when not under Hyprland. */
export function hyprSocketPaths(env: NodeJS.ProcessEnv = process.env): HyprSocketPaths | undefined {
  const sig = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!sig) return undefined;
  const runtime = env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`;
  const dir = path.join(runtime, 'hypr', sig);
  return { request: path.join(dir, '.socket.sock'), events: path.join(dir, '.socket2.sock') };
}

/** Unix-socket transport. One connection per request (Hyprland closes after answering). */
export class SocketTransport implements HyprTransport {
  constructor(
    private readonly paths: HyprSocketPaths,
    private readonly timeoutMs = 3000,
  ) {}

  request(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let done = false;
      const socket = net.connect(this.paths.request);
      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(Buffer.concat(chunks).toString('utf8'));
      };
      const timer = setTimeout(() => finish(new Error(`Hyprland IPC timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
      socket.once('connect', () => socket.write(command));
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.once('end', () => finish());
      socket.once('close', () => finish());
      socket.once('error', (err) => finish(err));
    });
  }

  subscribe(listener: HyprEventListener): () => void {
    let socket: net.Socket | undefined;
    let closed = false;
    let buffer = '';
    const connect = (): void => {
      if (closed) return;
      socket = net.connect(this.paths.events);
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const sep = line.indexOf('>>');
          if (sep > 0) listener(line.slice(0, sep), line.slice(sep + 2));
          idx = buffer.indexOf('\n');
        }
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        socket = undefined;
        if (!closed) setTimeout(connect, 5000).unref();
      });
    };
    connect();
    return () => {
      closed = true;
      socket?.destroy();
    };
  }
}

/** `hyprctl` CLI transport (used when the socket is unavailable). */
export class CliTransport implements HyprTransport {
  constructor(
    private readonly binary = 'hyprctl',
    private readonly timeoutMs = 5000,
  ) {}

  request(command: string): Promise<string> {
    const args: string[] = [];
    let cmd = command;
    if (cmd.startsWith('[[BATCH]]')) {
      args.push('--batch', cmd.slice('[[BATCH]]'.length));
    } else {
      if (cmd.startsWith('j/')) {
        args.push('-j');
        cmd = cmd.slice(2);
      }
      args.push(...cmd.split(' ').filter((s) => s.length > 0));
    }
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        const text = Buffer.concat(out).toString('utf8');
        if (code === 0 || text.length > 0) resolve(text);
        else reject(new Error(`hyprctl exited with ${code}: ${Buffer.concat(err).toString('utf8')}`));
      });
    });
  }
}

/** Socket first, CLI when the socket is missing or fails. */
export class FallbackTransport implements HyprTransport {
  private useSocket: boolean;

  constructor(
    private readonly socket: SocketTransport | undefined,
    private readonly cli: CliTransport,
    private readonly logger?: Pick<Console, 'warn' | 'debug'>,
  ) {
    this.useSocket = socket !== undefined;
  }

  async request(command: string): Promise<string> {
    if (this.useSocket && this.socket) {
      try {
        return await this.socket.request(command);
      } catch (err) {
        this.logger?.warn?.('[display:hyprland] socket request failed; falling back to hyprctl', err);
        this.useSocket = false;
      }
    }
    return this.cli.request(command);
  }

  subscribe(listener: HyprEventListener): () => void {
    return this.socket ? this.socket.subscribe(listener) : () => undefined;
  }
}

export function createHyprTransport(env: NodeJS.ProcessEnv = process.env, logger?: Pick<Console, 'warn' | 'debug'>): HyprTransport {
  const paths = hyprSocketPaths(env);
  let socket: SocketTransport | undefined;
  if (paths) {
    try {
      if (fs.statSync(paths.request).isSocket()) socket = new SocketTransport(paths);
    } catch {
      socket = undefined;
    }
  }
  return new FallbackTransport(socket, new CliTransport(), logger);
}

// ---- JSON shapes (subset of `hyprctl -j` output) -------------------------

export interface HyprMonitorJson {
  id: number;
  name: string;
  description?: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  transform?: number;
  focused?: boolean;
  disabled?: boolean;
  /** [left, top, right, bottom] */
  reserved?: number[];
}

export interface HyprClientJson {
  address: string;
  mapped?: boolean;
  hidden?: boolean;
  at?: [number, number];
  size?: [number, number];
  monitor?: number;
  title?: string;
  class?: string;
  floating?: boolean;
  pinned?: boolean;
  pid?: number;
}

export interface HyprCursorJson {
  x: number;
  y: number;
}

export function normalizeAddress(address: string): string {
  const a = address.trim().toLowerCase();
  return a.startsWith('0x') ? a : `0x${a}`;
}

/** `j/monitors` (+ `j/cursorpos`) → `MonitorInfo[]` in logical coordinates, minus reserved areas. */
export function parseMonitors(raw: HyprMonitorJson[], cursor?: HyprCursorJson): MonitorInfo[] {
  const usable = raw.filter((m) => !m.disabled);
  let cursorAssigned = false;
  return usable.map((m, index) => {
    const scale = m.scale > 0 ? m.scale : 1;
    const swap = typeof m.transform === 'number' && m.transform % 2 === 1;
    const logicalW = Math.round((swap ? m.height : m.width) / scale);
    const logicalH = Math.round((swap ? m.width : m.height) / scale);
    const [left = 0, top = 0, right = 0, bottom = 0] = m.reserved ?? [];
    const x = m.x + left;
    const y = m.y + top;
    const width = Math.max(1, logicalW - left - right);
    const height = Math.max(1, logicalH - top - bottom);
    let hasCursor: boolean;
    if (cursor) {
      hasCursor = !cursorAssigned && cursor.x >= m.x && cursor.x < m.x + logicalW && cursor.y >= m.y && cursor.y < m.y + logicalH;
    } else hasCursor = m.focused === true;
    if (hasCursor) cursorAssigned = true;
    return { id: String(m.id), name: m.name, index, primary: index === 0, x, y, width, height, scale, hasCursor };
  });
}

/** The client whose title equals `title` (our overlay windows have unique titles). */
export function findClient(clients: HyprClientJson[], title: string): HyprClientJson | undefined {
  return clients.find((c) => c.title === title && typeof c.address === 'string');
}

// ---- pure command construction -------------------------------------------

export interface BuildCommandOptions {
  /** Use the pre-0.45 `setprop … lock` syntax instead of `dispatch setprop`. */
  legacyProps?: boolean;
  /** Name of the monitor the window currently sits on (adds a `movewindow mon:` when it differs). */
  currentMonitor?: string;
  /** Whether Hyprland currently reports the window as pinned (`pin` is a toggle). */
  currentlyPinned?: boolean;
  /** Skip the one-time float/chrome commands (already applied). */
  skipChrome?: boolean;
}

const CHROME_PROPS: ReadonlyArray<[string, string]> = [
  ['noborder', '1'],
  ['noshadow', '1'],
  ['noblur', '1'],
  ['nodim', '1'],
  ['norounding', '1'],
  ['noanim', '1'],
];

export function propCommand(address: string, prop: string, value: string, legacy = false): string {
  if (legacy) return `setprop address:${address} ${prop} ${value}${prop === 'alpha' ? ' lock' : ''}`;
  return `dispatch setprop address:${address} ${prop} ${value}`;
}

export function wantsPin(layer: OverlayLayer): boolean {
  return layer === 'overlay' || layer === 'top' || layer === 'background';
}

/** What the IPC tier needs to know about an overlay to build its commands. */
export interface HyprWindowOptions {
  monitor: MonitorInfo;
  layer: OverlayLayer;
  opacity: number;
  clickThrough: boolean;
  /** Absolute logical px. */
  bounds: Bounds;
}

/** Every Hyprland command needed to make `address` honour `opts`, in order. */
export function buildCommands(opts: HyprWindowOptions, address: string, options: BuildCommandOptions = {}): string[] {
  const a = normalizeAddress(address);
  const legacy = options.legacyProps === true;
  const out: string[] = [];
  if (!options.skipChrome) out.push(`dispatch setfloating address:${a}`);
  if (options.currentMonitor !== undefined && options.currentMonitor !== opts.monitor.name) {
    out.push(`dispatch movewindow mon:${opts.monitor.name},address:${a}`);
  }
  out.push(`dispatch resizewindowpixel exact ${opts.bounds.width} ${opts.bounds.height},address:${a}`);
  out.push(`dispatch movewindowpixel exact ${opts.bounds.x} ${opts.bounds.y},address:${a}`);
  if (!options.skipChrome) for (const [prop, value] of CHROME_PROPS) out.push(propCommand(a, prop, value, legacy));
  out.push(...layerCommands(opts.layer, a, options.currentlyPinned));
  out.push(...opacityCommands(opts.opacity, a, legacy));
  out.push(propCommand(a, 'nofocus', opts.clickThrough ? '1' : '0', legacy));
  return out;
}

export function layerCommands(layer: OverlayLayer, address: string, currentlyPinned?: boolean): string[] {
  const a = normalizeAddress(address);
  const out: string[] = [];
  const pin = wantsPin(layer);
  if (currentlyPinned === undefined ? pin : currentlyPinned !== pin) out.push(`dispatch pin address:${a}`);
  out.push(`dispatch alterzorder ${layer === 'overlay' || layer === 'top' ? 'top' : 'bottom'},address:${a}`);
  return out;
}

export function opacityCommands(opacity: number, address: string, legacy = false): string[] {
  const a = normalizeAddress(address);
  const v = clampOpacity(opacity).toFixed(3).replace(/\.?0+$/, '') || '0';
  if (legacy) return [propCommand(a, 'alpha', v, true)];
  return [propCommand(a, 'alpha', v), propCommand(a, 'alphaoverride', '1')];
}

/** Commands for a live `update` (no placement; that goes through `buildCommands`). */
export function buildUpdateCommands(patch: OverlayUpdate, address: string, options: BuildCommandOptions = {}): string[] {
  const a = normalizeAddress(address);
  const legacy = options.legacyProps === true;
  const out: string[] = [];
  if (patch.layer !== undefined && isOverlayLayer(patch.layer)) out.push(...layerCommands(patch.layer, a, options.currentlyPinned));
  if (patch.opacity !== undefined) out.push(...opacityCommands(clampOpacity(patch.opacity), a, legacy));
  if (patch.clickThrough !== undefined) out.push(propCommand(a, 'nofocus', patch.clickThrough ? '1' : '0', legacy));
  return out;
}

/** Permanent window rules registered once at startup so overlays never get tiled/animated. */
export function windowRuleCommands(): string[] {
  const match = `title:^(${OVERLAY_TITLE_PREFIX}.*)$`;
  return ['float', 'noinitialfocus', 'noborder', 'noshadow', 'noblur', 'noanim', 'pin'].map((rule) => `keyword windowrulev2 ${rule},${match}`);
}

export function batch(commands: string[]): string {
  return `[[BATCH]]${commands.join(';')}`;
}

export function isOkResponse(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return false;
  return t.split(/\s+/).every((part) => part === 'ok');
}

// ---- hyprland-ipc tier ------------------------------------------------------

export interface HyprlandIpcOptions {
  /** Address lookup retries after a window is created (default 20 × 100 ms). */
  lookupAttempts?: number;
  lookupDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface WindowState {
  address: string;
  chromeApplied: boolean;
}

/**
 * Electron windows + Hyprland IPC. Reports layers `top`/`overlay`; `bottom`
 * and `background` are emulated with `alterzorder bottom`, which still leaves
 * the overlay above tiled windows.
 */
export class HyprlandIpcBackend extends ElectronBackend {
  override readonly name = 'hyprland-ipc';
  private readonly lookupAttempts: number;
  private readonly lookupDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly windows = new Map<string, WindowState>();
  private legacyProps = false;
  private rulesRegistered = false;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly transport: HyprTransport,
    electronOptions: ConstructorParameters<typeof ElectronBackend>[0],
    opts: HyprlandIpcOptions = {},
  ) {
    super({ ...electronOptions, windowSystem: 'wayland', platform: 'linux' });
    this.lookupAttempts = opts.lookupAttempts ?? 20;
    this.lookupDelayMs = opts.lookupDelayMs ?? 100;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.subscribeEvents();
    this.log.info?.('[display:hyprland-ipc] layer-shell helper unavailable: bottom/background layers are emulated with alterzorder and stay above tiled windows');
  }

  override info(): DisplayBackendInfo {
    return {
      name: this.name,
      platform: 'linux',
      windowSystem: 'wayland',
      supports: { layers: ['top', 'overlay'], opacity: true, clickThrough: true, monitorSelection: true, exactPosition: true },
    };
  }

  override async monitors(): Promise<MonitorInfo[]> {
    try {
      const raw = await this.json<HyprMonitorJson[]>('j/monitors');
      let cursor: HyprCursorJson | undefined;
      try {
        cursor = await this.json<HyprCursorJson>('j/cursorpos');
      } catch (err) {
        this.log.debug?.('[display:hyprland-ipc] cursorpos unavailable', err);
      }
      const monitors = parseMonitors(Array.isArray(raw) ? raw : [], cursor);
      if (monitors.length > 0) return monitors;
    } catch (err) {
      this.log.warn?.('[display:hyprland-ipc] j/monitors failed; using Electron screen info', err);
    }
    return super.monitors();
  }

  /** Register the `rp-overlay:` window rules (idempotent, best effort). */
  async registerWindowRules(): Promise<void> {
    if (this.rulesRegistered) return;
    this.rulesRegistered = true;
    const commands = windowRuleCommands();
    try {
      const res = await this.transport.request(batch(commands));
      if (isOkResponse(res)) return;
      this.log.debug?.('[display:hyprland-ipc] batch window rules answered', res.trim());
    } catch (err) {
      this.log.debug?.('[display:hyprland-ipc] batch window rules failed; sending individually', err);
    }
    for (const cmd of commands) {
      try {
        await this.transport.request(cmd);
      } catch (err) {
        this.log.warn?.(`[display:hyprland-ipc] window rule failed: ${cmd}`, err);
      }
    }
  }

  protected override async applyWindow(overlay: ElectronOverlay, bounds: Bounds, boundsChanged: boolean): Promise<void> {
    const { win, options } = overlay;
    if (win.isDestroyed()) return;
    await this.registerWindowRules();
    // Electron-side bits that also matter under Wayland.
    win.setFocusable(false);
    win.setIgnoreMouseEvents(options.clickThrough, { forward: true });
    win.setAlwaysOnTop(options.layer === 'top' || options.layer === 'overlay');
    if (boundsChanged) win.setBounds(bounds);
    win.show();
    const found = await this.lookup(overlay);
    if (!found) {
      this.log.warn?.(`[display:hyprland-ipc] window "${win.title}" not found via j/clients; placement left to the compositor`);
      return;
    }
    const { client, state } = found;
    const monitors = await this.monitors().catch(() => [] as MonitorInfo[]);
    const currentMonitor = typeof client.monitor === 'number' ? monitors.find((m) => m.id === String(client.monitor))?.name : undefined;
    const commandOptions: BuildCommandOptions = {
      legacyProps: this.legacyProps,
      currentlyPinned: client.pinned === true,
      skipChrome: state.chromeApplied,
    };
    if (currentMonitor !== undefined) commandOptions.currentMonitor = currentMonitor;
    const hyprOptions: HyprWindowOptions = {
      monitor: options.monitor,
      layer: options.layer,
      opacity: options.opacity,
      clickThrough: options.clickThrough,
      bounds,
    };
    await this.run(buildCommands(hyprOptions, state.address, commandOptions), state.address, options.opacity);
    state.chromeApplied = true;
  }

  override forget(overlay: ElectronOverlay): void {
    super.forget(overlay);
    this.windows.delete(overlay.win.id);
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.windows.clear();
    await this.transport.close?.();
  }

  /** Send commands one by one; when the `dispatch setprop …` form is rejected, switch to the legacy syntax for good. */
  private async run(commands: string[], address: string, opacity: number | undefined): Promise<void> {
    for (const raw of commands) {
      // The legacy syntax has no alphaoverride; `alpha … lock` already pins the value.
      if (this.legacyProps && / alphaoverride /.test(raw)) continue;
      const cmd = this.legacyProps ? toLegacy(raw) : raw;
      let res: string;
      try {
        res = await this.transport.request(cmd);
      } catch (err) {
        this.log.warn?.(`[display:hyprland-ipc] "${cmd}" failed`, err);
        continue;
      }
      if (isOkResponse(res)) continue;
      if (!this.legacyProps && cmd.startsWith('dispatch setprop ')) {
        this.log.info?.(`[display:hyprland-ipc] "dispatch setprop" rejected (${res.trim()}); switching to legacy setprop syntax`);
        this.legacyProps = true;
        const legacyCmds = cmd.includes(' alpha ') && opacity !== undefined ? opacityCommands(opacity, address, true) : [toLegacy(cmd)];
        for (const legacy of legacyCmds) {
          const r = await this.transport.request(legacy).catch((e: Error) => e.message);
          if (!isOkResponse(r)) this.log.warn?.(`[display:hyprland-ipc] "${legacy}" answered: ${r.trim()}`);
        }
        continue;
      }
      this.log.warn?.(`[display:hyprland-ipc] "${cmd}" answered: ${res.trim()}`);
    }
  }

  private async lookup(overlay: ElectronOverlay): Promise<{ client: HyprClientJson; state: WindowState } | undefined> {
    const { win } = overlay;
    for (let attempt = 0; attempt < this.lookupAttempts; attempt += 1) {
      if (win.isDestroyed() || overlay.closed) return undefined;
      let clients: HyprClientJson[] = [];
      try {
        const raw = await this.json<HyprClientJson[]>('j/clients');
        clients = Array.isArray(raw) ? raw : [];
      } catch (err) {
        this.log.debug?.('[display:hyprland-ipc] j/clients failed', err);
      }
      const client = findClient(clients, win.title);
      if (client) {
        const address = normalizeAddress(client.address);
        let state = this.windows.get(win.id);
        if (!state || state.address !== address) {
          state = { address, chromeApplied: false };
          this.windows.set(win.id, state);
        }
        return { client, state };
      }
      if (attempt + 1 < this.lookupAttempts) await this.sleep(this.lookupDelayMs);
    }
    return undefined;
  }

  private async json<T>(command: string): Promise<T> {
    const text = await this.transport.request(command);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`Hyprland returned invalid JSON for "${command}": ${text.slice(0, 200)}`, { cause: err });
    }
  }

  private subscribeEvents(): void {
    if (!this.transport.subscribe) return;
    try {
      this.unsubscribe = this.transport.subscribe((event, data) => {
        if (event === 'closewindow') {
          const address = normalizeAddress(data);
          for (const [id, state] of this.windows) if (state.address === address) this.windows.delete(id);
        } else if (event === 'monitoradded' || event === 'monitorremoved') {
          this.log.debug?.(`[display:hyprland-ipc] ${event}: ${data}`);
        }
      });
    } catch (err) {
      this.log.debug?.('[display:hyprland-ipc] event subscription failed', err);
    }
  }
}

/** "dispatch setprop address:0x… prop value" → "setprop address:0x… prop value" (alpha gets `lock`). */
function toLegacy(cmd: string): string {
  if (!cmd.startsWith('dispatch setprop ')) return cmd;
  const legacy = cmd.replace(/^dispatch setprop /, 'setprop ');
  return / alpha /.test(legacy) ? `${legacy} lock` : legacy;
}

// ---- tier selection ---------------------------------------------------------

/**
 * `hyprland` when the layer-shell helper starts and answers `hello`,
 * otherwise `hyprland-ipc` (with the reason logged).
 */
export async function createHyprlandBackend(ctx: BackendContext): Promise<DisplayBackend> {
  const transport = ctx.hyprTransport ?? createHyprTransport(ctx.env, ctx.logger);
  const binary = ctx.findHelper();
  if (binary) {
    const helper = ctx.helperFactory ? ctx.helperFactory(binary) : new HelperProcess({ binary, logger: ctx.logger });
    try {
      const ready = await helper.start();
      const loopback = await ctx.loopback();
      ctx.logger.info(`[display:hyprland] layer-shell helper ready (${binary}, protocol v${ready.version})`);
      return new HelperBackend({ helper, loopback, ready, hypr: transport, logger: ctx.logger });
    } catch (err) {
      ctx.logger.warn(`[display:hyprland] helper "${binary}" failed to start; falling back to hyprland-ipc: ${(err as Error).message}`);
      await helper.dispose().catch(() => undefined);
    }
  } else {
    ctx.logger.warn('[display:hyprland] rp-overlay-wlr helper not found (RP_OVERLAY_HELPER, resources/bin, PATH); falling back to hyprland-ipc');
  }
  return new HyprlandIpcBackend(transport, {
    screen: ctx.screen,
    createWindow: ctx.createWindow,
    platform: 'linux',
    windowSystem: 'wayland',
    logger: ctx.logger,
  });
}
