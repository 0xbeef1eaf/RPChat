/** Console logger for the main process; `debug` only prints when `RP_DEBUG` is set. */
import type { Logger } from '@rp/core';

export function createLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const debug = env.RP_DEBUG === '1' || env.RP_DEBUG === 'true';
  const stamp = (): string => new Date().toISOString().slice(11, 23);
  return {
    debug: (...args: unknown[]) => {
      if (debug) console.debug(stamp(), ...args);
    },
    info: (...args: unknown[]) => console.info(stamp(), ...args),
    warn: (...args: unknown[]) => console.warn(stamp(), ...args),
    error: (...args: unknown[]) => console.error(stamp(), ...args),
  };
}
