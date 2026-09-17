import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandardRegistry, describeSurface, docSummary, generateSdkDocs, generateSdkIndex, generateSdkTypings, indexMethods, indexTypes, SDK_PREAMBLE_TYPINGS } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Virtual files live "inside" this package so `@rp/shared` resolves through node_modules when needed. */
const VDIR = path.join(here, '__virtual__');

/**
 * Compile a set of virtual files in memory (plus the real lib.es2022.d.ts and,
 * when `nodeResolution` is on, real files reachable through node_modules).
 * Returns formatted diagnostics; an empty array means a clean compile.
 */
function compile(files: Record<string, string>, opts: { nodeResolution?: boolean } = {}): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: [], // no @types/node: it would redeclare `console`
    // Real .d.ts files reachable through node_modules reference DOM/node globals (AbortSignal);
    // skip checking them in that mode. The generated sdk.d.ts itself is checked in the default mode.
    skipLibCheck: opts.nodeResolution === true,
    ...(opts.nodeResolution
      ? { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext }
      : { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }),
  };
  // TypeScript always asks for files with forward slashes; `path.join` produces backslashes on
  // Windows, so normalise both the virtual keys and every lookup (and ignore drive-letter case).
  const norm = (f: string): string => f.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  const virtual = new Map(Object.entries(files).map(([name, text]) => [norm(path.join(VDIR, name)), text]));
  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const text = virtual.get(norm(fileName));
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    return realGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
  };
  host.fileExists = (f) => virtual.has(norm(f)) || realFileExists(f);
  host.readFile = (f) => virtual.get(norm(f)) ?? realReadFile(f);
  host.writeFile = () => undefined;

  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}` : '';
    return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

/** Wrap character code the way the sandbox does: body of an async function with `sdk` in scope. */
function characterAction(code: string): string {
  return `async function __action() {\n${code}\n}\n__action;\n`;
}

describe('generateSdkTypings', () => {
  const registry = createStandardRegistry();

  it('emits the documented layout', () => {
    const out = generateSdkTypings(registry);
    expect(out.startsWith('// ---- rpchat character SDK (generated) ----\n')).toBe(true);
    expect(out).toContain(SDK_PREAMBLE_TYPINGS.trimEnd());
    expect(out).toContain('/** The SDK available to character code as the global `sdk`. */\ndeclare const sdk: Sdk;\ninterface Sdk {');
    expect(out).toContain('  /** Show images and play video/audio from the pack in an overlay window on the user\'s screen. (permission: pack) */\n  media: MediaApi;');
    expect(out).toContain('declare const console: {');
    expect(out).toContain('declare const lib: LibApi;');
    for (const spec of registry.list()) {
      expect(out).toContain(`// ---- module: ${spec.id} v${spec.version} ----\n${spec.typings.trim()}`);
    }
    // Sdk interface precedes every module banner; modules follow registration order.
    const banners = registry.list().map((s) => out.indexOf(`// ---- module: ${s.id} `));
    expect(banners.every((i) => i > out.indexOf('interface Sdk {'))).toBe(true);
    expect([...banners].sort((a, b) => a - b)).toEqual(banners);
    expect(out).not.toMatch(/^\s*(import|export)\b/m);
  });

  it('types the lib global as the lib module\'s api, and falls back when that module is not selected', () => {
    // `sdk.lib` is the `lib` object itself, so both are `LibApi`; without the module there is no LibApi.
    const withLib = generateSdkTypings(registry, { modules: ['lib'] });
    expect(withLib).toContain('  lib: LibApi;');
    expect(withLib).toContain('declare const lib: LibApi;');
    const withoutLib = generateSdkTypings(registry, { modules: ['chat'] });
    expect(withoutLib).toContain('declare const lib: { [name: string]: (...args: any[]) => any };');
    expect(withoutLib).not.toContain('LibApi');
  });

  it('compiles with zero diagnostics against lib.es2022', () => {
    expect(compile({ 'sdk.d.ts': generateSdkTypings(registry) })).toEqual([]);
  });

  it('compiles for every single-module subset and for the empty subset', () => {
    for (const spec of registry.list()) {
      expect(compile({ 'sdk.d.ts': generateSdkTypings(registry, { modules: [spec.id] }) }), spec.id).toEqual([]);
    }
    const none = generateSdkTypings(registry, { modules: [] });
    expect(none).toContain('interface Sdk {\n}');
    expect(none).not.toContain('// ---- module:');
    expect(compile({ 'sdk.d.ts': none })).toEqual([]);
  }, 60_000);

  it('filters by available modules and ignores unknown ids', () => {
    const out = generateSdkTypings(registry, { modules: ['media', 'chat', 'nope'] });
    expect(out).toContain('  chat: ChatApi;');
    expect(out).toContain('  media: MediaApi;');
    expect(out).not.toContain('system: SystemApi');
    expect(out).not.toContain('interface SystemApi');
    expect(out).toContain('// ---- module: chat ');
    expect(out).toContain('// ---- module: media ');
    expect(out.indexOf('// ---- module: chat ')).toBeLessThan(out.indexOf('// ---- module: media '));
    expect(out).not.toContain('// ---- module: system ');
  });

  it('lets realistic character code type-check', () => {
    const code = `
const info = await sdk.pack.info();
const pics = await sdk.pack.listAssets("media/images", "image");
const pick = pics[Math.floor(Math.random() * pics.length)];
if (pick) {
  const handle = await sdk.media.showImage(pick, { durationMs: 8000, position: "bottom-right", caption: info.name });
  await sdk.state.session.set("lastImage", handle.id);
}
await sdk.media.playAudio("media/audio/song.mp3", { volume: 0.4, loop: false });
const song = await sdk.state.session.get("song");
if (typeof song === "string") await sdk.media.close(song);
const timer = await sdk.timers.schedule(15 * 60 * 1000, { reason: "check on them", count: 1 }, { label: "check-in" });
const pending = await sdk.timers.list();
await sdk.timers.cancel(pending[0]?.id ?? timer.id);
const name = await sdk.state.get("user.name");
await sdk.state.set("visits", 3);
await sdk.state.set("profile", { name: typeof name === "string" ? name : null, tags: ["a", "b"] });
const all = await sdk.state.all();
const hist = await sdk.chat.history(5);
console.info("history", hist.length, hist[0]?.role, hist[0]?.at);
console.log("keys", await sdk.state.keys(), Object.keys(all));
await sdk.chat.emote("thinks for a moment");
await sdk.chat.emote("smiles");
await sdk.chat.setStatus(null);
const ok = await sdk.ui.confirm("Play it?");
const choice = await sdk.ui.choose("Which?", ["a", "b"]);
await sdk.ui.notify("Hi", choice ?? undefined);
const lore = await sdk.pack.readText("lore/backstory.md", 4096);
const res = await sdk.system.exec("date", ["+%A"], { timeoutMs: 5000 });
await sdk.system.writeFile("~/Desktop/x.txt", res.stdout + lore.length);
await sdk.system.openExternal("https://example.com");
await sdk.system.clipboardWrite(await sdk.system.readFile("~/x.txt", 100));
await sdk.media.closeAll();
const open = await sdk.media.list();
const presence = await sdk.presence.status();
const np = await sdk.presence.nowPlaying();
const look = await sdk.screen.look({ question: "what app?" });
const drawn = await sdk.screen.draw([{ type: "circle", x: 0.5, y: 0.5, radius: 40 }, { type: "text", x: 10, y: 20, text: "hi" }], { durationMs: 3000 });
await sdk.screen.clear(drawn.ids);
const cal = await sdk.calendar.upcoming(6);
const w = await sdk.web.weather("Oslo");
const feed = await sdk.web.rss("https://example.com/feed", 3);
const r2 = await sdk.web.fetch("https://example.com", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
const sub = await sdk.events.on("time", "await sdk.chat.emote('checks the clock')", { filter: { hour: 9, minute: 0 }, once: true, label: "morning" });
await sdk.events.on("custom:tea", "return input", { input: { cups: 1 } });
await sdk.events.emit("tea", { cups: 2 });
const subs = await sdk.events.list();
await sdk.events.off(subs[0]?.id ?? sub.id);
const av = await sdk.avatar.show({ expression: "happy", position: "bottom-right", size: 200, layer: "top" });
await sdk.avatar.set({ expression: "neutral" });
await sdk.avatar.say("psst", { durationMs: 2000 });
await sdk.avatar.animate("wave");
await sdk.avatar.moveTo({ monitor: "cursor", x: 0.1, y: 0.9 }, { durationMs: 500 });
const avs = await sdk.avatar.state();
const wi = await sdk.widgets.show({ id: "note", html: "<b>hi</b>", width: 200, height: 100, position: "top-left", opacity: 0.9 });
await sdk.widgets.update(wi.id, { postMessage: { n: 1 } });
await sdk.voice.speak("hello", { rate: 1.2, wait: true });
const heard = await sdk.voice.listen({ maxSeconds: 5 });
const wins = await sdk.desktop.listWindows();
await sdk.desktop.focusWindow({ id: wins[0]?.id });
await sdk.desktop.moveWindow({ app: "mpv" }, { monitor: 1, workspace: 2, width: 800 });
await sdk.desktop.launch("mpv", ["x.mp3"]);
await sdk.desktop.setVolume(40);
await sdk.files.append("diary.md", "note");
const filesList = await sdk.files.list("diary");
const mood = await sdk.mood.nudge({ mood: 0.2 }, "nice chat");
const routine = await sdk.routine.set([{ at: "23:00", state: "asleep" }, { at: "07:00", state: "available", days: [1, 2], wakePrompt: "morning" }]);
await sdk.routine.override("busy", { minutes: 10 });
const chans = await sdk.messaging.channels();
if (chans[0]?.kind === "telegram") await sdk.messaging.send(chans[0].name, "hi");
await sdk.input.type("hi"); await sdk.input.key("ctrl+s"); await sdk.input.click(1, 2, "right"); await sdk.input.moveMouse(3, 4);
const clip = await sdk.system.clipboardRead();
return { ok, shown: open.length, id: info.characterId, idle: presence.idleMs, np: np?.title, look: look.width, cal: cal.length, w: w.tempC, feed: feed.length, st: r2.status, av: av.expression, avs: avs?.visible, heard: heard.text, files: filesList.length, mood: mood.mood, routine: routine.state, clip: clip.length };`;
    expect(compile({ 'sdk.d.ts': generateSdkTypings(registry), 'action.ts': characterAction(code) })).toEqual([]);
  });

  it('rejects wrongly typed character code', () => {
    const bad = characterAction(`
await sdk.media.showImage(123);
await sdk.timers.schedule("soon", {});
await sdk.state.set("k", () => 1);
await sdk.nope.thing();
await sdk.state.session.get(1);`);
    const diags = compile({ 'sdk.d.ts': generateSdkTypings(registry), 'action.ts': bad });
    expect(diags).toHaveLength(5);
    expect(diags.every((d) => d.startsWith('action.ts:'))).toBe(true);
  });

  it('does not expose denied modules to character code', () => {
    const typings = generateSdkTypings(registry, { modules: ['chat', 'state', 'pack', 'timers'] });
    const diags = compile({ 'sdk.d.ts': typings, 'action.ts': characterAction('await sdk.system.exec("rm");') });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatch(/Property 'system' does not exist on type 'Sdk'/);
  });

  it('preamble media option types mirror @rp/shared exactly', () => {
    const check = `
import type * as S from '@rp/shared';
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? ((<T>() => T extends keyof A ? 1 : 2) extends (<T>() => T extends keyof B ? 1 : 2) ? true : false) : false) : false;
type AllTrue<T extends readonly boolean[]> = T extends readonly true[] ? true : false;
const ok: AllTrue<[
  Same<ShowImageOptions, S.ShowImageOptions>,
  Same<PlayVideoOptions, S.PlayVideoOptions>,
  Same<PlayAudioOptions, S.PlayAudioOptions>,
  Same<MediaPosition, S.MediaPosition>,
  Same<OverlayOptions, S.OverlayOptions>,
  Same<OverlayUpdate, S.OverlayUpdate>,
  Same<OverlayLayer, S.OverlayLayer>,
  Same<MonitorSelector, S.MonitorSelector>,
  Same<MonitorInfo, S.MonitorInfo>,
  Same<DisplayBackendInfo, S.DisplayBackendInfo>,
  Same<MediaHandle['kind'], S.MediaKind>,
  Same<AssetRef['kind'], S.AssetKind>,
  Same<Json, S.Json>,
  // phase 2 (docs/spec/living.md §1)
  Same<PresenceSnapshot, S.PresenceSnapshot>,
  Same<NowPlaying, S.NowPlaying>,
  Same<CalendarEvent, S.CalendarEvent>,
  Same<HostEventName, S.HostEventName>,
  Same<MoodState, S.MoodState>,
  Same<RoutineEntry, S.RoutineEntry>,
  Same<RoutineStatus, S.RoutineStatus>,
  Same<RoutineStateName, S.RoutineStateName>,
  Same<DrawShape, S.DrawShape>,
  Same<AvatarAnimation, S.AvatarAnimation>,
  Same<AvatarStateInfo, Omit<S.AvatarState, 'imageUrl'>>,
  Same<WidgetInfo, Pick<S.WidgetSpec, 'id' | 'title'>>,
  Same<Omit<EventSubscriptionInfo, 'event'>, Pick<S.EventSubscription, 'id' | 'label' | 'once' | 'fired'>>,
  Same<Awaited<ReturnType<MessagingApi['channels']>>[number]['kind'], S.MessagingChannel['kind']>,
]> = true;
void ok;
export {};
`;
    const diags = compile({ 'sdk.d.ts': generateSdkTypings(registry), 'mirror.ts': check }, { nodeResolution: true });
    expect(diags).toEqual([]);
    // and the check itself is not vacuous
    const broken = check.replace('S.PlayAudioOptions', 'S.PlayVideoOptions');
    expect(compile({ 'sdk.d.ts': generateSdkTypings(registry), 'mirror.ts': broken }, { nodeResolution: true })).toHaveLength(1);
  });
});

