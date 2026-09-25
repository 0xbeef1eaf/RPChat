/**
 * When the tray may be built (`index.ts` `createTray`).
 *
 * Electron's tray on Linux is a StatusNotifierItem on the session bus, and Chromium picks the
 * backend exactly once, inside the `new Tray()` call: if `org.kde.StatusNotifierWatcher` is
 * unowned, or its `IsStatusNotifierHostRegistered` is still false at that moment, it falls back to
 * the old XEmbed icon for the rest of the process and never reconsiders. A Wayland session has no
 * XEmbed tray at all, so there the icon is simply never seen. Panels and shells claim that name a
 * second or two into the session — exactly when the autostart entry runs `rpchat --hidden` — so
 * the app loses the race at login and comes up with no tray, while the same binary started by hand
 * a minute later is fine. That is the tray icon that "sometimes" does not show.
 *
 * So the tray waits for a host to be registered before it is built, and on Wayland, where a tray
 * built without one is invisible, it is built again if a host only turns up later. The property is
 * read with whichever bus tool the machine happens to have (`busctl`, `gdbus`, `dbus-send`) — none
 * of them a dependency: with no tool at all, and off Linux, the answer is "go ahead" and the tray
 * is built straight away, as it always was. Probe, clock and sleep are injectable so the waiting
 * is unit-tested without a bus.
 */
import { spawn } from 'node:child_process';

export const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
export const WATCHER_PATH = '/StatusNotifierWatcher';
export const HOST_REGISTERED_PROPERTY = 'IsStatusNotifierHostRegistered';

/** How long the tray waits for a host. Without a StatusNotifier host X11 still has XEmbed, Wayland has nothing — so Wayland waits longer. */
export const HOST_WAIT_MS = { wayland: 15_000, other: 3_000 } as const;
export const HOST_POLL_MS = 250;
/** After the wait has given up on Wayland the tray is invisible, so keep looking for a shell that started late. */
export const HOST_WATCH_MS = 300_000;
export const HOST_WATCH_POLL_MS = 5_000;
/** A bus tool that does not answer this quickly is not going to. */
const PROBE_TIMEOUT_MS = 2_000;

/** The bus tools that can read the property, best first; the first one installed is the one used. */
export const HOST_PROBE_COMMANDS: ReadonlyArray<{ file: string; args: readonly string[] }> = [
  { file: 'busctl', args: ['--user', 'get-property', WATCHER_NAME, WATCHER_PATH, WATCHER_NAME, HOST_REGISTERED_PROPERTY] },
  { file: 'gdbus', args: ['call', '--session', '--dest', WATCHER_NAME, '--object-path', WATCHER_PATH, '--method', 'org.freedesktop.DBus.Properties.Get', WATCHER_NAME, HOST_REGISTERED_PROPERTY] },
  { file: 'dbus-send', args: ['--session', '--print-reply', `--dest=${WATCHER_NAME}`, WATCHER_PATH, 'org.freedesktop.DBus.Properties.Get', `string:${WATCHER_NAME}`, `string:${HOST_REGISTERED_PROPERTY}`] },
];

/** `'missing'`: the tool is not installed, so ask the next one. */
export type ProbeResult = { code: number; stdout: string } | 'missing';
export type ProbeRunner = (file: string, args: string[]) => Promise<ProbeResult>;

/**
 * Pure: does a probe's output say a host is registered? All three tools print the boolean in the
 * reply (`b true`, `(<true>,)`, `variant boolean true`); an error exit is a no, as is a watcher
 * that is there but still hostless.
 */
export function hostRegistered(result: ProbeResult): boolean {
  return result !== 'missing' && result.code === 0 && /\btrue\b/.test(result.stdout);
}

export interface HostWaitDeps {
  probe: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // Unref'd: a wait in progress must never be the reason the process stays up.
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Poll until a host answers or `timeoutMs` has passed. The first probe is immediate, so the usual
 * case — a session that has been up for hours — costs one `busctl` and no delay at all.
 */
export async function waitForHost(deps: HostWaitDeps, opts: { timeoutMs: number; pollMs: number }): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    if (await deps.probe()) return true;
    if (now() + opts.pollMs > deadline) return false;
    await sleep(opts.pollMs);
  }
}

/**
 * Call `build` when the tray may be created: as soon as a host is registered, or once the wait
 * gives up — an X11 session still gets its XEmbed icon, and a session with no tray host at all is
 * no worse off than it was before. On Wayland the tray built at that point is invisible, so the
 * watch goes on and `build` is called a second time if a host turns up within `HOST_WATCH_MS`;
 * the caller replaces the tray it has, Chromium not being willing to reconsider an existing one.
 */
export async function buildTrayWhenHostReady(deps: HostWaitDeps & { wayland: boolean }, build: (hostReady: boolean) => void): Promise<void> {
  const ready = await waitForHost(deps, { timeoutMs: deps.wayland ? HOST_WAIT_MS.wayland : HOST_WAIT_MS.other, pollMs: HOST_POLL_MS });
  build(ready);
  if (ready || !deps.wayland) return;
  if (await waitForHost(deps, { timeoutMs: HOST_WATCH_MS, pollMs: HOST_WATCH_POLL_MS })) build(true);
}

/** Run one bus tool, `'missing'` when it is not installed; a tool that hangs is killed and counts as a no. */
function runProbe(file: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: -1, stdout });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.on('error', (err: NodeJS.ErrnoException) => done(err.code === 'ENOENT' ? 'missing' : { code: -1, stdout }));
    child.on('close', (code) => done({ code: code ?? -1, stdout }));
  });
}

/**
 * The probe `index.ts` uses: reads the property with the first bus tool that is installed, and
 * remembers which ones are not. Off Linux — and on a Linux box with no bus tool, where waiting
 * could only ever time out — it answers "registered", which builds the tray immediately.
 */
export function statusNotifierHostProbe(deps: { platform?: NodeJS.Platform; run?: ProbeRunner } = {}): () => Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') return () => Promise.resolve(true);
  const run = deps.run ?? runProbe;
  const missing = new Set<string>();
  return async () => {
    for (const command of HOST_PROBE_COMMANDS) {
      if (missing.has(command.file)) continue;
      const result = await run(command.file, [...command.args]);
      if (result === 'missing') {
        missing.add(command.file);
        continue;
      }
      return hostRegistered(result);
    }
    return true;
  };
}
