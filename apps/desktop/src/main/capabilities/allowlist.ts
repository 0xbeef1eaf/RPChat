/** Hostname allowlist matching for `sdk.web` (`example.com` exact, `*.example.com` any subdomain). */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const pat = pattern.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || pat.length === 0) return false;
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(2);
    return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
  }
  if (pat === '*') return true;
  return host === pat;
}

export function isAllowlisted(url: string, allowlist: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return allowlist.some((p) => hostMatches(parsed.hostname, p));
}

/** Executable name (basename, no extension) matching for `sdk.desktop.launch`. */
export function executableName(command: string): string {
  const base = command.trim().replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

export function isLaunchAllowed(command: string, allowlist: string[]): boolean {
  const name = executableName(command);
  return name.length > 0 && allowlist.some((a) => executableName(a) === name);
}
