import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import {
  IDLE_NOTIFY_TIMEOUT_MS,
  WaylandIdleMonitor,
  bindRequest,
  decodeMessages,
  decodeString,
  encodeMessage,
  encodeString,
  parseGlobal,
  waylandSocketPath,
} from './wayland-idle.js';

/** A socket that records what the monitor writes and lets a test push events back. */
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  readyState = 'open';
  destroyed = false;
  write(chunk: Buffer): boolean {
    this.written.push(Buffer.from(chunk));
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
  /** Messages the monitor sent, decoded. */
  requests(): Array<{ objectId: number; opcode: number; body: Buffer }> {
    return decodeMessages(Buffer.concat(this.written)).messages;
  }
}

/** wl_registry::global(name, interface, version) as the compositor sends it. */
function globalEvent(name: number, iface: string, version: number): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(name, 0);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(version, 0);
  return encodeMessage(2, 0, Buffer.concat([head, encodeString(iface), tail]));
}

describe('wire format', () => {
  it('round-trips headers, strings and globals the way the compositor does', () => {
    const message = encodeMessage(7, 3, Buffer.from([1, 2, 3, 4]));
    expect(message.length).toBe(12);
    const { messages, rest } = decodeMessages(Buffer.concat([message, message.subarray(0, 5)]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ objectId: 7, opcode: 3 });
    expect(rest.length).toBe(5); // a partial message waits for the next chunk

    // Strings carry their NUL and pad to four bytes.
    expect(encodeString('wl_seat').length).toBe(4 + 8);
    expect(decodeString(encodeString('wl_seat'), 0)).toEqual({ value: 'wl_seat', next: 12 });
    expect(parseGlobal(globalEvent(25, 'ext_idle_notifier_v1', 2).subarray(8))).toEqual({ name: 25, interface: 'ext_idle_notifier_v1', version: 2 });
    expect(parseGlobal(Buffer.alloc(4))).toBeUndefined();
  });

  it('builds the two requests the protocol needs', () => {
    const bind = decodeMessages(bindRequest(25, 'ext_idle_notifier_v1', 2, 4)).messages[0]!;
    expect(bind.objectId).toBe(2); // wl_registry
    expect(bind.opcode).toBe(0); // bind
    expect(bind.body.readUInt32LE(0)).toBe(25);
    expect(decodeString(bind.body, 4).value).toBe('ext_idle_notifier_v1');
  });

  it('finds the socket only in a Wayland session', () => {
    expect(waylandSocketPath({ WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000/wayland-1');
    expect(waylandSocketPath({ WAYLAND_DISPLAY: '/tmp/custom.sock' })).toBe('/tmp/custom.sock');
    expect(waylandSocketPath({})).toBeUndefined();
    expect(waylandSocketPath({ WAYLAND_DISPLAY: 'wayland-1' })).toBeUndefined();
  });
});

describe('WaylandIdleMonitor', () => {
  const env = { WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000' };

  function start(now: () => number): { monitor: WaylandIdleMonitor; socket: FakeSocket } {
    const socket = new FakeSocket();
    const monitor = new WaylandIdleMonitor({ env, now, connect: () => socket as unknown as Socket });
    monitor.start();
    return { monitor, socket };
  }

  it('binds the seat and the notifier, then tracks idled/resumed', () => {
    let clock = 10_000;
    const { monitor, socket } = start(() => clock);
    expect(monitor.idleMs()).toBeUndefined(); // nothing confirmed yet: callers fall back
    expect(socket.requests()[0]).toMatchObject({ objectId: 1, opcode: 1 }); // wl_display.get_registry

    socket.emit('data', globalEvent(1, 'wl_seat', 9));
    socket.emit('data', globalEvent(25, 'ext_idle_notifier_v1', 2));
    expect(monitor.available).toBe(true);
    const notification = socket.requests().at(-1)!;
    expect(notification).toMatchObject({ objectId: 4, opcode: 1 }); // notifier.get_idle_notification
    expect(notification.body.readUInt32LE(4)).toBe(IDLE_NOTIFY_TIMEOUT_MS);
    expect(monitor.idleMs()).toBe(0);

    // idled arrives one timeout after the input actually stopped.
    socket.emit('data', encodeMessage(5, 0));
    expect(monitor.idleMs()).toBe(IDLE_NOTIFY_TIMEOUT_MS);
    clock += 60_000;
    expect(monitor.idleMs()).toBe(60_000 + IDLE_NOTIFY_TIMEOUT_MS);

    socket.emit('data', encodeMessage(5, 1)); // resumed
    expect(monitor.idleMs()).toBe(0);
    monitor.stop();
  });

  it('ignores a session without the protocol, and stops reporting when the socket drops', () => {
    const { monitor, socket } = start(() => 0);
    socket.emit('data', globalEvent(1, 'wl_seat', 9));
    socket.emit('data', globalEvent(3, 'wl_compositor', 6));
    expect(monitor.available).toBe(false); // no ext_idle_notifier_v1: fall back to Electron
    expect(monitor.idleMs()).toBeUndefined();

    socket.emit('data', globalEvent(25, 'ext_idle_notifier_v1', 2));
    expect(monitor.available).toBe(true);
    socket.emit('close');
    expect(monitor.available).toBe(false);
    expect(monitor.idleMs()).toBeUndefined();
    monitor.stop();
  });

  it('survives a partial message split across chunks', () => {
    const { monitor, socket } = start(() => 0);
    const globals = Buffer.concat([globalEvent(1, 'wl_seat', 9), globalEvent(25, 'ext_idle_notifier_v1', 2)]);
    socket.emit('data', globals.subarray(0, 7));
    expect(monitor.available).toBe(false);
    socket.emit('data', globals.subarray(7));
    expect(monitor.available).toBe(true);
    monitor.stop();
  });
});
