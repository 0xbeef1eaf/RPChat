/**
 * Idle time on Wayland (docs/spec/living.md §4).
 *
 * Electron's `powerMonitor.getSystemIdleTime()` reads X11's screensaver
 * extension: under a Wayland session it never sees Wayland-native input and
 * returns a flat 0, so `user-idle` never fired and the presence line always
 * claimed the user was at the keyboard.
 *
 * Wayland's answer is `ext-idle-notify-v1`, which every wlroots-based
 * compositor (Hyprland, Sway, river), KDE and recent GNOME implement. The wire
 * protocol is small enough to speak directly over the display socket — a few
 * fixed-shape messages — so this needs no native module and no dependency.
 *
 * We ask for a notification at a short timeout and derive the idle time from
 * when it arrived: `idled` at T means the user has been idle since T minus that
 * timeout, `resumed` means zero again.
 */
import * as net from 'node:net';
import * as path from 'node:path';

/** Our object ids. 1 is always wl_display; the rest are ours to assign. */
const DISPLAY_ID = 1;
const REGISTRY_ID = 2;
const SEAT_ID = 3;
const NOTIFIER_ID = 4;
const NOTIFICATION_ID = 5;

/** wl_display::get_registry. */
const OP_DISPLAY_GET_REGISTRY = 1;
/** wl_registry::bind. */
const OP_REGISTRY_BIND = 0;
/** ext_idle_notifier_v1::get_idle_notification. */
const OP_NOTIFIER_GET_NOTIFICATION = 1;

/** wl_display::error, wl_registry::global, notification idled/resumed. */
const EV_DISPLAY_ERROR = 0;
const EV_REGISTRY_GLOBAL = 0;
const EV_NOTIFICATION_IDLED = 0;
const EV_NOTIFICATION_RESUMED = 1;

const IDLE_NOTIFIER_INTERFACE = 'ext_idle_notifier_v1';
const SEAT_INTERFACE = 'wl_seat';

/** Shortest notification the protocol takes seriously; also our idle resolution. */
export const IDLE_NOTIFY_TIMEOUT_MS = 1000;

export interface WaylandMessage {
  objectId: number;
  opcode: number;
  /** A view into the received chunk (`subarray`), hence the wider buffer type. */
  body: Buffer<ArrayBufferLike>;
}

/** A Wayland request: 4-byte object id, 2-byte opcode, 2-byte total size, then the body. */
export function encodeMessage(objectId: number, opcode: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(objectId, 0);
  header.writeUInt16LE(opcode, 4);
  header.writeUInt16LE(8 + body.length, 6);
  return Buffer.concat([header, body]);
}

/** Split a received buffer into whole messages, returning the unconsumed remainder. */
export function decodeMessages(buffer: Buffer<ArrayBufferLike>): { messages: WaylandMessage[]; rest: Buffer<ArrayBufferLike> } {
  const messages: WaylandMessage[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const size = buffer.readUInt16LE(offset + 6);
    if (size < 8 || buffer.length - offset < size) break;
    messages.push({
      objectId: buffer.readUInt32LE(offset),
      opcode: buffer.readUInt16LE(offset + 4),
      body: buffer.subarray(offset + 8, offset + size),
    });
    offset += size;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** Wayland strings are a length (including the NUL) then the bytes, padded to 4. */
export function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const padded = Math.ceil((bytes.length + 1) / 4) * 4;
  const out = Buffer.alloc(4 + padded);
  out.writeUInt32LE(bytes.length + 1, 0);
  bytes.copy(out, 4);
  return out;
}

export function decodeString(body: Buffer<ArrayBufferLike>, offset: number): { value: string; next: number } {
  const length = body.readUInt32LE(offset);
  const value = body.subarray(offset + 4, offset + 4 + Math.max(0, length - 1)).toString('utf8');
  return { value, next: offset + 4 + Math.ceil(length / 4) * 4 };
}

export interface Global {
  name: number;
  interface: string;
  version: number;
}

/** wl_registry::global(name: uint, interface: string, version: uint). */
export function parseGlobal(body: Buffer<ArrayBufferLike>): Global | undefined {
  if (body.length < 12) return undefined;
  const name = body.readUInt32LE(0);
  const { value, next } = decodeString(body, 4);
  if (next + 4 > body.length) return undefined;
  return { name, interface: value, version: body.readUInt32LE(next) };
}

/** wl_registry::bind(name, interface, version, new_id) — the "new id with interface" form. */
export function bindRequest(name: number, iface: string, version: number, newId: number): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(name, 0);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(version, 0);
  tail.writeUInt32LE(newId, 4);
  return encodeMessage(REGISTRY_ID, OP_REGISTRY_BIND, Buffer.concat([head, encodeString(iface), tail]));
}

/** ext_idle_notifier_v1::get_idle_notification(new_id, timeout_ms, seat). */
export function idleNotificationRequest(newId: number, timeoutMs: number, seatId: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt32LE(newId, 0);
  body.writeUInt32LE(timeoutMs, 4);
  body.writeUInt32LE(seatId, 8);
  return encodeMessage(NOTIFIER_ID, OP_NOTIFIER_GET_NOTIFICATION, body);
}

