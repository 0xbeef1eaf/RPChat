/**
 * Console logger for the main process; `debug` only prints when `RP_DEBUG` is set.
 *
 * A packaged app has nowhere to print: launched from a desktop entry its stdout and stderr are
 * `/dev/null`, so every `[media] … failed` and every backend warning was lost exactly when someone
 * needed it. `toFile` therefore mirrors the same lines into `<userData>/logs/main.log`, kept to two
 * files of `LOG_MAX_BYTES` so it can never grow without bound. Writes are synchronous appends: the
 * volume is a line here and there, and a log that survives a crash is the point of having one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { format } from 'node:util';
import type { Logger } from '@rp/core';

export const LOG_DIRNAME = 'logs';
export const LOG_FILENAME = 'main.log';
/** Rotated at this size, with one previous file kept (`main.log.1`). */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface MainLogger extends Logger {
  /**
   * Start copying every line into `<dir>/logs/main.log`. Called once the userData path is settled;
   * a directory that cannot be created leaves the logger console-only rather than failing startup.
   */
  toFile(dir: string): void;
}

/** The lines a level writes, given `RP_DEBUG`. */
function enabled(level: 'debug' | 'info' | 'warn' | 'error', debug: boolean): boolean {
  return level !== 'debug' || debug;
}

class FileSink {
  private file: string;
  private bytes: number;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, LOG_FILENAME);
    this.bytes = statSize(this.file);
  }

  write(line: string): void {
    const data = `${line}\n`;
    try {
      if (this.bytes + data.length > LOG_MAX_BYTES) this.rotate();
      fs.appendFileSync(this.file, data);
      this.bytes += data.length;
    } catch {
      /* a log that cannot be written must not take the app down with it */
    }
  }

  private rotate(): void {
    try {
      fs.rmSync(`${this.file}.1`, { force: true });
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* first run, or the file is gone: start counting again either way */
    }
    this.bytes = 0;
  }
}

function statSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function createLogger(env: NodeJS.ProcessEnv = process.env): MainLogger {
  const debug = env.RP_DEBUG === '1' || env.RP_DEBUG === 'true';
  const stamp = (): string => new Date().toISOString().slice(11, 23);
  let sink: FileSink | undefined;
  const emit = (level: 'debug' | 'info' | 'warn' | 'error', args: unknown[]): void => {
    if (!enabled(level, debug)) return;
    console[level](stamp(), ...args);
    sink?.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}`);
  };
  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    toFile(dir: string) {
      try {
        sink = new FileSink(path.join(dir, LOG_DIRNAME));
      } catch {
        sink = undefined;
      }
    },
  };
}
