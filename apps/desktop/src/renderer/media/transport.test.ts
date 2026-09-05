import { describe, expect, it, vi } from 'vitest';
import type { MediaCommand, MediaWindowEvent } from '@rp/shared';
import { createHelperTransport, decodeBase64Url, detectTransportMode, parseCommandJson, parseHashCommand, type HelperEnv } from './transport';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

const show: MediaCommand = {
  type: 'show-image',
  id: 'img-1',
  url: 'http://127.0.0.1:4321/t/abc/asset/com.example.pack/media/a.png',
  options: { caption: 'héllo ✨', width: 300 },
};

function fakeEnv(hash = ''): HelperEnv & { hook: ((json: string) => void) | undefined; posted: string[] } {
  const env = {
    hash,
    hook: undefined as ((json: string) => void) | undefined,
    posted: [] as string[],
    setCommandHook(h: ((json: string) => void) | undefined) {
      env.hook = h;
    },
    postMessage: (json: string) => {
      env.posted.push(json);
    },
  };
  return env;
}

describe('base64url + hash parsing', () => {
  it('decodes base64url with and without padding, including unicode', () => {
    const text = '{"a":"héllo ✨"}';
    const encoded = Buffer.from(text, 'utf8').toString('base64url');
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(encoded)).toBe(text);
    expect(decodeBase64Url(`${encoded}==`)).toBe(text);
  });

  it('parseHashCommand reads #cmd= and tolerates other params', () => {
    expect(parseHashCommand(`#cmd=${b64url(show)}`)).toEqual(show);
    expect(parseHashCommand(`#x=1&cmd=${b64url({ type: 'close-all' })}`)).toEqual({ type: 'close-all' });
  });

  it('parseHashCommand returns null for missing, malformed or unknown commands', () => {
    expect(parseHashCommand('')).toBeNull();
    expect(parseHashCommand('#foo=bar')).toBeNull();
    expect(parseHashCommand('#cmd=!!!')).toBeNull();
    expect(parseHashCommand(`#cmd=${b64url({ type: 'nuke-it', id: 'x' })}`)).toBeNull();
    expect(parseHashCommand(`#cmd=${b64url({ type: 'show-image', id: 'x' })}`)).toBeNull(); // no url
    expect(parseHashCommand(`#cmd=${b64url({ type: 'close' })}`)).toBeNull(); // no id
    expect(parseHashCommand(`#cmd=${Buffer.from('not json').toString('base64url')}`)).toBeNull();
  });

  it('parseCommandJson accepts every command type with its required fields', () => {
    expect(parseCommandJson(JSON.stringify({ type: 'update', id: 'a', options: { opacity: 0.5 } }))).toEqual({ type: 'update', id: 'a', options: { opacity: 0.5 } });
    expect(parseCommandJson(JSON.stringify({ type: 'update', id: 'a' }))).toBeNull();
    expect(parseCommandJson(JSON.stringify({ type: 'close', id: 'a' }))).toEqual({ type: 'close', id: 'a' });
    expect(parseCommandJson(JSON.stringify({ type: 'avatar-show', id: 'a', state: { imageUrl: 'x' } }))?.type).toBe('avatar-show');
    expect(parseCommandJson(JSON.stringify({ type: 'avatar-show', id: 'a', state: {} }))).toBeNull();
    expect(parseCommandJson(JSON.stringify({ type: 'avatar-set', id: 'a', patch: { expression: 'sad' } }))?.type).toBe('avatar-set');
    expect(parseCommandJson(JSON.stringify({ type: 'avatar-hide', id: 'a' }))?.type).toBe('avatar-hide');
    expect(parseCommandJson(JSON.stringify({ type: 'widget-show', id: 'w', widget: { html: '<p/>' }, options: {} }))?.type).toBe('widget-show');
    expect(parseCommandJson(JSON.stringify({ type: 'widget-show', id: 'w', widget: {} }))).toBeNull();
    expect(parseCommandJson(JSON.stringify({ type: 'widget-update', id: 'w', title: 't' }))?.type).toBe('widget-update');
    expect(parseCommandJson(JSON.stringify({ type: 'draw-set', id: 'd', shapes: [] }))?.type).toBe('draw-set');
    expect(parseCommandJson(JSON.stringify({ type: 'draw-set', id: 'd', shapes: 'no' }))).toBeNull();
    expect(parseCommandJson(JSON.stringify({ type: 'draw-clear', id: 'd' }))?.type).toBe('draw-clear');
    expect(parseCommandJson('null')).toBeNull();
    expect(parseCommandJson('[]')).toBeNull();
  });
});

describe('helper transport', () => {
  it('installs the global hook immediately and replays the hash command first', () => {
    const env = fakeEnv(`#cmd=${b64url(show)}`);
    const transport = createHelperTransport(env);
    expect(env.hook).toBeTypeOf('function');
    // command issued before React subscribed
    env.hook!(JSON.stringify({ type: 'update', id: 'img-1', options: { opacity: 0.4 } }));

    const received: MediaCommand[] = [];
    transport.onCommand((c) => received.push(c));
    expect(received).toEqual([show, { type: 'update', id: 'img-1', options: { opacity: 0.4 } }]);

    env.hook!(JSON.stringify({ type: 'close', id: 'img-1' }));
    expect(received).toHaveLength(3);
    expect(received[2]).toEqual({ type: 'close', id: 'img-1' });
  });

  it('ignores malformed hook payloads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = fakeEnv();
    const transport = createHelperTransport(env);
    const received: MediaCommand[] = [];
    transport.onCommand((c) => received.push(c));
    env.hook!('{oops');
    env.hook!(JSON.stringify({ type: 'bogus' }));
    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('unsubscribe stops delivery and later commands are buffered for the next listener', () => {
    const env = fakeEnv();
    const transport = createHelperTransport(env);
    const first: MediaCommand[] = [];
    const off = transport.onCommand((c) => first.push(c));
    off();
    env.hook!(JSON.stringify({ type: 'close-all' }));
    expect(first).toEqual([]);
    const second: MediaCommand[] = [];
    transport.onCommand((c) => second.push(c));
    expect(second).toEqual([{ type: 'close-all' }]);
  });

  it('report posts the JSON-serialised event to the webkit handler', () => {
    const env = fakeEnv();
    const transport = createHelperTransport(env);
    const ev: MediaWindowEvent = { type: 'content-size', id: 'img-1', width: 320, height: 200 };
    transport.report(ev);
    transport.report({ type: 'closed', id: 'img-1' });
    expect(env.posted.map((p) => JSON.parse(p))).toEqual([ev, { type: 'closed', id: 'img-1' }]);
  });

  it('report without a message handler does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = fakeEnv();
    env.postMessage = undefined;
    const transport = createHelperTransport(env);
    expect(() => transport.report({ type: 'closed', id: 'x' })).not.toThrow();
    warn.mockRestore();
  });
});

describe('detectTransportMode', () => {
  it('prefers Electron when window.rp exists, helper otherwise', () => {
    expect(detectTransportMode({ rp: {} })).toBe('electron');
    expect(detectTransportMode({ __rpHelper: true })).toBe('helper');
    expect(detectTransportMode({})).toBe('helper');
  });
});
