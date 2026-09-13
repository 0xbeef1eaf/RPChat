/**
 * Bookmarks (pure): flatten Chrome's bookmark tree with a readable folder path per node, find a
 * folder by title or `A/B` path, and pick the "Other bookmarks" folder new folders go under.
 */

export interface BookmarkNodeLike {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: BookmarkNodeLike[];
}

export interface FlatBookmark {
  id: string;
  title: string;
  url?: string;
  parentId: string;
  /** Folder path from the root, e.g. `Bookmarks bar/Work`; empty for top-level folders. */
  path: string;
}

export const BOOKMARK_LIST_CAP = 500;

/** Bookmarks (and folders) under `nodes`, depth first, capped. The invisible root itself is skipped. */
export function flattenBookmarks(nodes: BookmarkNodeLike[], cap: number = BOOKMARK_LIST_CAP, basePath = ''): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  const walk = (node: BookmarkNodeLike, path: string): void => {
    if (out.length >= cap) return;
    const isRoot = node.parentId === undefined && node.id === '0';
    if (!isRoot) {
      out.push({ id: node.id, title: node.title, ...(node.url ? { url: node.url } : {}), parentId: node.parentId ?? '', path });
    }
    const childPath = isRoot ? path : path ? `${path}/${node.title}` : node.title;
    for (const child of node.children ?? []) {
      if (out.length >= cap) return;
      walk(child, childPath);
    }
  };
  for (const node of nodes) walk(node, basePath);
  return out;
}

/** Folder path (`Bookmarks bar/Work`) of every node id, from the tree. */
export function pathIndex(nodes: BookmarkNodeLike[]): Map<string, string> {
  const paths = new Map<string, string>();
  const walk = (node: BookmarkNodeLike, path: string): void => {
    const isRoot = node.parentId === undefined && node.id === '0';
    if (!isRoot) paths.set(node.id, path);
    const childPath = isRoot ? path : path ? `${path}/${node.title}` : node.title;
    for (const child of node.children ?? []) walk(child, childPath);
  };
  for (const node of nodes) walk(node, '');
  return paths;
}

/** Split `A/B/C` into segments (blank segments dropped). */
export function folderSegments(folder: string): string[] {
  return folder
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function childFolder(node: BookmarkNodeLike, title: string): BookmarkNodeLike | undefined {
  return (node.children ?? []).find((c) => !c.url && c.title.trim().toLowerCase() === title.toLowerCase());
}

/**
 * Find the folder named by `folder`: a path `A/B` is walked from the top-level folders (and,
 * failing that, from "Other bookmarks"); a single title matches the first folder anywhere with
 * that title. Returns the node plus the segments that still need creating (empty when found).
 */
export function resolveFolder(tree: BookmarkNodeLike[], folder: string): { node: BookmarkNodeLike; missing: string[] } | undefined {
  const segments = folderSegments(folder);
  if (segments.length === 0) return undefined;
  const roots = tree.flatMap((n) => (n.parentId === undefined && n.id === '0' ? n.children ?? [] : [n]));
  const walkFrom = (first: BookmarkNodeLike): { node: BookmarkNodeLike; missing: string[] } => {
    let node = first;
    let i = 1;
    for (; i < segments.length; i++) {
      const next = childFolder(node, segments[i]!);
      if (!next) break;
      node = next;
    }
    return { node, missing: segments.slice(i) };
  };
  // 1. Top-level folder names ("Bookmarks bar", "Other bookmarks") start a path.
  const top = roots.find((r) => !r.url && r.title.trim().toLowerCase() === segments[0]!.toLowerCase());
  if (top) return walkFrom(top);
  // 2. Any folder with the first segment's title, nearest to the top first.
  const queue: BookmarkNodeLike[] = [...roots];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!node.url && node.title.trim().toLowerCase() === segments[0]!.toLowerCase()) return walkFrom(node);
    for (const c of node.children ?? []) if (!c.url) queue.push(c);
  }
  return undefined;
}

/** The "Other bookmarks" folder (Chrome's id `2`; else the second top-level folder, else the first). */
export function otherBookmarksFolder(tree: BookmarkNodeLike[]): BookmarkNodeLike | undefined {
  const roots = tree.flatMap((n) => (n.parentId === undefined && n.id === '0' ? n.children ?? [] : [n]));
  return roots.find((r) => r.id === '2') ?? roots.find((r) => /^other/i.test(r.title)) ?? roots[1] ?? roots[0];
}
