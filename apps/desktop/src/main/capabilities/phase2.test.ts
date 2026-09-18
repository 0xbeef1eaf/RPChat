import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MonitorInfo } from '@rp/shared';
import { executableName, hostMatches, isAllowlisted, isLaunchAllowed } from './allowlist.js';
import { avatarPlacement, clampSize, expressionMap, fitToMonitor } from './avatar.js';
import { clampLevel, hyprFocusCommand, hyprMoveWindowCommands, hyprWorkspaceCommand, matchWindow, parseVolumeOutput, windowsFromHyprClients } from './desktop.js';
import { FilesHandler, characterHomeDir, resolveHomePath } from './files.js';
import { expandEvents, occurrences, parseDateValue, parseIcs, parseProperty, unfoldLines } from './ics.js';
import { buildMessageRequest, telegramChatsFromUpdates } from './messaging.js';
import { decodeEntities, parseFeed } from './rss.js';
import { resolveShape, validateShape } from './screen.js';

const monitors: MonitorInfo[] = [
  { id: '1', name: 'DP-1', index: 0, primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, hasCursor: true },
  { id: '2', name: 'HDMI-A-1', index: 1, primary: false, x: 1920, y: 0, width: 1280, height: 720, scale: 1, hasCursor: false },
];

describe('ICS parser', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:one',
    'SUMMARY:Dentist\\, teeth',
    'DESCRIPTION:Bring the',
    '  insurance card',
    'LOCATION:Main St',
    'DTSTART:20260910T090000Z',
    'DTEND:20260910T100000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday',
    'SUMMARY:Holiday',
    'DTSTART;VALUE=DATE:20260912',
    'DTEND;VALUE=DATE:20260913',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:daily',
    'SUMMARY:Standup',
    'DTSTART;TZID=Europe/Berlin:20260901T093000',
    'DTEND;TZID=Europe/Berlin:20260901T094500',
    'RRULE:FREQ=DAILY;COUNT=30',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly',
    'SUMMARY:Gym',
    'DTSTART:20260901T180000Z',
    'DTEND:20260901T190000Z',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T000000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('unfolds lines and parses properties with parameters', () => {
    expect(unfoldLines('A:1\r\n b\r\nC:2')).toEqual(['A:1b', 'C:2']);
    expect(parseProperty('DTSTART;TZID=Europe/Berlin:20260901T093000')).toEqual({ name: 'DTSTART', params: { TZID: 'Europe/Berlin' }, value: '20260901T093000' });
    expect(parseProperty('X;P="a:b":v')).toEqual({ name: 'X', params: { P: 'a:b' }, value: 'v' });
  });

  it('parses dates: UTC, all-day, TZID offsets (CEST = UTC+2)', () => {
    expect(parseDateValue('20260910T090000Z', {})?.date.toISOString()).toBe('2026-09-10T09:00:00.000Z');
    const allDay = parseDateValue('20260912', { VALUE: 'DATE' });
    expect(allDay?.allDay).toBe(true);
    expect(allDay?.date.getDate()).toBe(12);
    expect(parseDateValue('20260901T093000', { TZID: 'Europe/Berlin' })?.date.toISOString()).toBe('2026-09-01T07:30:00.000Z');
    expect(parseDateValue('20260115T093000', { TZID: 'Europe/Berlin' })?.date.toISOString()).toBe('2026-01-15T08:30:00.000Z');
  });

  it('parses events with escapes and expands DAILY/WEEKLY rules inside a window', () => {
    const events = parseIcs(ics);
    expect(events.map((e) => e.uid)).toEqual(['one', 'allday', 'daily', 'weekly']);
    expect(events[0]).toMatchObject({ summary: 'Dentist, teeth', description: 'Bring the insurance card', location: 'Main St', allDay: false });
    const from = new Date('2026-09-09T00:00:00Z');
    const to = new Date('2026-09-16T00:00:00Z');
    expect(occurrences(events[2]!, from, to)).toHaveLength(7); // daily, still within COUNT=30
    const weekly = occurrences(events[3]!, from, to).map((d) => d.toISOString());
    expect(weekly).toEqual(['2026-09-09T18:00:00.000Z', '2026-09-14T18:00:00.000Z']); // Wed, Mon
    expect(occurrences(events[2]!, new Date('2026-12-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'))).toHaveLength(0); // COUNT exhausted
    const expanded = expandEvents(events, 'test', from, to);
    expect(expanded[0]).toMatchObject({ title: 'Standup', calendar: 'test', allDay: false });
    expect(expanded.find((e) => e.title === 'Holiday')).toMatchObject({ allDay: true, start: '2026-09-12', end: '2026-09-13' });
    expect(expanded.find((e) => e.title === 'Dentist, teeth')?.end).toBe('2026-09-10T10:00:00.000Z');
  });
});

