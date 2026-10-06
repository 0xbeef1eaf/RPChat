import { describe, expect, it } from 'vitest';
import type { HostEvent } from '@rp/shared';
import { SESSIONS_DIR, VT_ACTIVE_PATH, VtMonitor, parseActiveVt, parseSessionVt } from './vt.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A monitor over a fake filesystem: `files` is read on every poll, so a test can move the VT. */
function monitor(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): { vt: VtMonitor; events: HostEvent[] } {
  const events: HostEvent[] = [];
  const vt = new VtMonitor({
    emit: (e) => events.push(e),
    logger,
    env,
    readFile: (file) => {
      const text = files[file];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return text;
    },
    now: () => new Date('2026-10-06T12:00:00.000Z'),
  });
  return { vt, events };
}

describe('parseActiveVt', () => {
  it('reads the kernel tty0/active format and rejects anything else', () => {
    expect(parseActiveVt('tty3\n')).toBe(3);
    expect(parseActiveVt('tty12')).toBe(12);
    expect(parseActiveVt('  tty1  \n')).toBe(1);
    // A seat without VTs reports a bare `tty`, and tty0 is "the foreground one", never an answer.
    expect(parseActiveVt('tty')).toBeNull();
    expect(parseActiveVt('tty0')).toBeNull();
    expect(parseActiveVt('')).toBeNull();
    expect(parseActiveVt('pts/3')).toBeNull();
  });
});

describe('parseSessionVt', () => {
  it('finds VTNR in a logind session file, and nothing when the session is on no VT', () => {
    expect(parseSessionVt('UID=1000\nTYPE=wayland\nSEAT=seat0\nVTNR=2\nACTIVE=0\n')).toBe(2);
    expect(parseSessionVt('# This is private data. Do not parse.\nVTNR=7')).toBe(7);
    expect(parseSessionVt('UID=1000\nTYPE=tty\nREMOTE=1\n')).toBeNull();
    expect(parseSessionVt('VTNR=0\n')).toBeNull();
    expect(parseSessionVt('VTNR=\n')).toBeNull();
    // Not fooled by a key that merely ends in VTNR.
    expect(parseSessionVt('XDG_VTNR=5\n')).toBeNull();
  });
});

describe('VtMonitor', () => {
  it('emits vt-changed when the foreground VT moves, with whether it is ours', () => {
    const files = { [VT_ACTIVE_PATH]: 'tty2\n' };
    const { vt, events } = monitor(files, { XDG_VTNR: '2' });
    vt.start();
    expect(events, 'the first read is the baseline, not a switch').toEqual([]);

    // The user presses ctrl+alt+F3.
    files[VT_ACTIVE_PATH] = 'tty3\n';
    vt.poll();
    expect(events).toEqual([
      {
        name: 'vt-changed',
        data: { vt: 3, previous: 2, ourVt: 2, ours: false },
        at: '2026-10-06T12:00:00.000Z',
      },
    ]);

    // Nothing moved: no repeat.
    vt.poll();
    expect(events).toHaveLength(1);

    // ...and back.
    files[VT_ACTIVE_PATH] = 'tty2\n';
    vt.poll();
    expect(events).toHaveLength(2);
    expect(events[1]?.data).toEqual({ vt: 2, previous: 3, ourVt: 2, ours: true });
    vt.stop();
  });

  it('falls back to the logind session file when XDG_VTNR is not in the environment', () => {
    // What an app started through a systemd user unit sees: a session id but no XDG_VTNR.
    const files = {
      [VT_ACTIVE_PATH]: 'tty2\n',
      [`${SESSIONS_DIR}/7`]: 'UID=1000\nTYPE=wayland\nSEAT=seat0\nVTNR=2\nACTIVE=1\n',
    };
    const { vt, events } = monitor(files, { XDG_SESSION_ID: '7' });
    vt.start();
    expect(vt.sessionVt()).toBe(2);
    files[VT_ACTIVE_PATH] = 'tty1\n';
    vt.poll();
    expect(events[0]?.data).toEqual({ vt: 1, previous: 2, ourVt: 2, ours: false });
  });

  it('reports no VT of our own rather than guessing, and still reports the switch', () => {
    const files = { [VT_ACTIVE_PATH]: 'tty2\n' };
    // An ssh login or a container: no XDG_VTNR, no readable session file.
    const { vt, events } = monitor(files, { XDG_SESSION_ID: 'c1' });
    vt.start();
    expect(vt.sessionVt()).toBeNull();
    files[VT_ACTIVE_PATH] = 'tty4\n';
    vt.poll();
    expect(events[0]?.data).toEqual({ vt: 4, previous: 2, ourVt: null, ours: false });
  });

  it('does nothing at all on a machine with no virtual terminals', () => {
    const { vt, events } = monitor({}, { XDG_VTNR: '2' });
    vt.start();
    expect(vt.activeVt()).toBeNull();
    vt.poll();
    expect(events).toEqual([]);
    vt.stop();
  });

  it('survives the file disappearing while it watches', () => {
    const files: Record<string, string> = { [VT_ACTIVE_PATH]: 'tty2\n' };
    const { vt, events } = monitor(files, { XDG_VTNR: '2' });
    vt.start();
    delete files[VT_ACTIVE_PATH];
    expect(() => vt.poll()).not.toThrow();
    expect(events).toEqual([]);
    // And picks up again when it comes back, without inventing a switch to where we already were.
    files[VT_ACTIVE_PATH] = 'tty2\n';
    vt.poll();
    expect(events).toEqual([]);
    files[VT_ACTIVE_PATH] = 'tty5\n';
    vt.poll();
    expect(events).toHaveLength(1);
  });
});
