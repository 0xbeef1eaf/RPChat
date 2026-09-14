import type { CapabilityModuleSpec } from '@rp/shared';

export const packModule: CapabilityModuleSpec = {
  id: 'pack',
  version: '1.1.0',
  title: 'Pack assets',
  summary: 'Find and inspect the files (images, video, audio, text) shipped with your pack.',
  permission: 'trusted',
  apiTypeName: 'PackApi',
  typings: `/**
 * Access to the files bundled with your pack. Paths are relative to the pack root
 * with forward slashes ("media/images/smile.png"); absolute paths and ".." are rejected.
 * The asset list in your prompt tells you which files exist.
 */
interface PackApi {
  /**
   * Validate a path and describe the file (kind, mime, size). Use the result with
   * sdk.media.* functions. Throws NOT_FOUND if the file does not exist and
   * PATH_ESCAPE if the path points outside the pack.
   * @param path Pack-relative path, e.g. "media/images/smile.png".
   * @example const pic = await sdk.pack.asset("media/images/smile.png");
   */
  asset(path: string): Promise<AssetRef>;
  /**
   * List assets, optionally restricted to a directory prefix and/or kind.
   * Sorted by path. Use it to pick from a folder without hardcoding names. Your own avatar and
   * expression frames are not listed here (or by findAssets/tags): they belong to sdk.avatar.
   * @param prefix Only paths starting with this, e.g. "media/audio/". Omit for all.
   * @param kind Only assets of this kind ('image' | 'video' | 'audio' | 'text' | 'other').
   * @example const songs = await sdk.pack.listAssets("media/audio", "audio");
   */
  listAssets(prefix?: string, kind?: AssetRef['kind']): Promise<AssetRef[]>;
  /**
   * Find assets by meaning. All given filters must hold.
   * @param query tags: every listed tag must be present; anyTags: at least one must be present; fallback (default true): when
   *   nothing carries those tags, every asset of that kind is returned instead of an empty list (pass false for a strict search);
   *   kind: restrict to a kind; text: case-insensitive substring of the path or description; limit: default 50.
   * @returns Matching assets, best matches first (more matching tags, then shorter path).
   * @example const beach = await sdk.pack.findAssets({ anyTags: ["beach", "summer"], kind: "image" });
   * @example const sad = await sdk.pack.findAssets({ tags: ["luna", "sad"] });
   */
  findAssets(query: { tags?: string[]; anyTags?: string[]; kind?: AssetRef['kind']; text?: string; limit?: number; fallback?: boolean }): Promise<AssetRef[]>;
  /**
   * The tags used across the pack with counts and the author's meaning for each (from media.json).
   * The prompt already lists them; call this if you need fresh counts.
   */
  tags(): Promise<AssetTag[]>;
  /**
   * Read a text asset (kind 'text': .txt, .md, .json, ...). Throws NOT_FOUND, PATH_ESCAPE,
   * or INVALID_ARGUMENT for non-text files. Content is decoded as UTF-8.
   * @param path Pack-relative path.
   * @param maxBytes Truncate after this many bytes. Default 65536 (64 KiB).
   * @example const lore = await sdk.pack.readText("lore/backstory.md");
   */
  readText(path: string, maxBytes?: number): Promise<string>;
  /**
   * Metadata about the installed pack and the character that is currently acting.
   * @returns Pack id, name, version, optional description, and the active character's id and name.
   */
  info(): Promise<{ id: string; name: string; version: string; description?: string; characterId: string; characterName: string }>;
}`,
  docs: `Look up files in your pack before showing or playing them. Paths are relative to the pack root with forward slashes.

- Your prompt lists the pack's assets grouped by kind, each with its tags and description; use \`findAssets\` to pick by meaning (\`{ anyTags: ["cozy", "night"] }\`), \`listAssets\` to choose among a folder, and \`asset\` to validate one path and get a ref for \`sdk.media\`.
- Tags come from folder names and the pack's media.json; the tag list in your prompt tells you what each tag means. Prefer a tagged match over guessing from a file name.
- \`readText\` is for small text files (lore, scripts, JSON) — not for media.
- Missing files throw \`NOT_FOUND\`; never guess file names that are not in the asset list.

\`\`\`ts
const pics = await sdk.pack.listAssets("media/images", "image");
const pick = pics[Math.floor(Math.random() * pics.length)];
if (pick) await sdk.media.showImage(pick, { durationMs: 8000 });
\`\`\``,
  methods: {
    asset: { description: 'Validate a pack path and describe the file.' },
    listAssets: { description: 'List pack assets by prefix and/or kind.' },
    findAssets: { description: 'Find assets by tags, kind or text.' },
    tags: { description: 'List the tags used across the pack.' },
    readText: { description: 'Read a text asset as a string.' },
    info: { description: 'Read pack and active-character metadata.' },
  },
};
