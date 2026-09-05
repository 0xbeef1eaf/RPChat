/** Minimal RSS 2.0 / Atom feed parser (regex based; enough for titles, links, dates and summaries). */
export interface FeedItem {
  title: string;
  link: string;
  published?: string;
  summary?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function stripTags(text: string): string {
  return decodeEntities(stripCdata(text).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagContent(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m?.[1];
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)];
  let fallback: string | undefined;
  for (const [, attrs = ''] of links) {
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /href\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (!rel || rel === 'alternate') return decodeEntities(href);
    fallback ??= decodeEntities(href);
  }
  return fallback;
}

function toIso(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const d = new Date(stripTags(text));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function parseFeed(xml: string, limit = 10): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  const out: FeedItem[] = [];
  for (const [, tag, body = ''] of blocks) {
    if (out.length >= limit) break;
    const isAtom = tag?.toLowerCase() === 'entry';
    const title = stripTags(tagContent(body, 'title') ?? '');
    let link: string;
    if (isAtom) link = atomLink(body) ?? '';
    else {
      const raw = tagContent(body, 'link');
      link = raw !== undefined ? stripTags(raw) : (atomLink(body) ?? '');
      if (link.length === 0) link = stripTags(tagContent(body, 'guid') ?? '');
    }
    const item: FeedItem = { title, link };
    const published = toIso(tagContent(body, 'pubDate') ?? tagContent(body, 'published') ?? tagContent(body, 'updated') ?? tagContent(body, 'dc:date'));
    if (published) item.published = published;
    const summary = stripTags(tagContent(body, 'description') ?? tagContent(body, 'summary') ?? tagContent(body, 'content') ?? tagContent(body, 'content:encoded') ?? '');
    if (summary) item.summary = summary.length > 500 ? `${summary.slice(0, 499)}…` : summary;
    out.push(item);
  }
  return out;
}
