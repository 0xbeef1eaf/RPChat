import { describe, expect, it } from 'vitest';
import { flattenBookmarks, folderSegments, otherBookmarksFolder, pathIndex, resolveFolder } from './lib/bookmarks.js';
import type { BookmarkNodeLike } from './lib/bookmarks.js';

const tree: BookmarkNodeLike[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        parentId: '0',
        title: 'Bookmarks bar',
        children: [
          { id: '10', parentId: '1', title: 'Docs', url: 'https://docs.test/' },
          { id: '11', parentId: '1', title: 'Work', children: [{ id: '12', parentId: '11', title: 'Tracker', url: 'https://tracker.test/' }, { id: '13', parentId: '11', title: 'Reports', children: [] }] },
        ],
      },
      { id: '2', parentId: '0', title: 'Other bookmarks', children: [{ id: '20', parentId: '2', title: 'Recipes', children: [{ id: '21', parentId: '20', title: 'Soup', url: 'https://soup.test/' }] }] },
    ],
  },
];

describe('bookmarks helpers', () => {
  it('flattens the tree with paths, skipping the invisible root, capped', () => {
    const flat = flattenBookmarks(tree);
    expect(flat.map((b) => `${b.path}|${b.title}`)).toEqual(['|Bookmarks bar', 'Bookmarks bar|Docs', 'Bookmarks bar|Work', 'Bookmarks bar/Work|Tracker', 'Bookmarks bar/Work|Reports', '|Other bookmarks', 'Other bookmarks|Recipes', 'Other bookmarks/Recipes|Soup']);
    expect(flat[1]).toEqual({ id: '10', title: 'Docs', url: 'https://docs.test/', parentId: '1', path: 'Bookmarks bar' });
    expect(flattenBookmarks(tree, 3)).toHaveLength(3);
    expect(pathIndex(tree).get('21')).toBe('Other bookmarks/Recipes');
    expect(pathIndex(tree).get('1')).toBe('');
  });

  it('resolves folders by title, by path, and reports missing segments', () => {
    expect(resolveFolder(tree, 'Work')).toMatchObject({ node: { id: '11' }, missing: [] });
    expect(resolveFolder(tree, 'work/reports')).toMatchObject({ node: { id: '13' }, missing: [] });
    expect(resolveFolder(tree, 'Bookmarks bar/Work/Tracker')).toMatchObject({ node: { id: '11' }, missing: ['Tracker'] }); // Tracker is a bookmark, not a folder
    expect(resolveFolder(tree, 'Recipes/2026/Spring')).toMatchObject({ node: { id: '20' }, missing: ['2026', 'Spring'] });
    expect(resolveFolder(tree, 'Nope')).toBeUndefined();
    expect(resolveFolder(tree, ' / ')).toBeUndefined();
    expect(folderSegments(' A / B //C ')).toEqual(['A', 'B', 'C']);
  });

  it('picks Other bookmarks (id 2, then by title, then the second root)', () => {
    expect(otherBookmarksFolder(tree)?.id).toBe('2');
    const alt: BookmarkNodeLike[] = [{ id: '0', title: '', children: [{ id: 'x', parentId: '0', title: 'Bar', children: [] }, { id: 'y', parentId: '0', title: 'Other', children: [] }] }];
    expect(otherBookmarksFolder(alt)?.id).toBe('y');
    expect(otherBookmarksFolder([{ id: '0', title: '', children: [{ id: 'only', parentId: '0', title: 'Bar' }] }])?.id).toBe('only');
    expect(otherBookmarksFolder([])).toBeUndefined();
  });
});
