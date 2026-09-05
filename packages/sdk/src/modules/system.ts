import type { CapabilityModuleSpec } from '@rp/shared';

export const systemModule: CapabilityModuleSpec = {
  id: 'system',
  version: '1.1.0',
  title: 'System access',
  summary: 'Open links, run commands, read/write files and read/write the clipboard on the host PC; each call needs user approval.',
  permission: 'prompt',
  apiTypeName: 'SystemApi',
  typings: `/**
 * Act on the host computer. EVERY call shows the user a confirmation dialog with the
 * exact method and arguments; if they decline, the call throws PERMISSION_PROMPT_REJECTED.
 * Only use this when the user explicitly asked for the effect, and explain what you
 * are about to do first. Never chain many system calls in one action.
 */
interface SystemApi {
  /**
   * Open a web page in the user's default browser. http/https only.
   * @param url Absolute URL, e.g. "https://example.com/recipe".
   * @example await sdk.system.openExternal("https://en.wikipedia.org/wiki/Tea");
   */
  openExternal(url: string): Promise<void>;
  /**
   * Run a program and wait for it to exit. Not a shell: pass the executable and its
   * arguments separately (no pipes, globs or quoting). Output is truncated to 64 KiB.
   * @param command Executable name or path, e.g. "python3".
   * @param args Argument list, e.g. ["script.py", "--fast"].
   * @param opts timeoutMs (default 30000, max 300000) and cwd (working directory).
   * @returns Exit code plus captured stdout and stderr.
   * @example const r = await sdk.system.exec("date", ["+%A"]); return r.stdout.trim();
   */
  exec(command: string, args?: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Read a text file from the user's computer as UTF-8.
   * @param path Absolute path (or ~ for the home directory).
   * @param maxBytes Truncate after this many bytes. Default 65536.
   * @example const notes = await sdk.system.readFile("~/notes/today.md");
   */
  readFile(path: string, maxBytes?: number): Promise<string>;
  /**
   * Write (create or overwrite) a UTF-8 text file on the user's computer.
   * @param path Absolute path (or ~ for the home directory).
   * @param text Full file content.
   * @example await sdk.system.writeFile("~/Desktop/poem.txt", poem);
   */
  writeFile(path: string, text: string): Promise<void>;
  /**
   * Put text on the system clipboard.
   * @param text The text to copy.
   * @example await sdk.system.clipboardWrite("https://example.com/the-link");
   */
  clipboardWrite(text: string): Promise<void>;
  /**
   * Read the text currently on the system clipboard (empty string if it holds no text).
   * Clipboards often contain passwords or private snippets: only read it when the user asked you to.
   * @example const clip = await sdk.system.clipboardRead(); return { chars: clip.length };
   */
  clipboardRead(): Promise<string>;
}`,
  docs: `Reach outside the app: open a link, run a program, read or write a file, copy to the clipboard. Requires the \`system\` capability **and** the user confirms every single call in a dialog.

- Use only when the user clearly asked for the effect (or a pack script needs it), and tell them what you are about to do. A declined dialog throws \`PERMISSION_PROMPT_REJECTED\` — accept the refusal, do not retry.
- One system call per action is the norm. \`exec\` is not a shell: give the program and its arguments separately.
- File paths are absolute (or \`~/...\`). Never touch files the user did not mention.

\`\`\`ts
await sdk.system.writeFile("~/Desktop/shopping-list.txt", list.join("\\n"));
return { saved: true };
\`\`\``,
  methods: {
    openExternal: { description: 'Open a URL in the default browser.', dangerous: true },
    exec: { description: 'Run a program on the host and capture its output.', dangerous: true },
    readFile: { description: 'Read a text file from the host.', dangerous: true },
    writeFile: { description: 'Write a text file on the host.', dangerous: true },
    clipboardWrite: { description: 'Write text to the system clipboard.', dangerous: true },
    clipboardRead: { description: 'Read text from the system clipboard.', dangerous: true },
  },
};
