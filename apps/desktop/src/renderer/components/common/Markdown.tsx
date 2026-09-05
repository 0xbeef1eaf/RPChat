import { useMemo, type MouseEvent } from 'react';
import { renderMarkdown } from '../../lib/markdown';

interface MarkdownProps {
  source: string;
  className?: string;
}

function onClick(e: MouseEvent<HTMLDivElement>): void {
  const anchor = (e.target as HTMLElement).closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) {
    // Routed by the main process' window-open handler to the system browser.
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

/** Sanitised markdown. The HTML comes from `renderMarkdown`, which runs DOMPurify. */
export function Markdown({ source, className }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className ? `md ${className}` : 'md'} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
