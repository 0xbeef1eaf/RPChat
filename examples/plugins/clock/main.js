// Example rpchat plugin: the `clock` module. Plain ESM, no dependencies.
// Loaded by the app's main process; `activate(host)` returns one handler per module.

const MAX_SECONDS = 24 * 60 * 60;

/**
 * @param {import('@rp/shared').PluginHost} host
 * @returns {Promise<import('@rp/shared').PluginActivation>}
 */
export async function activate(host) {
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();

  /** Fire a countdown: raise `custom:countdown` and forget it. */
  async function fire(id) {
    timers.delete(id);
    const pending = (await host.storage.get('pending')) ?? {};
    const entry = pending[id];
    if (!entry) return;
    delete pending[id];
    await host.storage.set('pending', pending);
    host.log.info(`countdown ${id} (${entry.label ?? 'no label'}) finished`);
    host.emitEvent('countdown', { id, label: entry.label ?? null, seconds: entry.seconds });
  }

  /** Arm (or immediately fire) a stored countdown. */
  function arm(id, endsAt) {
    const delay = Math.max(0, new Date(endsAt).getTime() - Date.now());
    const timer = setTimeout(() => void fire(id), delay);
    timer.unref?.();
    timers.set(id, timer);
  }

  // Re-arm countdowns that were pending when the app last quit.
  const stored = (await host.storage.get('pending')) ?? {};
  for (const [id, entry] of Object.entries(stored)) arm(id, entry.endsAt);

  /** @type {import('@rp/shared').CapabilityHandler} */
  const clock = {
    moduleId: 'clock',
    async invoke(method, args) {
      switch (method) {
        case 'now': {
          const d = new Date();
          return {
            iso: isoWithOffset(d),
            local: d.toLocaleString(),
            weekday: d.toLocaleDateString(undefined, { weekday: 'long' }),
            unix: Math.floor(d.getTime() / 1000),
          };
        }
        case 'countdown': {
          const secondsArg = Number(args[0]);
          if (!Number.isFinite(secondsArg) || secondsArg < 1) throw new Error('seconds must be a number ≥ 1');
          const seconds = Math.min(MAX_SECONDS, Math.round(secondsArg));
          const label = typeof args[1] === 'string' && args[1].trim() ? args[1].trim().slice(0, 80) : undefined;
          const id = `cd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
          const pending = (await host.storage.get('pending')) ?? {};
          pending[id] = { endsAt, seconds, ...(label ? { label } : {}) };
          await host.storage.set('pending', pending);
          arm(id, endsAt);
          return { id, endsAt };
        }
        case 'pending': {
          const pending = (await host.storage.get('pending')) ?? {};
          return Object.entries(pending).map(([id, e]) => ({ id, endsAt: e.endsAt, ...(e.label ? { label: e.label } : {}) }));
        }
        default:
          throw new Error(`unknown method clock.${method}`);
      }
    },
  };

  return {
    handlers: { clock },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

/** `2026-09-07T10:15:00+02:00` (Date#toISOString is always UTC). */
function isoWithOffset(d) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  );
}
