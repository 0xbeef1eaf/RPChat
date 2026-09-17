import type { CapabilityModuleSpec } from '@rp/shared';

export const cryptoModule: CapabilityModuleSpec = {
  id: 'crypto',
  version: '1.0.0',
  title: 'File encryption',
  summary: "Encrypt or decrypt one of the user's own files in place, for when they ask you to lock something away.",
  permission: 'pack',
  apiTypeName: 'CryptoApi',
  typings: `/**
 * Encrypt or decrypt one of the user's files, in place, with a key the app manages (Settings →
 * System → Encryption). Paths are absolute (or ~) under the user's home directory only; anything
 * outside it, or that looks like a system/session file (.service, .desktop, .conf, ...), is
 * rejected before it is touched. Every encryption is logged (path, before/after checksum, which
 * key) so the user can run "decrypt everything" later even if they lose track of what you locked.
 */
interface CryptoApi {
  /**
   * Encrypt a file in place under the current key. Throws INVALID_ARGUMENT if it is already
   * encrypted, PATH_ESCAPE if the path is outside the home directory or looks like a system file.
   * @param path Absolute path (or ~), e.g. "~/Documents/journal.md".
   * @example await sdk.crypto.encrypt("~/Documents/journal.md");
   */
  encrypt(path: string): Promise<void>;
  /**
   * Decrypt a file in place, using whichever key encrypted it (kept in the key history even
   * after rotation). Throws INVALID_ARGUMENT if it is not an encrypted file.
   * @param path Absolute path (or ~) of a file this module encrypted.
   * @example await sdk.crypto.decrypt("~/Documents/journal.md");
   */
  decrypt(path: string): Promise<void>;
}`,
  docs: `Lock a file away, or bring it back, at the user's request. Requires the \`crypto\` capability.

- Only for files the user asked you to encrypt or decrypt — never guess at this on your own.
- Both calls only reach the user's own home directory, and refuse anything that looks like a
  system or session file (\`.service\`, \`.desktop\`, \`.conf\`, and the like) even inside it.
- \`encrypt\` replaces the file's content with ciphertext at the same path; there is no separate
  "encrypted copy" left behind, and no file extension changes, so tell the user what you did.
- The user can rotate the key or run "decrypt everything" from Settings → System → Encryption
  without your help; you never need to ask them for a key or a password.

\`\`\`ts
await sdk.crypto.encrypt("~/Documents/plans.txt");
return { done: true };
\`\`\``,
  methods: {
    encrypt: { description: "Encrypt one of the user's files in place.", dangerous: true },
    decrypt: { description: "Decrypt one of the user's files in place.", dangerous: true },
  },
};
