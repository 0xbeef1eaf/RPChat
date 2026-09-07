/**
 * The pack writers/scaffolding from `@rp/pack` (docs/spec/editor.md). They are
 * being added concurrently; this adapter types them here and resolves them at
 * call time, so a missing one fails with a clear error instead of a crash.
 */
import * as pack from '@rp/pack';
import type { AssetEntry, BehaviourHook, BehaviourTemplate, CharacterDefinition, MediaManifest, PackManifest } from '@rp/shared';
import { RpError } from '@rp/shared';

export interface PackWriters {
  scaffoldPack(dir: string, input: { packId: string; name: string; characterId: string; characterName: string }): Promise<void>;
  writeManifest(dir: string, manifest: PackManifest): Promise<void>;
  writeCharacter(dir: string, charDir: string, definition: CharacterDefinition, personaText: string, behaviours: Partial<Record<BehaviourHook, string>>): Promise<void>;
  writeMediaManifest(dir: string, manifest: MediaManifest): Promise<void>;
  writeReadme(dir: string, text: string): Promise<void>;
  addAssetFile(dir: string, sourceFile: string, opts?: { kind?: AssetEntry['kind'] }): Promise<AssetEntry>;
  removeAsset(dir: string, assetPath: string): Promise<void>;
  personaTemplate(name: string): string;
  behaviourTemplates(): BehaviourTemplate[];
  slugify(name: string): string;
}

const NAMES: ReadonlyArray<keyof PackWriters> = [
  'scaffoldPack',
  'writeManifest',
  'writeCharacter',
  'writeMediaManifest',
  'writeReadme',
  'addAssetFile',
  'removeAsset',
  'personaTemplate',
  'behaviourTemplates',
  'slugify',
];

/** Writers from `@rp/pack`, with every missing function replaced by one that throws. */
export function packWriters(overrides: Partial<PackWriters> = {}): PackWriters {
  const source = pack as unknown as Partial<PackWriters>;
  const out: Partial<PackWriters> = {};
  for (const name of NAMES) {
    const fn = overrides[name] ?? source[name];
    out[name] = (typeof fn === 'function'
      ? fn
      : () => {
          throw new RpError('INTERNAL', `@rp/pack does not export ${name}() in this build`);
        }) as never;
  }
  return out as PackWriters;
}

/** Fallback slug when `@rp/pack.slugify` is unavailable (same rules: lower-case, `-` separated, id-safe). */
export function fallbackSlugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : `c-${slug}`.replace(/-$/, '') || 'character';
}
