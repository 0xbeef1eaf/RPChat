import { describe, expect, it } from 'vitest';
import { compactJson, formatBytes, formatDuration, formatRelative, maskSecret, truncate } from './format';

describe('format helpers', () => {
  it('formatDuration', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(15_000)).toBe('15.0 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(16 * 1024)).toBe('16 KiB');
    expect(formatBytes(64 * 1024 * 1024)).toBe('64 MiB');
  });
  it('formatRelative', () => {
    const now = Date.parse('2026-05-01T12:00:00Z');
    expect(formatRelative('2026-05-01T11:59:40Z', now)).toBe('just now');
    expect(formatRelative('2026-05-01T11:30:00Z', now)).toBe('30 min');
    expect(formatRelative('2026-05-01T09:00:00Z', now)).toBe('3 h');
    expect(formatRelative('2026-04-30T09:00:00Z', now)).toBe('yesterday');
    expect(formatRelative('garbage', now)).toBe('');
  });
  it('truncate and compactJson', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(compactJson({ a: 1 })).toBe('{"a":1}');
    expect(compactJson(undefined)).toBe('undefined');
  });
  it('maskSecret', () => {
    expect(maskSecret(undefined)).toBe('');
    expect(maskSecret('abc')).toBe('•••');
    expect(maskSecret('sk-ant-1234567890abcd')).toMatch(/^•+abcd$/);
  });
});