describe('describeSurface', () => {
  const registry = createStandardRegistry();

  it('lists modules with their method names, dotted for nested members', () => {
    const surface = describeSurface(registry);
    expect(surface.modules.map((m) => m.id)).toEqual([
      'chat', 'help', 'lib', 'state', 'pack', 'timers', 'llm', 'memory', 'display', 'media', 'ui', 'wallpaper', 'browser', 'input',
      'presence', 'screen', 'calendar', 'web', 'events', 'avatar', 'widgets', 'voice', 'desktop', 'files', 'mood', 'routine', 'messaging', 'webcam',
      'system',
    ]);
    const state = surface.modules.find((m) => m.id === 'state')!;
    expect(state.methods).toContain('session.get');
    expect(state.methods).toContain('session.all');
    expect(state.methods).toContain('get');
    expect(state.methods.every((m) => m.split('.').length <= 2)).toBe(true);
  });

  it('respects the module filter and keeps registration order', () => {
    const surface = describeSurface(registry, { modules: ['ui', 'chat', 'unknown'] });
    expect(surface.modules.map((m) => m.id)).toEqual(['chat', 'ui']);
  });

  it('respects the per-module method filter and drops a module filtered down to nothing', () => {
    const surface = describeSurface(registry, { methods: { media: ['showImage'], ui: [] } });
    expect(surface.modules.find((m) => m.id === 'media')!.methods).toEqual(['showImage']);
    expect(surface.modules.some((m) => m.id === 'ui')).toBe(false);
    // A module the map does not mention keeps all of its methods.
    expect(surface.modules.find((m) => m.id === 'chat')!.methods).toEqual(Object.keys(registry.get('chat')!.methods));
  });

  it('agrees with the generated typings and method specs', () => {
    for (const mod of describeSurface(registry).modules) {
      expect(mod.methods).toEqual(Object.keys(registry.get(mod.id)!.methods));
      for (const method of mod.methods) expect(() => registry.methodSpec(mod.id, method)).not.toThrow();
    }
  });
});

