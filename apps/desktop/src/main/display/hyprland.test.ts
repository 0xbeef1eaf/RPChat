import { describe, expect, it } from 'vitest';
import type { OverlaySpec, OverlayWindowLike } from './backend.js';
import { resolveOverlayOptions } from './backend.js';
import type { HyprClientJson, HyprMonitorJson, HyprTransport } from './hyprland.js';
import {
  HyprlandIpcBackend,
  batch,
  buildCommands,
  buildUpdateCommands,
  findClient,
  hyprSocketPaths,
  isOkResponse,
  parseMonitors,
  windowRuleCommands,
} from './hyprland.js';
import { FakeOverlayWindow, fakeScreen } from './test-fakes.js';

/** Verbatim refusal from Hyprland 0.56.2 when the session runs a Lua config. */
const LUA_REFUSAL = "keyword can't work with non-legacy parsers. Use eval.";

/** Shapes taken from real `hyprctl -j monitors` output (Hyprland 0.4x). */
const MONITORS: HyprMonitorJson[] = [
  {
    id: 0, name: 'DP-1', description: 'Dell Inc. DELL U2723QE ABC123', width: 3840, height: 2160, x: 0, y: 0, scale: 2, transform: 0,
    focused: true, disabled: false, reserved: [0, 40, 0, 0],
  },
  { id: 1, name: 'HDMI-A-1', description: 'LG', width: 1920, height: 1080, x: 1920, y: 0, scale: 1, transform: 1, focused: false, disabled: false, reserved: [0, 0, 0, 0] },
  { id: 2, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 1080, scale: 1, focused: false, disabled: true },
];

/** Shape taken from real `hyprctl -j clients` output. */
const CLIENTS: HyprClientJson[] = [
  { address: '0x55d2a1b2c3d0', mapped: true, hidden: false, at: [100, 100], size: [800, 600], monitor: 0, class: 'kitty', title: 'zsh', floating: false, pinned: false, pid: 4242 },
  { address: '0x55d2a1ff0000', mapped: true, hidden: false, at: [0, 0], size: [480, 320], monitor: 1, class: 'rp-code', title: 'rp-overlay:abc-1', floating: true, pinned: false, pid: 4300 },
];

describe('parseMonitors', () => {
  it('converts physical geometry to logical work areas, honours transform/reserved/disabled and the cursor', () => {
    const list = parseMonitors(MONITORS, { x: 2000, y: 100 });
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: '0', name: 'DP-1', index: 0, primary: true, x: 0, y: 40, width: 1920, height: 1040, scale: 2, hasCursor: false });
    // transform 1 = rotated 90°: width/height swap.
    expect(list[1]).toEqual({ id: '1', name: 'HDMI-A-1', index: 1, primary: false, x: 1920, y: 0, width: 1080, height: 1920, scale: 1, hasCursor: true });
  });

  it('falls back to `focused` for the cursor when cursorpos is unavailable', () => {
    expect(parseMonitors(MONITORS).map((m) => m.hasCursor)).toEqual([true, false]);
  });
});

