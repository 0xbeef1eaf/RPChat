export {
  BEHAVIOUR_HOOKS,
  BEHAVIOUR_SCRIPT_EXTENSIONS,
  EXPRESSION_EXTENSIONS,
  CHARACTER_ID_PATTERN,
  IGNORED_CAPABILITIES_KEY,
  PACK_ID_PATTERN,
  SEMVER_PATTERN,
  characterDefinitionSchema,
  issuesOf,
  packManifestSchema,
  relativePathSchema,
  validateCharacter,
  validateManifest,
} from './schema.js';
export type { ValidationIssue } from './schema.js';

export {
  isInside,
  isSafeRelativePath,
  joinRelative,
  normalizeRelativePath,
  resolveAssetPath,
} from './paths.js';
export type { NormalizedPath } from './paths.js';

export {
  ASSET_KIND_BY_EXTENSION,
  DEFAULT_MEDIA_ROOT,
  DEFAULT_MIME,
  KIND_FOLDER_NAMES,
  MIME_BY_EXTENSION,
  applyMediaTags,
  assetKindFor,
  extensionOf,
  folderTagsFor,
  indexAssets,
  mimeFor,
  summariseTags,
} from './assets.js';

export { globToRegExp, isGlob, matchesGlob } from './glob.js';

export { mediaManifestSchema, validateMediaManifest } from './media-manifest.js';

export {
  MAX_DESCRIPTION_LENGTH,
  MAX_TAGS_PER_ASSET,
  MAX_TAG_LENGTH,
  TAG_PATTERN,
  normalizeTag,
  normalizeTags,
} from './tags.js';

export { CHARACTERS_DIR_NAME, PACK_README_FILENAME, ignoredCapabilitiesWarning, inspectPack, loadPack, validatePack } from './loader.js';
export type { PackInspection } from './loader.js';

export {
  behaviourScriptPath,
  behaviourTemplates,
  hookFileStem,
  libraryFunctionTemplate,
  libraryReadme,
  personaTemplate,
} from './templates.js';

export {
  LIB_RESERVED_NAMES,
  LIB_STATIC_NAMES,
  formatLibraryFile,
  libraryFilePath,
  libraryNameProblem,
  parseLibraryFile,
  readCharacterLibrary,
  removeLibraryFunction,
  writeLibraryFunction,
} from './library.js';
export type { CharacterLibraryScan, LibraryFileProblem, ReadLibraryOptions } from './library.js';

export {
  exportedFunctionSource,
  functionSourceProblem,
  isLibraryModule,
  libraryFunctionShape,
  libraryValueExpression,
  stripLeadingComments,
  unwrapFunctionSource,
} from './library-source.js';
export type { LibraryFunctionShape, LibraryModule } from './library-source.js';

export {
  addAssetFile,
  removeAsset,
  scaffoldPack,
  slugify,
  writeCharacter,
  writeFileAtomic,
  writeManifest,
  writeMediaManifest,
  writeReadme,
} from './write.js';
export type { AddAssetOptions, ScaffoldOptions } from './write.js';

export {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  extractPack,
  packDirectory,
  readManifestFromArchive,
} from './archive.js';
