/** Applies the theme setting to a document root (`data-theme`; absent means "follow the system"). */
export function applyTheme(theme: 'system' | 'light' | 'dark', root: HTMLElement = document.documentElement): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