describe('buildCommands', () => {
  const monitors = parseMonitors(MONITORS);
  const options = resolveOverlayOptions({ monitor: 'primary', layer: 'overlay', opacity: 0.75, clickThrough: true }, monitors, { layer: 'top' });
  const hypr = { monitor: options.monitor, layer: options.layer, opacity: options.opacity, clickThrough: true, bounds: { x: 100, y: 200, width: 480, height: 320 } };

  it('emits float, placement, chrome, layer, opacity and focus commands with the address', () => {
    expect(buildCommands(hypr, '55d2a1ff0000')).toEqual([
      'dispatch setfloating address:0x55d2a1ff0000',
      'dispatch resizewindowpixel exact 480 320,address:0x55d2a1ff0000',
      'dispatch movewindowpixel exact 100 200,address:0x55d2a1ff0000',
      'dispatch setprop address:0x55d2a1ff0000 noborder 1',
      'dispatch setprop address:0x55d2a1ff0000 noshadow 1',
      'dispatch setprop address:0x55d2a1ff0000 noblur 1',
      'dispatch setprop address:0x55d2a1ff0000 nodim 1',
      'dispatch setprop address:0x55d2a1ff0000 norounding 1',
      'dispatch setprop address:0x55d2a1ff0000 noanim 1',
      'dispatch pin address:0x55d2a1ff0000',
      'dispatch alterzorder top,address:0x55d2a1ff0000',
      'dispatch setprop address:0x55d2a1ff0000 alpha 0.75',
      'dispatch setprop address:0x55d2a1ff0000 alphaoverride 1',
      'dispatch setprop address:0x55d2a1ff0000 alphainactive 0.75',
      'dispatch setprop address:0x55d2a1ff0000 alphainactiveoverride 1',
      'dispatch setprop address:0x55d2a1ff0000 nofocus 1',
    ]);
  });

  it('moves to the target monitor first, never toggles pin twice, and emulates bottom layers', () => {
    const cmds = buildCommands({ ...hypr, layer: 'bottom', clickThrough: false }, '0x1', { currentMonitor: 'HDMI-A-1', currentlyPinned: true, skipChrome: true });
    expect(cmds).toEqual([
      'dispatch movewindow mon:DP-1,address:0x1',
      'dispatch resizewindowpixel exact 480 320,address:0x1',
      'dispatch movewindowpixel exact 100 200,address:0x1',
      'dispatch pin address:0x1', // was pinned, bottom wants unpinned → toggle
      'dispatch alterzorder bottom,address:0x1',
      'dispatch setprop address:0x1 alpha 0.75',
      'dispatch setprop address:0x1 alphaoverride 1',
      'dispatch setprop address:0x1 alphainactive 0.75',
      'dispatch setprop address:0x1 alphainactiveoverride 1',
      'dispatch setprop address:0x1 nofocus 0',
    ]);
    const background = buildCommands({ ...hypr, layer: 'background' }, '0x1', { currentlyPinned: true, skipChrome: true });
    expect(background).not.toContain('dispatch pin address:0x1');
    expect(background).toContain('dispatch alterzorder bottom,address:0x1');
  });

  it('supports the legacy setprop syntax and update patches', () => {
    const legacy = buildCommands({ ...hypr, opacity: 1 }, '0x2', { legacyProps: true, skipChrome: true });
    expect(legacy).toContain('setprop address:0x2 alpha 1 lock');
    expect(legacy).toContain('setprop address:0x2 alphainactive 1 lock'); // no override prop in the legacy syntax; `lock` pins it
    expect(buildUpdateCommands({ opacity: 0.5, clickThrough: false, layer: 'top' }, '0x2', { currentlyPinned: true })).toEqual([
      'dispatch alterzorder top,address:0x2',
      'dispatch setprop address:0x2 alpha 0.5',
      'dispatch setprop address:0x2 alphaoverride 1',
      'dispatch setprop address:0x2 alphainactive 0.5',
      'dispatch setprop address:0x2 alphainactiveoverride 1',
      'dispatch setprop address:0x2 nofocus 0',
    ]);
  });

  it('builds window rules and batches', () => {
    const rules = windowRuleCommands();
    expect(rules[0]).toBe('keyword windowrule float,title:^(rp-overlay:.*)$');
    expect(rules).toContain('keyword windowrule noinitialfocus,title:^(rp-overlay:.*)$');
    expect(windowRuleCommands('windowrulev2')[0]).toBe('keyword windowrulev2 float,title:^(rp-overlay:.*)$');
    expect(batch(['a', 'b'])).toBe('[[BATCH]]a;b');
    expect(isOkResponse('ok')).toBe(true);
    expect(isOkResponse('ok\nok\n')).toBe(true);
    expect(isOkResponse('Invalid dispatcher')).toBe(false);
    expect(findClient(CLIENTS, 'rp-overlay:abc-1')?.address).toBe('0x55d2a1ff0000');
    expect(hyprSocketPaths({ HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_RUNTIME_DIR: '/run/user/1000' })).toEqual({
      request: '/run/user/1000/hypr/sig/.socket.sock',
      events: '/run/user/1000/hypr/sig/.socket2.sock',
    });
    expect(hyprSocketPaths({})).toBeUndefined();
  });
});

