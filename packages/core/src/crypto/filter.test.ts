import { describe, expect, it } from 'vitest';
import { isWithinHome, looksLikeSystemFile } from './filter.js';

describe('looksLikeSystemFile', () => {
  it('flags the example extensions from the spec', () => {
    expect(looksLikeSystemFile('/home/ada/foo.service')).toBe(true);
    expect(looksLikeSystemFile('/home/ada/.config/app.desktop')).toBe(true);
    expect(looksLikeSystemFile('/home/ada/nginx.conf')).toBe(true);
  });

  it('flags other session/init extensions', () => {
    for (const ext of ['.socket', '.target', '.mount', '.timer', '.rules', '.policy']) {
      expect(looksLikeSystemFile(`/home/ada/x${ext}`)).toBe(true);
    }
  });

  it('flags known system directories under home', () => {
    expect(looksLikeSystemFile('/home/ada/.config/systemd/user/foo.txt')).toBe(true);
    expect(looksLikeSystemFile('/home/ada/.config/autostart/thing.txt')).toBe(true);
  });

  it('does not flag ordinary documents', () => {
    expect(looksLikeSystemFile('/home/ada/diary.md')).toBe(false);
    expect(looksLikeSystemFile('/home/ada/photos/party.jpg')).toBe(false);
    expect(looksLikeSystemFile('/home/ada/.bashrc')).toBe(false);
    expect(looksLikeSystemFile('/home/ada/notes.txt')).toBe(false);
  });
});

describe('isWithinHome', () => {
  const home = '/home/ada';

  it('accepts home itself and anything under it', () => {
    expect(isWithinHome('/home/ada', home)).toBe(true);
    expect(isWithinHome('/home/ada/diary.md', home)).toBe(true);
    expect(isWithinHome('/home/ada/a/b/c.txt', home)).toBe(true);
  });

  it('rejects paths outside home, including a look-alike sibling', () => {
    expect(isWithinHome('/home/adamsson/diary.md', home)).toBe(false);
    expect(isWithinHome('/etc/passwd', home)).toBe(false);
    expect(isWithinHome('/home', home)).toBe(false);
  });
});