/** Path of the compositor socket, or undefined when this is not a Wayland session. */
export function waylandSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const display = env.WAYLAND_DISPLAY;
  if (!display || display.length === 0) return undefined;
  if (path.isAbsolute(display)) return display;
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime && runtime.length > 0 ? path.join(runtime, display) : undefined;
}

export interface WaylandIdleOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'info' | 'warn' | 'debug'>;
  /** Injected in tests; defaults to a real unix socket. */
  connect?: (socketPath: string) => net.Socket;
  now?: () => number;
  /** Retry delay after the connection drops (compositor restart). Default 10 s. */
  reconnectMs?: number;
}

/**
 * Tracks how long the seat has been idle. `idleMs()` returns undefined until
 * the compositor has confirmed the protocol, so callers can fall back.
 */
export class WaylandIdleMonitor {
  private socket: net.Socket | undefined;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private seatName: number | undefined;
  private notifierName: number | undefined;
  private notifierVersion = 1;
  private watching = false;
  private idleSince: number | undefined;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: WaylandIdleOptions['logger'];
  private readonly now: () => number;
  private readonly reconnectMs: number;
  private readonly connect: (socketPath: string) => net.Socket;

  constructor(options: WaylandIdleOptions = {}) {
    this.env = options.env ?? process.env;
    this.log = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.reconnectMs = options.reconnectMs ?? 10_000;
    this.connect = options.connect ?? ((socketPath) => net.connect(socketPath));
  }

  /** True once the compositor answered with a working idle notification. */
  get available(): boolean {
    return this.watching;
  }

  /** Milliseconds since the last input, or undefined while the protocol is not confirmed. */
  idleMs(): number | undefined {
    if (!this.watching) return undefined;
    if (this.idleSince === undefined) return 0;
    return this.now() - this.idleSince;
  }

  /** Connect and subscribe. Never throws: an unavailable protocol just leaves `available` false. */
  start(): void {
    const socketPath = waylandSocketPath(this.env);
    if (!socketPath) return;
    let socket: net.Socket;
    try {
      socket = this.connect(socketPath);
    } catch (err) {
      this.log?.debug?.('[senses:wayland-idle] connect failed', err);
      return;
    }
    this.socket = socket;
    socket.on('error', (err) => {
      this.log?.debug?.('[senses:wayland-idle] socket error', err);
    });
    socket.on('close', () => this.onClose());
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('connect', () => this.send(encodeMessage(DISPLAY_ID, OP_DISPLAY_GET_REGISTRY, idBuffer(REGISTRY_ID))));
    // A socket handed to us in tests may already be connected.
    if (socket.readyState === 'open') this.send(encodeMessage(DISPLAY_ID, OP_DISPLAY_GET_REGISTRY, idBuffer(REGISTRY_ID)));
  }

  stop(): void {
    this.closed = true;
    this.watching = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }

  private send(message: Buffer): void {
    try {
      this.socket?.write(message);
    } catch (err) {
      this.log?.debug?.('[senses:wayland-idle] write failed', err);
    }
  }

  private onClose(): void {
    this.socket = undefined;
    this.watching = false;
    this.idleSince = undefined;
    this.seatName = undefined;
    this.notifierName = undefined;
    this.buffer = Buffer.alloc(0);
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => this.start(), this.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const { messages, rest } = decodeMessages(this.buffer);
    this.buffer = rest;
    for (const message of messages) this.handle(message);
  }

  private handle(message: WaylandMessage): void {
    if (message.objectId === DISPLAY_ID && message.opcode === EV_DISPLAY_ERROR) {
      this.log?.debug?.(`[senses:wayland-idle] compositor error: ${message.body.subarray(8).toString('utf8')}`);
      return;
    }
    if (message.objectId === REGISTRY_ID && message.opcode === EV_REGISTRY_GLOBAL) {
      const global = parseGlobal(message.body);
      if (!global) return;
      if (global.interface === SEAT_INTERFACE && this.seatName === undefined) {
        this.seatName = global.name;
        this.send(bindRequest(global.name, SEAT_INTERFACE, Math.min(global.version, 7), SEAT_ID));
      } else if (global.interface === IDLE_NOTIFIER_INTERFACE && this.notifierName === undefined) {
        this.notifierName = global.name;
        this.notifierVersion = global.version;
        this.send(bindRequest(global.name, IDLE_NOTIFIER_INTERFACE, Math.min(global.version, 2), NOTIFIER_ID));
      }
      this.watchWhenReady();
      return;
    }
    if (message.objectId === NOTIFICATION_ID) {
      if (message.opcode === EV_NOTIFICATION_IDLED) {
        // The event says "idle for at least the timeout", so it started then.
        this.idleSince = this.now() - IDLE_NOTIFY_TIMEOUT_MS;
      } else if (message.opcode === EV_NOTIFICATION_RESUMED) {
        this.idleSince = undefined;
      }
    }
  }

  private watchWhenReady(): void {
    if (this.watching || this.seatName === undefined || this.notifierName === undefined) return;
    this.send(idleNotificationRequest(NOTIFICATION_ID, IDLE_NOTIFY_TIMEOUT_MS, SEAT_ID));
    this.watching = true;
    this.log?.info?.(`[senses:wayland-idle] idle notifications via ${IDLE_NOTIFIER_INTERFACE} v${this.notifierVersion}`);
  }
}

function idBuffer(id: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(id, 0);
  return out;
}