describe('RSS/Atom parser', () => {
  it('parses RSS items and Atom entries', () => {
    const rss = `<?xml version="1.0"?><rss><channel><title>Feed</title>
      <item><title>First &amp; best</title><link>https://a.example/1</link><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Hello <b>world</b></p>]]></description></item>
      <item><title>Second</title><guid>https://a.example/2</guid></item>
    </channel></rss>`;
    expect(parseFeed(rss)).toEqual([
      { title: 'First & best', link: 'https://a.example/1', published: '2026-09-01T10:00:00.000Z', summary: 'Hello world' },
      { title: 'Second', link: 'https://a.example/2' },
    ]);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Atom one</title><link rel="self" href="https://x/self"/><link rel="alternate" href="https://x/one"/><updated>2026-09-02T00:00:00Z</updated><summary>S</summary></entry></feed>`;
    expect(parseFeed(atom, 5)).toEqual([{ title: 'Atom one', link: 'https://x/one', published: '2026-09-02T00:00:00.000Z', summary: 'S' }]);
    expect(parseFeed(rss, 1)).toHaveLength(1);
    expect(decodeEntities('&lt;a&gt; &#169; &#x41;')).toBe('<a> © A');
  });
});

describe('allowlists', () => {
  it('matches hostnames exactly or by wildcard subdomain', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('www.example.com', 'example.com')).toBe(false);
    expect(hostMatches('www.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('evilexample.com', '*.example.com')).toBe(false);
    expect(isAllowlisted('https://api.open-meteo.com/v1/x', ['api.open-meteo.com'])).toBe(true);
    expect(isAllowlisted('ftp://api.open-meteo.com/', ['api.open-meteo.com'])).toBe(false);
    expect(isAllowlisted('not a url', ['*'])).toBe(false);
  });

  it('matches launch allowlists by executable name', () => {
    expect(executableName('/usr/bin/Firefox.exe')).toBe('firefox');
    expect(isLaunchAllowed('/usr/bin/firefox', ['firefox', 'kitty'])).toBe(true);
    expect(isLaunchAllowed('C:\\Program Files\\Notepad++\\notepad++.exe', ['notepad++'])).toBe(true);
    expect(isLaunchAllowed('rm', ['firefox'])).toBe(false);
  });
});

describe('files path guard', () => {
  let userData: string;
  beforeAll(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-files-'));
  });
  afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

  it('keeps every path inside the character home', async () => {
    const home = characterHomeDir(userData, 'com.x.p/luna');
    expect(home).toBe(path.join(userData, 'characters', 'com.x.p%2Fluna', 'home'));
    expect(resolveHomePath(home, 'notes/today.md').absolute).toBe(path.join(home, 'notes', 'today.md'));
    expect(() => resolveHomePath(home, '../secret')).toThrow(/Unsafe path/);
    expect(() => resolveHomePath(home, '/etc/passwd')).toThrow(/Unsafe path/);
    expect(() => resolveHomePath(home, 'a\\..\\b')).toThrow(/Unsafe path/);
    expect(() => resolveHomePath(home, '')).toThrow(/non-empty/);
    const handler = new FilesHandler({ userData });
    const ctx = { packId: 'com.x.p', characterId: 'luna', sessionId: 's', packRoot: '/nowhere', trigger: { kind: 'llm', actionId: 'a', messageId: 'm' } as const };
    await handler.invoke('write', ['notes/today.md', 'hello'], ctx);
    await handler.invoke('append', ['notes/today.md', ' world'], ctx);
    expect(await handler.invoke('read', ['notes/today.md'], ctx)).toBe('hello world');
    expect(await handler.invoke('list', ['notes'], ctx)).toMatchObject([{ path: 'notes/today.md', bytes: 11 }]);
    expect(await handler.invoke('delete', ['notes/today.md'], ctx)).toBe(true);
    expect(await handler.invoke('delete', ['notes/today.md'], ctx)).toBe(false);
    await expect(handler.invoke('read', ['../../x'], ctx)).rejects.toThrow(/Unsafe/);
  });
});

describe('messaging payloads', () => {
  it('builds webhook requests per channel kind', () => {
    expect(buildMessageRequest({ name: 'd', kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' }, 'hi')).toEqual({
      url: 'https://discord.com/api/webhooks/1/x',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"content":"hi"}',
    });
    expect(buildMessageRequest({ name: 's', kind: 'slack', url: 'https://hooks.slack.com/x' }, 'hi')?.body).toBe('{"text":"hi"}');
    expect(buildMessageRequest({ name: 'g', kind: 'generic-json', url: 'https://h/x' }, 'hi')?.body).toBe('{"text":"hi","channel":"g"}');
    const tg = buildMessageRequest({ name: 't', kind: 'telegram', url: 'https://api.telegram.org/botTOKEN/sendMessage?chat_id=42' }, 'hi');
    expect(tg).toEqual({ url: 'https://api.telegram.org/botTOKEN/sendMessage', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi","chat_id":"42"}' });
    expect(buildMessageRequest({ name: 'c', kind: 'command', command: { command: 'notify-send {text}' } }, 'hi')).toBeUndefined();
  });

  it('builds a telegram request from the token and chat id fields', () => {
    expect(buildMessageRequest({ name: 't', kind: 'telegram', token: '123:AA-bb_cc', chatId: '-10042' }, 'hi')).toEqual({
      url: 'https://api.telegram.org/bot123:AA-bb_cc/sendMessage',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"hi","chat_id":"-10042"}',
    });
    // A chat id field fills in for an older URL that has none, and wins over the one in its query.
    expect(buildMessageRequest({ name: 't', kind: 'telegram', url: 'https://api.telegram.org/botTOKEN/sendMessage', chatId: '@news' }, 'hi')?.body).toBe('{"text":"hi","chat_id":"@news"}');
    expect(buildMessageRequest({ name: 't', kind: 'telegram', url: 'https://api.telegram.org/botTOKEN/sendMessage?chat_id=1', chatId: '2' }, 'hi')?.body).toBe('{"text":"hi","chat_id":"2"}');
    // The token goes into the URL path, so a malformed one is refused rather than sent.
    expect(buildMessageRequest({ name: 't', kind: 'telegram', token: 'bot/../../x', chatId: '1' }, 'hi')).toBeUndefined();
  });

  it('reads the chats a telegram bot has heard from, newest first', () => {
    const chats = telegramChatsFromUpdates({
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 7, type: 'private', first_name: 'Ada', last_name: 'L' } } },
        { update_id: 2, message: { chat: { id: -100, type: 'supergroup', title: 'Lab' } } },
        { update_id: 3, edited_message: { chat: { id: 7, type: 'private', first_name: 'Ada' } } },
        { update_id: 4, channel_post: { chat: { id: 9, type: 'channel', username: 'news' } } },
      ],
    });
    expect(chats).toEqual([
      { id: '9', title: '@news', type: 'channel' },
      { id: '7', title: 'Ada', type: 'private' },
      { id: '-100', title: 'Lab', type: 'supergroup' },
    ]);
    expect(telegramChatsFromUpdates({ ok: true, result: [] })).toEqual([]);
    expect(telegramChatsFromUpdates(undefined)).toEqual([]);
  });
});

describe('desktop Hyprland builders', () => {
  it('lists, matches and moves windows', () => {
    const clients = [
      { address: '0x1', mapped: true, hidden: false, monitor: 0, class: 'kitty', title: 'zsh', workspace: { id: 1, name: '1' } },
      { address: '0X2', mapped: true, hidden: false, monitor: 1, class: 'firefox', title: 'Inbox', workspace: { id: 2, name: 'mail' } },
      { address: '0x3', mapped: false, class: 'hidden', title: 'x' },
    ];
    const mons = [{ id: 0, name: 'DP-1', width: 1, height: 1, x: 0, y: 0, scale: 1 }, { id: 1, name: 'HDMI-A-1', width: 1, height: 1, x: 0, y: 0, scale: 1 }];
    const windows = windowsFromHyprClients(clients, mons, '0x2');
    expect(windows).toEqual([
      { id: '0x1', title: 'zsh', app: 'kitty', monitor: 'DP-1', workspace: '1', focused: false },
      { id: '0x2', title: 'Inbox', app: 'firefox', monitor: 'HDMI-A-1', workspace: 'mail', focused: true },
    ]);
    expect(matchWindow(windows, { app: 'FIRE' })?.id).toBe('0x2');
    expect(matchWindow(windows, { title: 'zsh', app: 'firefox' })).toBeUndefined();
    expect(matchWindow(windows, { id: '0X1' })?.id).toBe('0x1');
    expect(hyprFocusCommand('1')).toBe('dispatch focuswindow address:0x1');
    expect(hyprMoveWindowCommands('0x2', { x: 10, y: 20, width: 800, height: 600, workspace: 3 }, 'DP-1')).toEqual([
      'dispatch movetoworkspacesilent 3,address:0x2',
      'dispatch movewindow mon:DP-1,address:0x2',
      'dispatch resizewindowpixel exact 800 600,address:0x2',
      'dispatch movewindowpixel exact 10 20,address:0x2',
    ]);
    expect(hyprWorkspaceCommand(2)).toBe('dispatch workspace 2');
    expect(hyprWorkspaceCommand('name:mail')).toBe('dispatch workspace name:mail');
    expect(() => hyprWorkspaceCommand('rm -rf /')).toThrow(/workspace/);
  });

  it('parses volume output and clamps levels', () => {
    expect(parseVolumeOutput('Volume: 0.45 [MUTED]\n')).toBe(45);
    expect(parseVolumeOutput('Volume: front-left: 29491 /  45% / -20.83 dB')).toBe(45);
    expect(parseVolumeOutput('0.8')).toBe(80);
    expect(parseVolumeOutput('nope')).toBeNull();
    expect(clampLevel(150)).toBe(100);
    expect(() => clampLevel('x')).toThrow(/level/);
  });
});

describe('avatar placement + draw shapes', () => {
  it('places the avatar bottom-right by default at its size, honouring overrides', () => {
    expect(avatarPlacement({}, 240, monitors)).toMatchObject({ monitor: monitors[0], anchor: 'bottom-right', layer: 'top', width: 240, opacity: 1, clickThrough: false });
    expect(avatarPlacement({ monitor: 'cursor', position: 'top-left', layer: 'overlay', opacity: 0.5, clickThrough: true, x: 0.5, width: 999 }, 300, monitors)).toMatchObject({
      monitor: monitors[0],
      anchor: 'top-left',
      layer: 'overlay',
      opacity: 0.5,
      clickThrough: true,
      x: 960,
      width: 300,
    });
    expect(clampSize(10)).toBe(48);
    expect(clampSize(undefined, 200)).toBe(200);
    // The avatar is drawn at exactly this width, so it may never be wider than the screen it is on.
    expect(fitToMonitor(1024, monitors[0]!)).toBe(1024);
    expect(fitToMonitor(1024, { width: 800 })).toBe(800);
    expect(avatarPlacement({ monitor: 1 }, 1024, monitors)).toMatchObject({ monitor: monitors[1], width: 1024 });
    expect(avatarPlacement({ monitor: 1 }, 1024, [{ ...monitors[1]!, width: 800 }])).toMatchObject({ width: 800 });
    const map = expressionMap({
      dir: 'characters/luna',
      definition: { id: 'luna', name: 'Luna', persona: 'p.md', avatar: 'avatar.png', avatarSet: { expressions: { happy: 'faces/happy.png', neutral: 'faces/neutral.png' }, size: 300 } },
      personaText: '',
      behaviourSources: {},
      avatarPath: 'characters/luna/avatar.png',
    });
    expect(map).toEqual({ expressions: { happy: 'characters/luna/faces/happy.png', neutral: 'characters/luna/faces/neutral.png' }, defaultExpression: 'neutral', size: 300 });
    expect(expressionMap({ dir: 'c', definition: { id: 'x', name: 'X', persona: 'p' }, personaText: '', behaviourSources: {}, avatarPath: 'c/a.png' })).toEqual({
      expressions: { neutral: 'c/a.png' },
      defaultExpression: 'neutral',
      size: 240,
    });
  });

  it('validates and resolves draw shapes', () => {
    const shape = validateShape({ type: 'arrow', x: 0.5, y: 0.25, x2: 100, y2: 50, color: '#f00', text: 'here', durationMs: 1000, bogus: 1 });
    expect(shape).toEqual({ type: 'arrow', x: 0.5, y: 0.25, x2: 100, y2: 50, color: '#f00', text: 'here', durationMs: 1000 });
    expect(resolveShape(shape, monitors[0]!)).toMatchObject({ x: 960, y: 270, x2: 100, y2: 50 });
    expect(() => validateShape({ type: 'blob', x: 0, y: 0 })).toThrow(/shape.type/);
    expect(validateShape({ type: 'text', x: 1, y: 1, color: 'javascript:alert(1)' }).color).toBeUndefined();
  });
});
