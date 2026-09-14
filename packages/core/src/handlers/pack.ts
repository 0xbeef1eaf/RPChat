import * as fs from 'node:fs/promises';
import type { ActionContext, AssetKind, CapabilityHandler, Json, LoadedPack } from '@rp/shared';
import { RpError } from '@rp/shared';
import { DEFAULT_MEDIA_ROOT, normalizeRelativePath, resolveAssetPath } from '@rp/pack';
import { findAssets, resolvePackAsset, showableAssets, summariseTags, toAssetRef } from '../assets.js';
import type { FindAssetsQuery } from '../assets.js';

const READ_TEXT_DEFAULT_BYTES = 64 * 1024;
const READ_TEXT_MAX_BYTES = 1024 * 1024;
const ASSET_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'text', 'other']);

/** `sdk.pack`: asset lookup, listing, text reading and pack metadata, all confined to the pack root. */
export class PackHandler implements CapabilityHandler {
  readonly moduleId = 'pack';

  constructor(private readonly packs: { getLoaded(packId: string): LoadedPack }) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    const pack = this.packs.getLoaded(context.packId);
    switch (method) {
      case 'asset':
        return resolvePackAsset(pack, args[0] as string) as unknown as Json;
      case 'listAssets':
        return this.listAssets(pack, args[0], args[1]) as unknown as Json;
      case 'findAssets': {
        const q = args[0];
        if (q !== undefined && q !== null && (typeof q !== 'object' || Array.isArray(q))) throw new RpError('INVALID_ARGUMENT', 'query must be an object');
        return findAssets(showableAssets(pack.assets), (q ?? {}) as FindAssetsQuery) as unknown as Json;
      }
      case 'tags':
        return summariseTags(showableAssets(pack.assets), pack.tagDescriptions ?? {}) as unknown as Json;
      case 'readText':
        return this.readText(pack, args[0], args[1]);
      case 'info': {
        const character = pack.characters.find((c) => c.definition.id === context.characterId);
        const info: Record<string, Json> = {
          id: pack.manifest.id,
          name: pack.manifest.name,
          version: pack.manifest.version,
          characterId: context.characterId,
          characterName: character?.definition.name ?? context.characterId,
        };
        if (pack.manifest.description !== undefined) info.description = pack.manifest.description;
        return info;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.pack.${method}`);
    }
  }

  private listAssets(pack: LoadedPack, prefixArg: unknown, kindArg: unknown): unknown[] {
    let prefixes: string[] = [];
    if (prefixArg !== undefined && prefixArg !== null) {
      if (typeof prefixArg !== 'string') throw new RpError('INVALID_ARGUMENT', 'prefix must be a string');
      if (prefixArg.trim().length > 0) {
        const n = normalizeRelativePath(prefixArg);
        if (!n.ok) throw new RpError('PATH_ESCAPE', `Unsafe prefix "${prefixArg}": ${n.reason}`);
        const mediaRoot = normalizeRelativePath(pack.manifest.mediaRoot ?? DEFAULT_MEDIA_ROOT);
        prefixes = [n.path];
        if (mediaRoot.ok && !n.path.startsWith(`${mediaRoot.path}/`) && n.path !== mediaRoot.path) {
          prefixes.push(`${mediaRoot.path}/${n.path}`);
        }
      }
    }
    let kind: AssetKind | undefined;
    if (kindArg !== undefined && kindArg !== null) {
      if (typeof kindArg !== 'string' || !ASSET_KINDS.has(kindArg)) {
        throw new RpError('INVALID_ARGUMENT', `kind must be one of ${[...ASSET_KINDS].join(', ')}`);
      }
      kind = kindArg as AssetKind;
    }
    return showableAssets(pack.assets)
      .filter((a) => kind === undefined || a.kind === kind)
      .filter((a) => prefixes.length === 0 || prefixes.some((p) => a.path === p || a.path.startsWith(`${p}/`)))
      .map(toAssetRef);
  }

  private async readText(pack: LoadedPack, pathArg: unknown, maxArg: unknown): Promise<string> {
    if (typeof pathArg !== 'string') throw new RpError('INVALID_ARGUMENT', 'path must be a string');
    const ref = resolvePackAsset(pack, pathArg);
    if (ref.kind !== 'text') {
      throw new RpError('INVALID_ARGUMENT', `"${ref.path}" is not a text asset (kind: ${ref.kind})`, { path: ref.path, kind: ref.kind });
    }
    let maxBytes = READ_TEXT_DEFAULT_BYTES;
    if (maxArg !== undefined && maxArg !== null) {
      if (typeof maxArg !== 'number' || !Number.isFinite(maxArg) || maxArg < 1) {
        throw new RpError('INVALID_ARGUMENT', 'maxBytes must be a positive number');
      }
      maxBytes = Math.min(Math.floor(maxArg), READ_TEXT_MAX_BYTES);
    }
    const abs = resolveAssetPath(pack.root, ref.path);
    const handle = await fs.open(abs, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
}