describe('per-function filtering of the prompt reference', () => {
  const registry = createStandardRegistry();

  it('indexes only the selected methods and leaves the rest unmentioned', () => {
    const index = generateSdkIndex(registry, { modules: ['media', 'chat'], methods: { media: ['showImage'] } });
    expect(index).toContain('## sdk.media —');
    expect(index).toContain('showImage');
    expect(index).not.toContain('playVideo');
    // Not "unavailable", simply absent: only what is listed exists for the character.
    expect(index).not.toContain('Not available');
    expect(index).toMatch(/^Available modules: sdk\.chat, sdk\.media\.$/m);
  });

  it('names the switched-off methods in the docs and the typings, which cannot drop them', () => {
    const docs = generateSdkDocs(registry, { modules: ['media'], methods: { media: ['showImage'] } });
    expect(docs).toContain('`media.playVideo`');
    const typings = generateSdkTypings(registry, { modules: ['media'], methods: { media: ['showImage'] } });
    expect(typings).toContain('// Not available: media.playVideo');
    expect(typings).not.toContain('// Not available: media.showImage');
  });
});

describe('generateSdkDocs', () => {
  const registry = createStandardRegistry();

  it('starts with the general section and includes every module section with its permission', () => {
    const docs = generateSdkDocs(registry);
    expect(docs.startsWith('# Acting with the SDK')).toBe(true);
    for (const rule of ['body of an async function', '`await` every', '`return`', 'one action per intention', 'busy-wait', 'sdk.timers.schedule']) {
      expect(docs).toContain(rule);
    }
    for (const spec of registry.list()) {
      expect(docs).toContain(`## sdk.${spec.id} — ${spec.title} (permission: ${spec.permission})`);
      expect(docs).toContain(spec.docs.trim());
    }
    expect(docs).not.toContain('## Not available');
    expect(docs).not.toContain('confirmation dialog');
  });

  it('filters available modules and lists denied ones', () => {
    const docs = generateSdkDocs(registry, { modules: ['chat', 'media'], deniedModules: ['system', 'ui', 'ui'] });
    expect(docs).toContain('## sdk.chat');
    expect(docs).toContain('## sdk.media');
    expect(docs).not.toContain('## sdk.system');
    expect(docs).not.toContain('## sdk.state');
    expect(docs).toContain('## Not available');
    expect(docs).toContain('`sdk.system`, `sdk.ui`.');
    expect(docs.indexOf('## Not available')).toBeGreaterThan(docs.indexOf('## sdk.media'));
  });
});

