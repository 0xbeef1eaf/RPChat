/**
 * Functions injected into pages with `chrome.scripting.executeScript({ func })`. Chrome serialises
 * each function with `toString()` and runs it in the page's isolated world, so every one of them
 * must be self-contained: no imports, no references to other module-level identifiers, and only
 * JSON-serialisable return values. Nothing is injected persistently — each op injects, runs, and
 * is gone.
 */

export interface PageReadResult {
  url: string;
  title: string;
  text: string;
}

export interface PageQueryItem {
  index: number;
  tag: string;
  text: string;
  href?: string;
  value?: string;
}

/** Visible text of the document (raw; the worker collapses whitespace and applies the cap). */
export function pageRead(maxRaw: number): PageReadResult {
  const body = document.body;
  const raw = body ? body.innerText || body.textContent || '' : '';
  return { url: location.href, title: document.title, text: raw.length > maxRaw ? raw.slice(0, maxRaw) : raw };
}

/** Elements matching a CSS selector, in document order, capped at `limit`. */
export function pageQuery(selector: string, limit: number): PageQueryItem[] {
  const out: PageQueryItem[] = [];
  const nodes = document.querySelectorAll(selector);
  for (let i = 0; i < nodes.length && out.length < limit; i++) {
    const el = nodes[i] as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const label = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const item: PageQueryItem = { index: i, tag, text: label.length > 200 ? `${label.slice(0, 199)}…` : label };
    const href = (el as HTMLAnchorElement).href;
    if (typeof href === 'string' && href.length > 0) item.href = href;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const value = (el as HTMLInputElement).value;
      if (typeof value === 'string') item.value = value.length > 200 ? `${value.slice(0, 199)}…` : value;
    }
    out.push(item);
  }
  return out;
}

/** Click the `index`-th element matching `selector` (scrolled into view first). */
export function pageClick(selector: string, index: number): { clicked: boolean; tag?: string; text?: string; matches: number } {
  const nodes = document.querySelectorAll(selector);
  const el = nodes[index] as HTMLElement | undefined;
  if (!el) return { clicked: false, matches: nodes.length };
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {
    /* not scrollable */
  }
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { clicked: true, tag: el.tagName.toLowerCase(), text: text.slice(0, 200), matches: nodes.length };
}

/**
 * Focus the first element matching `selector`, set its value the way a framework notices
 * (native value setter + input/change events, or textContent for contenteditable) and,
 * with `submit`, press Enter and submit the surrounding form.
 */
export function pageType(selector: string, text: string, submit: boolean): { typed: boolean; submitted: boolean; tag?: string } {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { typed: false, submitted: false };
  const tag = el.tagName.toLowerCase();
  el.focus();
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else (el as HTMLInputElement).value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (tag === 'select') {
    const select = el as HTMLSelectElement;
    const option = Array.from(select.options).find((o) => o.value === text || o.text.trim() === text);
    if (option) select.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } else {
    return { typed: false, submitted: false, tag };
  }
  let submitted = false;
  if (submit) {
    const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    const form = (el as HTMLInputElement).form ?? el.closest('form');
    if (down && form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      submitted = true;
    } else if (!down) {
      submitted = true; // the page handled Enter itself
    }
  }
  return { typed: true, submitted, tag };
}

/** Scroll the window to `y`, or the first element matching `selector` into view. */
export function pageScroll(y: number | null, selector: string | null): { x: number; y: number; height: number; found?: boolean } {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, found: false };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight, found: true };
  }
  if (typeof y === 'number' && Number.isFinite(y)) window.scrollTo({ top: Math.max(0, y), left: 0 });
  return { x: window.scrollX, y: window.scrollY, height: document.documentElement.scrollHeight };
}

/** Count case-insensitive occurrences of `text` in the visible text; scroll the first into view. */
export function pageFind(text: string): { count: number; first?: { snippet: string; tag: string } } {
  const needle = text.toLowerCase();
  if (needle.length === 0) return { count: 0 };
  const body = document.body;
  if (!body) return { count: 0 };
  const haystack = (body.innerText || body.textContent || '').toLowerCase();
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  if (count === 0) return { count: 0 };
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const value = node.nodeValue ?? '';
    const idx = value.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      const parent = node.parentElement;
      if (parent) {
        const style = window.getComputedStyle(parent);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          try {
            parent.scrollIntoView({ block: 'center', inline: 'nearest' });
          } catch {
            /* ignore */
          }
          const start = Math.max(0, idx - 60);
          const snippet = value.slice(start, idx + needle.length + 60).replace(/\s+/g, ' ').trim();
          return { count, first: { snippet, tag: parent.tagName.toLowerCase() } };
        }
      }
    }
    node = walker.nextNode();
  }
  return { count };
}

