import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OverlaySpec } from './backend.js';
import { resolveOverlayOptions } from './backend.js';
import { HelperBackend, commandScript, helperPlacement, mergeMonitorNames, pageCommand } from './helper-backend.js';
import type { HelperChildLike } from './helper-process.js';
import { HelperProcess, findHelperBinary } from './helper-process.js';
import { decodeCommandHash, rewriteAssetUrl } from '../loopback.js';

/** An in-process fake of the Rust helper speaking the JSON-lines protocol. */
class FakeHelperChild extends EventEmitter implements HelperChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<Record<string, unknown>> = [];
  pid = 4321;
  killed = false;

  constructor(private readonly opts: { helloFails?: boolean } = {}) {
    super();
    let buf = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        this.handle(JSON.parse(line) as Record<string, unknown>);
        idx = buf.indexOf('\n');
      }
    });
  }

  emitEvent(ev: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(ev)}\n`);
  }

  private handle(req: Record<string, unknown>): void {
    this.received.push(req);
    const seq = req.seq;
    switch (req.op) {
      case 'hello':
        if (this.opts.helloFails) this.emitEvent({ ev: 'error', seq, message: 'no display' });
        else this.emitEvent({ ev: 'ready', seq, version: 1, features: { layers: ['background', 'bottom', 'top', 'overlay'], opacity: true, clickThrough: true, exactPosition: true, video: true } });
        return;
      case 'monitors':
        this.emitEvent({ ev: 'monitors', seq, monitors: [{ id: '0', name: 'Monitor 1', index: 0, primary: true, x: 0, y: 40, width: 1920, height: 1040, scale: 2, hasCursor: true }] });
        return;
      case 'show':
        this.emitEvent({ ev: 'shown', seq, id: req.id });
        return;
      case 'update':
        this.emitEvent({ ev: 'updated', seq, id: req.id });
        return;
      case 'js':
        this.emitEvent({ ev: 'js-done', seq, id: req.id });
        return;
      case 'close':
        this.emitEvent({ ev: 'closed', seq, id: req.id });
        return;
      case 'closeAll':
        this.emitEvent({ ev: 'closed', id: 'x' });
        this.emitEvent({ ev: 'ok', seq });
        return;
      case 'hang':
        return; // never answers
      case 'quit':
        this.emitEvent({ ev: 'bye', seq });
        setImmediate(() => this.emit('exit', 0, null));
        return;
      default:
        this.emitEvent({ ev: 'error', seq, message: `unknown op ${String(req.op)}` });
    }
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function makeHelper(opts: { helloFails?: boolean } = {}) {
  const children: FakeHelperChild[] = [];
  const helper = new HelperProcess({
    binary: '/fake/rp-overlay-wlr',
    spawnImpl: () => {
      const child = new FakeHelperChild(opts);
      children.push(child);
      return child;
    },
    helloTimeoutMs: 500,
    requestTimeoutMs: 500,
    restartBackoffMs: [0],
  });
  return { helper, children };
}

describe('HelperProcess', () => {
  it('spawns, handshakes and matches replies by seq', async () => {
    const { helper, children } = makeHelper();
    const ready = await helper.start();
    expect(ready).toMatchObject({ ev: 'ready', version: 1 });
    expect(children[0]?.received[0]).toMatchObject({ op: 'hello', version: 1, seq: 1 });
    const monitors = await helper.monitors();
    expect(monitors[0]).toMatchObject({ name: 'Monitor 1', width: 1920 });
    await expect(helper.request('bogus')).rejects.toThrow(/unknown op bogus/);
    const messages: unknown[] = [];
    helper.on('message', (ev) => messages.push(ev));
    children[0]?.emitEvent({ ev: 'message', id: 'img', payload: { type: 'ended', id: 'img' } });
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([{ ev: 'message', id: 'img', payload: { type: 'ended', id: 'img' } }]);
    await helper.dispose();
    expect(children[0]?.received.at(-1)).toMatchObject({ op: 'quit' });
  });

  it('rejects when hello fails, and restarts after a crash', async () => {
    const failing = makeHelper({ helloFails: true });
    await expect(failing.helper.start()).rejects.toThrow(/no display/);

    const { helper, children } = makeHelper();
    await helper.start();
    const exits: unknown[] = [];
    helper.on('exit', (e) => exits.push(e));
    const pending = helper.request('hang');
    children[0]?.emit('exit', 1, null);
    await expect(pending).rejects.toThrow(/exited/);
    await expect(helper.request('monitors')).rejects.toThrow(/not running/);
    expect(exits).toHaveLength(1);
    expect(helper.isRunning).toBe(false);
    await helper.start();
    expect(children).toHaveLength(2);
    expect(helper.isRunning).toBe(true);
    await helper.dispose();
  });

  it('turns an EPIPE from a helper that died at spawn into a rejection, not an uncaught error', async () => {
    // The real failure: the helper exits as it starts, the `hello` write reaches a closed pipe
    // and libuv reports EPIPE a tick later. Node hands that to the write callback *and* emits
    // `error` on the pipe; with nobody listening it became an uncaught exception in Electron's
    // main process ("A JavaScript error occurred in the main process").
    class DeadPipeChild extends EventEmitter implements HelperChildLike {
      readonly stdin = new Writable({
        write(_chunk, _enc, cb) {
          setImmediate(() => cb(new Error('write EPIPE')));
        },
      });
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      pid = 4322;
      killed = false;
      constructor() {
        super();
        // What the dynamic loader prints when a runtime library is missing.
        this.stderr.write('rp-overlay-wlr: error while loading shared libraries: libgtk-layer-shell.so.0\n');
      }
      kill(): boolean {
        this.killed = true;
        return true;
      }
    }
    const children: DeadPipeChild[] = [];
    const helper = new HelperProcess({
      binary: '/fake/rp-overlay-wlr',
      spawnImpl: () => {
        const child = new DeadPipeChild();
        children.push(child);
        return child;
      },
      helloTimeoutMs: 500,
      requestTimeoutMs: 500,
      restartBackoffMs: [0],
    });
    // The reason the caller logs before falling back names the real cause, not just EPIPE.
    await expect(helper.start()).rejects.toThrow(/EPIPE.*libgtk-layer-shell\.so\.0/);
    expect(helper.isRunning).toBe(false);
    await expect(helper.request('monitors')).rejects.toThrow(/not running/);
    // Still restartable: the pipe error goes through the same path as an unexpected exit.
    await expect(helper.start()).rejects.toThrow(/EPIPE/);
    expect(children).toHaveLength(2);
    await helper.dispose();
  });

  it('finds the binary via env, resources or PATH', () => {
    const exists = (f: string) => f === '/res/bin/rp-overlay-wlr' || f === '/opt/helper';
    expect(findHelperBinary({ env: { RP_OVERLAY_HELPER: '/opt/helper' }, resourcesDirs: ['/res'], exists, onPath: () => false })).toBe('/opt/helper');
    expect(findHelperBinary({ env: {}, resourcesDirs: ['/nope', '/res'], exists, onPath: () => false })).toBe('/res/bin/rp-overlay-wlr');
    expect(findHelperBinary({ env: {}, resourcesDirs: [], exists, onPath: (n) => n === 'rp-overlay-wlr' })).toBe('rp-overlay-wlr');
    expect(findHelperBinary({ env: {}, resourcesDirs: [], exists: () => false, onPath: () => false })).toBeUndefined();
  });
});

describe('HelperBackend', () => {
  const loopback = {
    baseUrl: 'http://127.0.0.1:1234/t/tok',
    rewriteAssetUrl: (url: string) => rewriteAssetUrl(url, 'http://127.0.0.1:1234/t/tok'),
    mediaPageUrl: (cmd: unknown) => `http://127.0.0.1:1234/t/tok/media.html#cmd=${Buffer.from(JSON.stringify(cmd)).toString('base64url')}`,
  };

  it('shows overlays through the helper with loopback URLs and routes page messages', async () => {
    const { helper, children } = makeHelper();
    const ready = await helper.start();
    const backend = new HelperBackend({ helper, loopback, ready, hypr: { request: async (c) => (c === 'j/monitors' ? JSON.stringify([{ id: 0, name: 'DP-1', width: 3840, height: 2160, x: 0, y: 0, scale: 2, reserved: [0, 40, 0, 0] }]) : 'ok') } });
    expect(backend.info()).toMatchObject({ name: 'hyprland', supports: { layers: ['background', 'bottom', 'top', 'overlay'], exactPosition: true } });
    const monitors = await backend.monitors();
    expect(monitors[0]?.name).toBe('DP-1'); // generic helper name replaced by the Hyprland connector (geometry match)
    const options = resolveOverlayOptions({ layer: 'background', position: 'top-right', opacity: 0.6, clickThrough: true, x: 0.5 }, monitors, { layer: 'top' });
    const spec: OverlaySpec = { id: 'ov-1', kind: 'video', file: '/p/v.mp4', assetUrl: 'rp-asset://com.x.p/media/v.mp4', packId: 'com.x.p', asset: 'media/v.mp4', options, page: { loop: true } };
    const handle = await backend.createOverlay(spec);
    const show = children[0]?.received.find((r) => r.op === 'show');
    expect(show).toMatchObject({ id: 'ov-1', layer: 'background', anchor: 'top-right', marginPx: 24, x: 960, opacity: 0.6, clickThrough: true, width: 480, monitor: { index: 0, name: 'DP-1' } });
    const url = String(show?.url);
    expect(url.startsWith('http://127.0.0.1:1234/t/tok/media.html#cmd=')).toBe(true);
    expect(decodeCommandHash(url.slice(url.indexOf('#')))).toEqual({
      type: 'play-video',
      id: 'ov-1',
      url: 'http://127.0.0.1:1234/t/tok/asset/com.x.p/media/v.mp4',
      options: { loop: true, opacity: 0.6, clickThrough: true, width: 480, layer: 'background' },
    });
    const events: string[] = [];
    handle.on('ended', () => events.push('ended'));
    handle.on('closed', () => events.push('closed'));
    await handle.update({ opacity: 0.1, layer: 'top' });
    expect(children[0]?.received.at(-2)).toMatchObject({ op: 'update', id: 'ov-1', patch: { opacity: 0.1, layer: 'top' } });
    expect(children[0]?.received.at(-1)).toMatchObject({ op: 'js', id: 'ov-1' });
    expect(String(children[0]?.received.at(-1)?.script)).toContain('__rpMediaCommand');
    children[0]?.emitEvent({ ev: 'message', id: 'ov-1', payload: { type: 'ended', id: 'ov-1' } });
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(['ended']);
    await handle.close();
    expect(events).toEqual(['ended', 'closed']);
    await backend.dispose();
  });

  it('rewrites the expression frame of a later avatar-set, not just the first image', async () => {
    const { helper, children } = makeHelper();
    const ready = await helper.start();
    const backend = new HelperBackend({ helper, loopback, ready });
    const monitors = await backend.monitors();
    const options = resolveOverlayOptions({ position: 'bottom-right' }, monitors, { layer: 'top' });
    const spec: OverlaySpec = {
      id: 'av-1',
      kind: 'avatar',
      file: '/p/characters/c/expressions/neutral.png',
      assetUrl: 'rp-asset://com.x.p/characters/c/expressions/neutral.png',
      packId: 'com.x.p',
      asset: 'characters/c/expressions/neutral.png',
      options,
      page: {},
      avatar: {
        visible: true,
        expression: 'neutral',
        imageUrl: 'rp-asset://com.x.p/characters/c/expressions/neutral.png',
        size: 220,
        lookAtCursor: false,
        overlay: { layer: 'top', opacity: 1, clickThrough: false },
      },
    };
    const handle = await backend.createOverlay(spec);
    // WebKit has no `rp-asset://` scheme: an unrewritten swap leaves the page with a broken image.
    await handle.send({ type: 'avatar-set', id: 'av-1', patch: { expression: 'smile', imageUrl: 'rp-asset://com.x.p/characters/c/expressions/smile.png' } });
    const script = String(children[0]?.received.at(-1)?.script);
    expect(script).toContain('http://127.0.0.1:1234/t/tok/asset/com.x.p/characters/c/expressions/smile.png');
    expect(script).not.toContain('rp-asset://');
    await backend.dispose();
  });

  it('pure helpers: placement payload, command script, monitor name merge', () => {
    expect(helperPlacement({ monitor: { id: '0', name: 'M', index: 0, primary: true, x: 0, y: 0, width: 10, height: 10, scale: 1, hasCursor: false }, layer: 'top', opacity: 1, clickThrough: false, anchor: 'center', marginPx: 8, width: 300, height: 200, y: 5 })).toEqual({
      layer: 'top', anchor: 'center', marginPx: 8, monitor: { index: 0, name: 'M', x: 0, y: 0 }, width: 300, height: 200, opacity: 1, clickThrough: false, y: 5,
    });
    expect(commandScript({ type: 'close-all' })).toBe(`(function(){try{if(typeof window.__rpMediaCommand==='function'){window.__rpMediaCommand("{\\"type\\":\\"close-all\\"}");}}catch(e){}})();`);
    const rewrite = (url: string) => rewriteAssetUrl(url, 'http://127.0.0.1:1234/t/tok');
    expect(pageCommand({ type: 'avatar-set', id: 'a', patch: { expression: 'smile', imageUrl: 'rp-asset://com.x.p/c/smile.png' } }, rewrite)).toEqual({
      type: 'avatar-set', id: 'a', patch: { expression: 'smile', imageUrl: 'http://127.0.0.1:1234/t/tok/asset/com.x.p/c/smile.png' },
    });
    // Commands with no URL (and patches that only move/animate) are passed through untouched.
    const animate = { type: 'avatar-set', id: 'a', patch: { animation: 'nod' } } as const;
    expect(pageCommand(animate, rewrite)).toBe(animate);
    expect(pageCommand({ type: 'show-image', id: 'm', url: 'rp-asset://com.x.p/media/i.png', options: {} }, rewrite)).toMatchObject({ url: 'http://127.0.0.1:1234/t/tok/asset/com.x.p/media/i.png' });
    const merged = mergeMonitorNames(
      [{ id: '0', name: '0', index: 0, primary: true, x: 0, y: 0, width: 100, height: 100, scale: 1, hasCursor: false }],
      [{ id: '9', name: 'DP-3', index: 0, primary: true, x: 0, y: 0, width: 100, height: 100, scale: 1, hasCursor: false }],
    );
    expect(merged[0]?.name).toBe('DP-3');
  });
});
