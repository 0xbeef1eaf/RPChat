/**
 * Which virtual terminal is in the foreground, and the `vt-changed` host event when it moves.
 *
 * The user pressing ctrl+alt+F3 is invisible to everything else the app watches: the compositor
 * keeps running, no window changes, the idle timer carries on. The kernel does publish it, in
 * `/sys/class/tty/tty0/active` ("tty3\n"), which is world-readable — so noticing a switch needs
 * neither root nor the rpchatd daemon, only a cheap read on a timer (sysfs has no inotify, and
 * `poll()` on it is not reachable from Node).
 *
 * Acting on a switch *is* privileged and lives in the daemon (`sdk.system.vtSwitchBack`,
 * `vtPreventSwitching`); this file only tells the characters it happened.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostEvent } from '@rp/shared';
import type { Logger } from '@rp/core';

/** Where the kernel publishes the foreground VT. */
export const VT_ACTIVE_PATH = '/sys/class/tty/tty0/active';
/** Where logind keeps one state file per session (`VTNR=` is the session's own VT). */
export const SESSIONS_DIR = '/run/systemd/sessions';
/**
 * How often the foreground VT is read. One four-byte read of a sysfs file, so this is far
 * cheaper than the presence poll next to it (which runs `hyprctl` and `playerctl`), and a
 * second is about as late as a character may notice the user walked off to a console.
 */
export const VT_POLL_MS = 1000;

/** `"tty3\n"` → 3. `null` for anything that is not a numbered VT (`tty`, an empty file). */
export function parseActiveVt(text: string): number | null {
  const m = /^tty(\d+)\s*$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `VTNR=2` out of a logind session state file; `null` when it is on no VT. */
export function parseSessionVt(text: string): number | null {
  for (const line of text.split('\n')) {
    const [key, value] = line.split('=', 2);
    if (key?.trim() !== 'VTNR') continue;
    const n = Number((value ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export interface VtMonitorOptions {
  /** Pushes the `vt-changed` host event. */
  emit(event: HostEvent): void;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. */
  readFile?: (file: string) => string;
  pollMs?: number;
  now?: () => Date;
}

/**
 * Reads the foreground VT on a timer and emits `vt-changed` when it moves. The first read is
 * the baseline and raises nothing: a switch is a change, and the app starting is not one.
 */
export class VtMonitor {
  private timer: NodeJS.Timeout | undefined;
  private current: number | null = null;
  private ourVt: number | null = null;
  /** Whether reading the VT has already been reported as impossible (log once, not every second). */
  private warned = false;

  constructor(private readonly o: VtMonitorOptions) {}

  /** The VT this app's own session is on, from `XDG_VTNR` or logind's state file. */
  sessionVt(): number | null {
    if (this.ourVt !== null) return this.ourVt;
    const env = this.o.env ?? process.env;
    const fromEnv = Number(env.XDG_VTNR);
    if (Number.isInteger(fromEnv) && fromEnv > 0) {
      this.ourVt = fromEnv;
      return this.ourVt;
    }
    // `XDG_VTNR` is not in the environment of everything a session starts — an app launched
    // through a systemd user unit (`uwsm app --`, an autostart service) does not get it — so
    // fall back to the session's own state file, which is world-readable.
    const id = env.XDG_SESSION_ID;
    if (id !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      const text = this.read(path.join(SESSIONS_DIR, id));
      if (text !== undefined) this.ourVt = parseSessionVt(text);
    }
    return this.ourVt;
  }

  /** The foreground VT right now, or `null` where it cannot be read (no VTs, a container). */
  activeVt(): number | null {
    const text = this.read(VT_ACTIVE_PATH);
    return text === undefined ? null : parseActiveVt(text);
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.current = this.activeVt();
    if (this.current === null) {
      this.o.logger.debug(`[senses] no virtual terminals here (${VT_ACTIVE_PATH} is not readable); vt-changed will not fire`);
      return;
    }
    this.sessionVt();
    this.o.logger.debug(`[senses] watching virtual terminals: on tty${this.current}, this session owns ${this.ourVt === null ? 'none' : `tty${this.ourVt}`}`);
    this.timer = setInterval(() => this.poll(), this.o.pollMs ?? VT_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One read; emits when the foreground VT differs from the last one. Never throws. */
  poll(): void {
    const vt = this.activeVt();
    if (vt === null || vt === this.current) return;
    const previous = this.current;
    this.current = vt;
    if (previous === null) return;
    const ourVt = this.sessionVt();
    this.o.emit({
      name: 'vt-changed',
      data: { vt, previous, ourVt, ours: ourVt !== null && ourVt === vt },
      at: (this.o.now ?? (() => new Date()))().toISOString(),
    });
  }

  private read(file: string): string | undefined {
    try {
      return (this.o.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8')))(file);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.o.logger.debug(`[senses] cannot read ${file}`, err);
      }
      return undefined;
    }
  }
}
