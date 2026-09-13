/** Popup / options page: connection state from the worker, the port, reconnect. */
import { resolvePort } from './lib/protocol.js';
import type { BridgeState } from './background.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function render(state: BridgeState | undefined): void {
  const dot = el('dot');
  dot.classList.toggle('on', Boolean(state?.connected));
  el('state').textContent = !state ? 'worker not responding' : state.connected ? `connected since ${state.since ? new Date(state.since).toLocaleTimeString() : 'now'}` : `not connected (attempt ${state.attempts})`;
  el('url').textContent = state?.url ?? '';
  el('id').textContent = state?.extensionId ?? chrome.runtime.id;
  el('version').textContent = state?.version ?? chrome.runtime.getManifest().version;
  el('requests').textContent = String(state?.requests ?? 0);
  el('error').textContent = state?.lastError ?? '—';
  el('blocks').textContent = state ? `${state.blocks} active${state.blocks > 0 ? ' (managed by the app; Settings → Browser clears them)' : ''}` : '—';
  el('home').textContent = state?.homePage ?? 'not set';
  const port = el<HTMLInputElement>('port');
  if (state && document.activeElement !== port) port.value = String(state.port);
  port.disabled = Boolean(state?.managedPort);
  el<HTMLButtonElement>('save').disabled = Boolean(state?.managedPort);
  el('managed').hidden = !state?.managedPort;
}

async function status(): Promise<BridgeState | undefined> {
  try {
    return (await chrome.runtime.sendMessage({ type: 'status' })) as BridgeState;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  render(await status());
  el('save').addEventListener('click', () => {
    const port = resolvePort(undefined, Number(el<HTMLInputElement>('port').value), 0);
    if (port === 0) {
      el('error').textContent = 'port must be 1..65535';
      return;
    }
    void chrome.storage.local.set({ port }).then(() => setTimeout(() => void status().then(render), 500));
  });
  el('reconnect').addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'reconnect' }).then((s) => render(s as BridgeState)).catch(() => render(undefined));
  });
  setInterval(() => void status().then(render), 2000);
}

void main();
