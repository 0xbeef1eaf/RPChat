/**
 * Service worker: keeps one WebSocket to the rpchat app on 127.0.0.1 (`ws://127.0.0.1:<port>/bridge`),
 * answers its requests through `BridgeOps`, pushes tab events, and reconnects with backoff. A
 * 30 s alarm wakes the worker so a dropped connection is retried even when Chrome has put the
 * worker to sleep. The port comes from managed policy, then `chrome.storage.local`, then the default.
 */
import { BridgeOps, HOME_PAGE_KEY } from './lib/ops.js';
import type { ChromeLike } from './lib/ops.js';
import { backoffDelay, bridgeUrl, describeBrowser, dispatch, helloMessage, parseRequest, resolvePort } from './lib/protocol.js';
import type { BridgeEvent } from './lib/protocol.js';
import { RULES_ALARM, RULES_STORAGE_KEY, readTable } from './lib/rules.js';

declare const __EXTENSION_VERSION__: string;

const ALARM = 'rpchat-bridge-keepalive';
const VERSION = typeof __EXTENSION_VERSION__ === 'string' ? __EXTENSION_VERSION__ : chrome.runtime.getManifest().version;

/** What the popup shows. */
export interface BridgeState {
  connected: boolean;
  port: number;
  managedPort: boolean;
  url: string;
  attempts: number;
  since?: string;
  lastError?: string;
  requests: number;
  version: string;
  extensionId: string;
  /** Active page blocks (rules.block) and the character's home page, for the popup. */
  blocks: number;
  homePage: string | null;
}

const ops = new BridgeOps(chrome as unknown as ChromeLike);
const handlers = ops.handlers();

let socket: WebSocket | undefined;
let connecting = false;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const state: BridgeState = { connected: false, port: 0, managedPort: false, url: '', attempts: 0, requests: 0, version: VERSION, extensionId: chrome.runtime.id, blocks: 0, homePage: null };

/** Refresh the popup facts that live in storage (block count, home page). */
async function refreshStoredState(): Promise<void> {
  try {
    const items = await chrome.storage.local.get([RULES_STORAGE_KEY, HOME_PAGE_KEY]);
    state.blocks = readTable(items[RULES_STORAGE_KEY]).rules.length;
    state.homePage = typeof items[HOME_PAGE_KEY] === 'string' ? (items[HOME_PAGE_KEY] as string) : null;
  } catch {
    /* storage unavailable */
  }
}

async function currentPort(): Promise<{ port: number; managed: boolean }> {
  // Managed policy: Linux JSON puts the values straight under the extension id, the Windows
  // registry / macOS plist layout nests them under `policy`; accept both.
  let managed: unknown;
  try {
    const all = (await chrome.storage.managed.get(null)) as { port?: unknown; policy?: { port?: unknown } };
    managed = all.port ?? all.policy?.port;
  } catch {
    managed = undefined;
  }
  let local: unknown;
  try {
    local = (await chrome.storage.local.get('port'))['port'];
  } catch {
    local = undefined;
  }
  const port = resolvePort(managed, local);
  return { port, managed: resolvePort(managed, undefined, 0) === port && port !== 0 && managed !== undefined };
}

function send(message: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = backoffDelay(attempts);
  attempts += 1;
  state.attempts = attempts;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  try {
    const { port, managed } = await currentPort();
    state.port = port;
    state.managedPort = managed;
    state.url = bridgeUrl(port);
    const ws = new WebSocket(state.url);
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      state.attempts = 0;
      state.connected = true;
      state.since = new Date().toISOString();
      delete state.lastError;
      ws.send(JSON.stringify(helloMessage({ version: VERSION, browser: describeBrowser(navigator as never), extensionId: chrome.runtime.id })));
    };
    ws.onmessage = (event) => {
      const request = parseRequest(typeof event.data === 'string' ? event.data : '');
      if (!request) return;
      state.requests += 1;
      void dispatch(request, handlers).then((response) => {
        if (socket === ws) send(response);
      });
    };
    ws.onerror = () => {
      state.lastError = `could not reach ${state.url}`;
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = undefined;
      state.connected = false;
      if (event.reason) state.lastError = event.reason;
      scheduleRetry();
    };
  } catch (err) {
    state.lastError = (err as Error).message;
    socket = undefined;
    scheduleRetry();
  } finally {
    connecting = false;
  }
}

function disconnect(reason: string): void {
  const ws = socket;
  socket = undefined;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  if (ws) {
    ws.onclose = null;
    try {
      ws.close(1000, reason);
    } catch {
      /* already closed */
    }
  }
  state.connected = false;
}

function pushEvent(event: BridgeEvent): void {
  send(event);
}

// ---- lifecycle ----------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  void ops.purgeExpired().catch(() => undefined);
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void ops.purgeExpired().catch(() => undefined);
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RULES_ALARM) {
    void ops.purgeExpired().then(() => refreshStoredState()).catch(() => undefined);
    return;
  }
  if (alarm.name === ALARM && !state.connected) {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    void connect();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[RULES_STORAGE_KEY] || changes[HOME_PAGE_KEY])) void refreshStoredState();
  if ((area === 'local' || area === 'managed') && (changes['port'] || changes['policy'])) {
    attempts = 0;
    disconnect('port changed');
    void connect();
  }
});

// ---- popup ---------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, reply: (value: unknown) => void) => {
  if (message?.type === 'status') {
    void refreshStoredState().then(() => reply({ ...state }));
    return true;
  }
  if (message?.type === 'reconnect') {
    attempts = 0;
    disconnect('reconnect requested');
    void connect().then(() => reply({ ...state }));
    return true;
  }
  return false;
});

// ---- tab events ----------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.status && !changeInfo.url && !changeInfo.title) return;
  const url = tab.url ?? tab.pendingUrl ?? '';
  if (!/^https?:/i.test(url) && !/^file:/i.test(url)) return;
  pushEvent({ event: 'tab-updated', data: { tabId, windowId: tab.windowId, url, title: tab.title ?? '', status: changeInfo.status ?? tab.status ?? '' } });
});
chrome.tabs.onActivated.addListener((info) => {
  pushEvent({ event: 'tab-activated', data: { tabId: info.tabId, windowId: info.windowId } });
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  pushEvent({ event: 'tab-removed', data: { tabId, windowId: info.windowId } });
});

// A worker that was woken for any other reason should also make sure the bridge is up.
void chrome.alarms.get(ALARM).then((existing) => {
  if (!existing) return chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  return undefined;
});
void refreshStoredState();
void ops.purgeExpired().catch(() => undefined);
void connect();