/** Records commands and answers the JSON queries from fixtures. */
class FakeTransport implements HyprTransport {
  readonly commands: string[] = [];
  rejectDispatchSetprop = false;
  clients: HyprClientJson[] = CLIENTS;
  private listeners: Array<(event: string, data: string) => void> = [];

  subscribe(listener: (event: string, data: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Push a Hyprland event (`configreloaded`, `closewindow`, …) at the backend. */
  emit(event: string, data: string): void {
    for (const l of this.listeners) l(event, data);
  }

  async request(command: string): Promise<string> {
    this.commands.push(command);
    if (command === 'j/monitors') return JSON.stringify(MONITORS);
    if (command === 'j/clients') return JSON.stringify(this.clients);
    if (command === 'j/cursorpos') return JSON.stringify({ x: 10, y: 50 });
    if (command === 'j/version') return JSON.stringify({ branch: 'main', tag: 'v0.45.0' });
    if (this.rejectDispatchSetprop && command.startsWith('dispatch setprop ')) return 'Invalid dispatcher';
    return 'ok';
  }
}

function spec(title: string, options: OverlaySpec['options']): OverlaySpec {
  return { id: title, kind: 'image', file: '/p/a.png', assetUrl: 'rp-asset://com.x.p/a.png', packId: 'com.x.p', asset: 'a.png', options, page: {} };
}

describe('HyprlandIpcBackend', () => {
  function make(transport: FakeTransport): { backend: HyprlandIpcBackend; windows: FakeOverlayWindow[] } {
    const windows: FakeOverlayWindow[] = [];
    const backend = new HyprlandIpcBackend(
      transport,
      {
        screen: fakeScreen(),
        createWindow: (title): OverlayWindowLike => {
          // Give the window the title Hyprland reports for it in the fixture.
          const w = new FakeOverlayWindow(title);
          windows.push(w);
          return w;
        },
        platform: 'linux',
        windowSystem: 'wayland',
        contentSizeTimeoutMs: 10,
      },
      { lookupAttempts: 3, lookupDelayMs: 0, sleep: async () => undefined },
    );
    return { backend, windows };
  }

  it('reports the ipc tier and monitors from Hyprland', async () => {
    const t = new FakeTransport();
    const { backend } = make(t);
    expect(backend.info()).toMatchObject({ name: 'hyprland-ipc', windowSystem: 'wayland', supports: { layers: ['top', 'overlay'], exactPosition: true } });
    const monitors = await backend.monitors();
    expect(monitors.map((m) => m.name)).toEqual(['DP-1', 'HDMI-A-1']);
    expect(monitors[0]?.hasCursor).toBe(true);
  });

  it('registers window rules, looks the window up by title and sends the placement commands', async () => {
    const t = new FakeTransport();
    const { backend, windows } = make(t);
    const monitors = await backend.monitors();
    const opts = resolveOverlayOptions({ position: 'top-left', monitor: 'HDMI-A-1', opacity: 0.5 }, monitors, { layer: 'top' });
    // Make the fixture's client match whatever title the backend assigns.
    const original = t.request.bind(t);
    t.request = async (cmd: string) => {
      if (cmd === 'j/clients' && windows[0]) return JSON.stringify([{ ...CLIENTS[1], title: windows[0].title }]);
      return original(cmd);
    };
    const handle = await backend.createOverlay(spec('img-1', opts));
    const win = windows[0]!;
    expect(win.shown).toBe(true);
    expect(win.focusable).toBe(false);
    expect(t.commands).toContain(batch(windowRuleCommands()));
    const address = 'address:0x55d2a1ff0000';
    expect(t.commands).toContain(`dispatch setfloating ${address}`);
    expect(t.commands).toContain(`dispatch resizewindowpixel exact 480 320,${address}`); // no content-size reported → default height
    expect(t.commands).toContain(`dispatch movewindowpixel exact ${1920 + 24} 24,${address}`);
    expect(t.commands).toContain(`dispatch setprop ${address} alpha 0.5`);
    expect(t.commands).toContain(`dispatch pin ${address}`);
    // A live update only re-sends what changed and skips the chrome.
    const before = t.commands.length;
    await handle.update({ opacity: 0.2 });
    const after = t.commands.slice(before);
    expect(after).toContain(`dispatch setprop ${address} alpha 0.2`);
    expect(after).not.toContain(`dispatch setfloating ${address}`);
    expect(win.sent.at(-1)).toEqual({ type: 'update', id: 'img-1', options: { opacity: 0.2 } });
    await handle.close();
    expect(win.destroyed).toBe(true);
  });

  it('falls back to the legacy setprop syntax when the dispatcher form is rejected', async () => {
    const t = new FakeTransport();
    t.rejectDispatchSetprop = true;
    const { backend, windows } = make(t);
    const monitors = await backend.monitors();
    const original = t.request.bind(t);
    t.request = async (cmd: string) => {
      if (cmd === 'j/clients' && windows[0]) return JSON.stringify([{ ...CLIENTS[1], title: windows[0].title }]);
      return original(cmd);
    };
    await backend.createOverlay(spec('img-2', resolveOverlayOptions({ opacity: 0.4 }, monitors, { layer: 'top' })));
    expect(t.commands).toContain('setprop address:0x55d2a1ff0000 alpha 0.4 lock');
    expect(t.commands).toContain('setprop address:0x55d2a1ff0000 noborder 1');
  });

  it('switches to `eval` on a Lua-config session and places the overlay with hl.dispatch', async () => {
    const t = new FakeTransport();
    // A Lua session answers every `keyword` and legacy `dispatch` this way.
    const original = t.request.bind(t);
    const { backend, windows } = make(t);
    t.request = async (cmd: string) => {
      // monitor 0 = DP-1, so the placement has to carry the target monitor.
      if (cmd === 'j/clients' && windows[0]) return JSON.stringify([{ ...CLIENTS[1], title: windows[0].title, monitor: 0, floating: false, pinned: false }]);
      if (cmd.startsWith('keyword ') || cmd.startsWith('[[BATCH]]keyword ') || cmd.startsWith('dispatch ')) {
        t.commands.push(cmd);
        return LUA_REFUSAL;
      }
      return original(cmd);
    };
    const monitors = await backend.monitors();
    const opts = resolveOverlayOptions({ position: 'top-left', monitor: 'HDMI-A-1', opacity: 0.5, clickThrough: true }, monitors, { layer: 'overlay' });
    const handle = await backend.createOverlay(spec('img-lua', opts));

    // The rules go out as Lua, and nothing is retried with the legacy syntax.
    const evals = t.commands.filter((c) => c.startsWith('eval '));
    expect(evals.some((c) => c.includes('hl.window_rule({ name = "rp-code-overlays"'))).toBe(true);
    const placement = evals.find((c) => c.includes('hl.dsp.window.move'));
    expect(placement).toBeDefined();
    expect(placement).toContain('if x.address == "0x55d2a1ff0000" then w = x end');
    expect(placement).toContain('resize({ x = 480, y = 320, window = w })');
    expect(placement).toContain(`move({ x = ${1920 + 24}, y = 24, monitor = "HDMI-A-1", window = w })`);
    expect(placement).toContain('set_prop({ window = w, prop = "opacity", value = 0.5 })');
    expect(placement).toContain('set_prop({ window = w, prop = "no_focus", value = 1 })');
    expect(t.commands.filter((c) => c.startsWith('dispatch '))).toEqual([]);

    // A config reload drops dynamic rules, so the backend registers them again.
    const before = t.commands.length;
    t.emit('configreloaded', '');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.commands.slice(before).some((c) => c.includes('hl.window_rule'))).toBe(true);

    // Disposing takes our rules back out of the session.
    await handle.close();
    await backend.dispose();
    expect(t.commands.some((c) => c.startsWith('eval') && c.includes('__rp_overlay_rules = nil'))).toBe(true);
  });

  it('leaves placement to the compositor when the window never shows up in j/clients', async () => {
    const t = new FakeTransport();
    t.clients = [];
    const { backend, windows } = make(t);
    const monitors = await backend.monitors();
    await backend.createOverlay(spec('img-3', resolveOverlayOptions({}, monitors, { layer: 'top' })));
    expect(windows[0]?.shown).toBe(true);
    expect(t.commands.filter((c) => c === 'j/clients')).toHaveLength(3);
    expect(t.commands.some((c) => c.startsWith('dispatch movewindowpixel'))).toBe(false);
  });
});
