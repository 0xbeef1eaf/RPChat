import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Markdown → sanitised HTML. Links open through `window.open`, which the main
 * process routes to the system browser via its window-open handler; images
 * may only come from pack assets (`rp-asset:`) or inline data URLs.
 */
const ALLOWED_URI = /^(?:(?:https?|mailto|rp-asset|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(source: string): string {
  ensureHooks();
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
  });
}

/** Escape-only rendering for text that must not be interpreted as markdown. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
