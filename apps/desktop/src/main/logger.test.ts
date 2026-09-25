/** The main logger's file sink: what it writes, what it gates on `RP_DEBUG`, and how it rotates. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_DIRNAME, LOG_FILENAME, LOG_MAX_BYTES, createLogger } from './logger.js';

let dir: string;
const logFile = (): string => path.join(dir, LOG_DIRNAME, LOG_FILENAME);
const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-logger-'));
  for (const level of ['debug', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createLogger', () => {
  it('writes nothing until toFile, then mirrors every line into the log file', () => {
    const logger = createLogger({});
    logger.info('[media] before');
    expect(fs.existsSync(logFile())).toBe(false);

    logger.toFile(dir);
    logger.info('[media] video home:clip.mp4 failed:', new Error('web process terminated'));
    logger.warn('[display] helper gone');

    const written = read(logFile());
    expect(written).toContain('INFO  [media] video home:clip.mp4 failed:');
    expect(written).toContain('web process terminated');
    expect(written).toContain('WARN  [display] helper gone');
    expect(written).not.toContain('before');
    // One entry per call, each stamped with a full ISO date (the file outlives a day). An entry may
    // run over several lines: an Error is written with its stack, which is the point of logging it.
    const entries = written.trimEnd().split('\n').filter((line) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /.test(line));
    expect(entries).toHaveLength(2);
    expect(written).toContain('at ');
  });

  it('keeps debug out of the file unless RP_DEBUG is set', () => {
    const quiet = createLogger({});
    quiet.toFile(dir);
    quiet.debug('[helper] chatty');
    expect(read(logFile())).toBe('');

    const loud = createLogger({ RP_DEBUG: '1' });
    loud.toFile(dir);
    loud.debug('[helper] chatty');
    expect(read(logFile())).toContain('DEBUG [helper] chatty');
  });

  it('rotates at the cap, keeping exactly one previous file', () => {
    const logger = createLogger({});
    logger.toFile(dir);
    const line = 'x'.repeat(4096);
    for (let i = 0; i < Math.ceil((LOG_MAX_BYTES * 2) / 4096) + 2; i++) logger.info(line);

    const current = fs.statSync(logFile()).size;
    expect(current).toBeLessThanOrEqual(LOG_MAX_BYTES);
    expect(fs.existsSync(`${logFile()}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile()}.2`)).toBe(false);
  });

  it('stays console-only when the log directory cannot be made', () => {
    const blocked = path.join(dir, 'file-not-a-dir');
    fs.writeFileSync(blocked, 'x');
    const logger = createLogger({});
    expect(() => logger.toFile(blocked)).not.toThrow();
    expect(() => logger.info('still fine')).not.toThrow();
  });
});