describe('generateSdkIndex', () => {
  const registry = createStandardRegistry();

  it('is smaller than the full typings + docs and lists every method once', () => {
    const index = generateSdkIndex(registry);
    const full = generateSdkTypings(registry) + generateSdkDocs(registry);
    expect(index.length).toBeLessThan(full.length); // complete TSDoc, but no raw declarations or duplicated docs
    expect(index).not.toContain('interface MediaApi');
    for (const spec of registry.list()) {
      expect(index).toContain(`## sdk.${spec.id} — ${spec.title} (${spec.permission})`);
      for (const method of Object.keys(spec.methods)) {
        const occurrences = index.split(`\n- ${method}(`).length - 1 + (index.split(`\n- ${method}<`).length - 1);
        expect(occurrences, `${spec.id}.${method}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('renders one-line signatures with the first TSDoc sentence and helper types', () => {
    const index = generateSdkIndex(registry, { modules: ['media', 'state'] });
    expect(index).toContain('- showImage(asset: AssetRef | string, options?: ShowImageOptions): Promise<MediaHandle> — Show an image asset in an overlay.');
    expect(index).toContain('- session.get(key: string): Promise<Json | undefined>');
    expect(index).toContain('ShowImageOptions extends OverlayOptions { durationMs?: number; caption?: string; closeOnClick?: boolean }');
    expect(index).toContain('## Shared types');
    expect(index).not.toContain('PresenceSnapshot'); // unreferenced shared types are dropped
    expect(index).not.toContain('## Not available'); // unavailable modules are omitted, not described
    expect(index).not.toContain('sdk.system');
    expect(index).toContain('sdk.help.module("<id>")');
    expect(index).toContain('```ts\nconst pic = await sdk.pack.asset("media/images/luna-smile.png");');
    expect(index).not.toContain('sdk.timers —');
  });

  it('index helpers handle nested groups, arrows and type aliases', () => {
    expect(indexMethods('a(x: number): Promise<void>; grp: { b(): void; c(f: (v: string) => void): Promise<number> }; readonly d?: string;')).toEqual([
      'a(x: number): Promise<void>',
      'grp.b(): void',
      'grp.c(f: (v: string) => void): Promise<number>',
    ]);
    expect(indexTypes('type Mode = "a" | "b";\n/** doc */\ninterface Opts extends Base { /** x */ x?: number; y: Mode }\ninterface Api { m(): void }', 'Api')).toEqual([
      'Mode = "a" | "b"',
      'Opts extends Base { x?: number; y: Mode }',
    ]);
    expect(docSummary('interface Api {\n  /** Does a thing. Then more. @param x y */\n  m(x: number): void;\n}', 'm')).toBe('Does a thing.');
    expect(docSummary('interface Api {\n  m(x: number): void;\n}', 'm')).toBeUndefined();
  });
});

describe('docFor', () => {
  it('extracts the summary, every @param, @returns and @example from the type definitions', async () => {
    const { docFor, createStandardRegistry, generateSdkIndex } = await import('./index.js');
    const src = `interface Api {\n  /**\n   * Do a thing.\n   * Over two lines.\n   * @param a The first\n   *   continued.\n   * @param b The second.\n   * @returns Something.\n   * @example await sdk.x.m(1, 2);\n   * @example await sdk.x.m(3, 4);\n   */\n  m(a: number, b: number): Promise<void>;\n}`;
    expect(docFor(src, 'm')).toEqual({
      summary: 'Do a thing. Over two lines.',
      params: [
        { name: 'a', text: 'The first continued.' },
        { name: 'b', text: 'The second.' },
      ],
      returns: 'Something.',
      examples: ['await sdk.x.m(1, 2);', 'await sdk.x.m(3, 4);'],
    });
    expect(docFor(src, 'missing')).toEqual({ params: [], examples: [] });
    const index = generateSdkIndex(createStandardRegistry(), { modules: ['events'] });
    expect(index).toContain('    event: A host event (see HostEventName)');
    expect(index).toContain('    e.g. await sdk.events.on("user-back"');
    expect(index).not.toMatch(/sdk\.browser|sdk\.messaging/); // unavailable modules are never named
  });
});