/**
 * Apply (or update) the image effect: a `<style data-rp-effect>` rule for `selector`, optional
 * source replacement (originals remembered in `data-rp-original-src` / `-srcset`), and an
 * in-page timer that reverts everything after `durationMs`. Not persisted across navigations.
 */
export function pageImageEffect(stylesheet: string, selector: string, replaceWith: string | null, durationMs: number): { applied: boolean; replaced: number; total: number } {
  const w = window as unknown as { __rpEffectTimer?: number };
  const revert = (): void => {
    document.querySelectorAll('style[data-rp-effect]').forEach((s) => s.remove());
    document.querySelectorAll('[data-rp-original-src]').forEach((el) => {
      const original = el.getAttribute('data-rp-original-src') ?? '';
      const originalSet = el.getAttribute('data-rp-original-srcset');
      if (original.length > 0) el.setAttribute('src', original);
      else el.removeAttribute('src');
      if (originalSet !== null && originalSet.length > 0) el.setAttribute('srcset', originalSet);
      el.removeAttribute('data-rp-original-src');
      el.removeAttribute('data-rp-original-srcset');
    });
    if (w.__rpEffectTimer) {
      clearTimeout(w.__rpEffectTimer);
      delete w.__rpEffectTimer;
    }
  };
  if (w.__rpEffectTimer) {
    clearTimeout(w.__rpEffectTimer);
    delete w.__rpEffectTimer;
  }
  let style = document.querySelector('style[data-rp-effect]') as HTMLStyleElement | null;
  if (stylesheet.length === 0) {
    if (style) style.remove();
  } else {
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-rp-effect', '1');
      (document.head ?? document.documentElement).appendChild(style);
    }
    style.textContent = stylesheet;
  }
  let replaced = 0;
  let total = 0;
  if (replaceWith) {
    const swap = (el: Element): void => {
      if (!el.hasAttribute('data-rp-original-src')) {
        el.setAttribute('data-rp-original-src', el.getAttribute('src') ?? '');
        el.setAttribute('data-rp-original-srcset', el.getAttribute('srcset') ?? '');
      }
      el.removeAttribute('srcset');
      el.setAttribute('src', replaceWith);
      replaced++;
    };
    document.querySelectorAll(selector).forEach((el) => {
      total++;
      const tag = el.tagName.toLowerCase();
      if (tag === 'img') swap(el);
      else if (tag === 'picture') {
        el.querySelectorAll('source').forEach((s) => {
          if (!s.hasAttribute('data-rp-original-src')) {
            s.setAttribute('data-rp-original-src', '');
            s.setAttribute('data-rp-original-srcset', s.getAttribute('srcset') ?? '');
          }
          s.removeAttribute('srcset');
        });
        el.querySelectorAll('img').forEach(swap);
      } else el.querySelectorAll('img').forEach(swap);
    });
  }
  if (durationMs > 0) w.__rpEffectTimer = window.setTimeout(revert, durationMs);
  return { applied: stylesheet.length > 0 || replaced > 0, replaced, total };
}

/** Undo `pageImageEffect` right away: drop the style, restore every swapped source, cancel the timer. */
export function pageClearImageEffects(): { cleared: boolean; restored: number } {
  const w = window as unknown as { __rpEffectTimer?: number };
  const styles = document.querySelectorAll('style[data-rp-effect]');
  styles.forEach((s) => s.remove());
  let restored = 0;
  document.querySelectorAll('[data-rp-original-src]').forEach((el) => {
    const original = el.getAttribute('data-rp-original-src') ?? '';
    const originalSet = el.getAttribute('data-rp-original-srcset');
    if (original.length > 0) el.setAttribute('src', original);
    else el.removeAttribute('src');
    if (originalSet !== null && originalSet.length > 0) el.setAttribute('srcset', originalSet);
    el.removeAttribute('data-rp-original-src');
    el.removeAttribute('data-rp-original-srcset');
    restored++;
  });
  if (w.__rpEffectTimer) {
    clearTimeout(w.__rpEffectTimer);
    delete w.__rpEffectTimer;
  }
  return { cleared: styles.length > 0 || restored > 0, restored };
}

/**
 * Run the character's code as the body of an async function and hand back its JSON-serialised
 * result. Runs in whichever world `executeScript` was asked for; a CSP that forbids
 * `new Function` (page CSP in the main world) surfaces as `{ ok: false, error }`.
 */
export function pageEval(src: string): Promise<{ ok: boolean; json?: string; error?: string }> {
  return (async () => {
    try {
      const f = new Function(`return (async () => {\n${src}\n})();`) as () => Promise<unknown>;
      const value = await f();
      const json = JSON.stringify(value === undefined ? null : value);
      if (typeof json !== 'string') return { ok: false, error: 'The result is not JSON-serialisable (return plain data, not functions or DOM nodes)' };
      return { ok: true, json };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { ok: false, error: e && typeof e.message === 'string' ? `${e.name ?? 'Error'}: ${e.message}` : String(err) };
    }
  })();
}
