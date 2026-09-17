/**
 * What `sdk.crypto` and `decrypt-all` refuse to touch. Two layers: a path has to resolve inside
 * the user's home directory at all (the real backstop — the app runs as the user, so this is
 * mostly about refusing a pack's mistake or malice before the OS would anyway), and even inside
 * home, anything that *looks* like it configures the system or a running service is skipped —
 * garbling a `.desktop` launcher or a systemd unit is a worse day than a file staying plaintext.
 * Not exhaustive by design: when in doubt this errs toward refusing rather than guessing.
 */
import * as path from 'node:path';

/** Extensions of files a desktop or init system reads, never something to hand to a character. */
const SYSTEM_EXTENSIONS = new Set([
  '.service', '.socket', '.target', '.mount', '.automount', '.timer', '.path', '.slice', '.scope',
  '.desktop', '.directory', '.conf', '.rules', '.policy', '.pkla', '.udev', '.mimeapps',
]);

/** Path components that mark a per-user config tree as system/session integration rather than the user's own data, wherever they occur under home. */
const SYSTEM_DIR_SEGMENTS = new Set(['systemd', 'autostart', 'applications', 'dbus-1', 'polkit-1', 'udev', 'sudoers.d', 'pam.d']);

/** Whether `absPath` (already resolved, no `..`) looks like something the desktop, a service manager or a login session reads rather than a document the user owns. */
export function looksLikeSystemFile(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  if (SYSTEM_EXTENSIONS.has(ext)) return true;
  const segments = absPath.split(path.sep);
  return segments.some((s) => SYSTEM_DIR_SEGMENTS.has(s));
}

/** Whether `absPath` is `home` itself or somewhere under it (both already resolved, no `..`, no trailing slash assumed). */
export function isWithinHome(absPath: string, home: string): boolean {
  const rel = path.relative(home, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
