import type { CapabilityModuleSpec } from '@rp/shared';

export const filesModule: CapabilityModuleSpec = {
  id: 'files',
  version: '1.0.0',
  title: 'Character files',
  summary: 'Your own folder on disk: keep notes, diaries, drafts and generated files, and open them for the user.',
  permission: 'pack',
  apiTypeName: 'FilesApi',
  typings: `/**
 * A private home directory for this character (the user can browse it). Paths are relative to
 * that folder with forward slashes; ".." and absolute paths are rejected (PATH_ESCAPE).
 * Text only, UTF-8, up to 5 MB per file and 200 files. For the user's own files use sdk.system.
 */
interface FilesApi {
  /**
   * Create or overwrite a text file (parent folders are created).
   * @param path Relative path, e.g. "diary/2025-06-01.md".
   * @param text Full content.
   * @example await sdk.files.write("diary/" + today + ".md", entry);
   */
  write(path: string, text: string): Promise<void>;
  /** Append text to a file (created if missing). Good for logs and running diaries. */
  append(path: string, text: string): Promise<void>;
  /**
   * Read a text file. Throws NOT_FOUND if it does not exist.
   * @param path Relative path.
   * @param maxBytes Truncate after this many bytes. Default 65536.
   */
  read(path: string, maxBytes?: number): Promise<string>;
  /**
   * List files, optionally under a folder prefix, sorted by path.
   * @param prefix e.g. "diary/". Omit for everything.
   * @returns Relative path, size and ISO modification time of each file.
   */
  list(prefix?: string): Promise<Array<{ path: string; bytes: number; modifiedAt: string }>>;
  /**
   * Delete a file.
   * @returns true if it existed.
   */
  delete(path: string): Promise<boolean>;
  /**
   * Open a file with the user's default application (e.g. show a poem in their editor, a generated .html in their browser).
   * @param path Relative path of an existing file.
   * @example await sdk.files.write("poem.txt", poem); await sdk.files.open("poem.txt");
   */
  open(path: string): Promise<void>;
  /** Absolute path of your home folder on disk (for telling the user where things are). */
  homePath(): Promise<string>;
}`,
  docs: `Your own folder for things that outlive a chat: a diary, drafts, lists, exported notes. Requires the \`files\` capability. Paths are relative to that folder; nothing outside it is reachable.

- \`sdk.state\`/\`sdk.memory\` are for facts you look up; \`files\` is for documents — things the user might open, read or keep.
- \`open(path)\` hands a file to the user's default app, so write it first, then open it. Tell the user where it is (\`homePath()\`).
- Prefer \`append\` for logs/diaries and keep files small; list before writing to avoid clobbering.
- \`open()\` throws NOT_FOUND for a missing file and CAPABILITY_FAILED when the desktop has no application for it (the message says why).

\`\`\`ts
const day = new Date().toISOString().slice(0, 10);
await sdk.files.append("diary.md", "\\n## " + day + "\\n" + note + "\\n");
return { path: (await sdk.files.homePath()) + "/diary.md" };
\`\`\``,
  methods: {
    write: { description: 'Write a text file in the character home.' },
    append: { description: 'Append text to a file in the character home.' },
    read: { description: 'Read a text file from the character home.' },
    list: { description: 'List files in the character home.' },
    delete: { description: 'Delete a file from the character home.' },
    open: { description: "Open a character file with the user's default application.", dangerous: true },
    homePath: { description: 'Absolute path of the character home folder.' },
  },
};
