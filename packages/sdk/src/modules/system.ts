import type { CapabilityModuleSpec } from '@rp/shared';

export const systemModule: CapabilityModuleSpec = {
  id: 'system',
  version: '1.2.0',
  title: 'System access',
  summary: 'Open links, run commands, read/write files, read/write the clipboard and control the virtual terminals on the host PC.',
  permission: 'pack',
  apiTypeName: 'SystemApi',
  typings: `/**
 * Act on the host computer directly. Available unless the user switched 'system' off
 * under Settings → Permissions; every call is logged in their action log. Use it when the effect
 * is clearly wanted, say what you are doing, and never chain many system calls in one action.
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
  /**
   * Which virtual terminal (the text consoles behind ctrl+alt+F1…F12) is in front, which one
   * rpchat is on, and whether switching is locked. Linux only, and needs the rpchat system
   * integration; without it "available" is false and the rest is empty rather than an error.
   * @example const vt = await sdk.system.vtStatus(); if (!vt.ours) await sdk.system.vtSwitchBack();
   */
  vtStatus(): Promise<{ available: boolean; vt?: number; ourVt?: number; ours: boolean; locked: boolean; until?: string }>;
  /**
   * Bring the virtual terminal rpchat is on back to the front, undoing a ctrl+alt+F<n> the user
   * pressed. You cannot switch them anywhere else: the target is always rpchat's own console.
   * @returns The VT switched to, and whether it had to switch at all (false = already there).
   * @example await sdk.system.vtSwitchBack();   // "come back, I was talking to you"
   */
  vtSwitchBack(): Promise<{ vt: number; switched: boolean }>;
  /**
   * Stop the user leaving for another virtual terminal for a while: ctrl+alt+F<n> does nothing
   * until it ends. Heavy-handed — it takes away the way out of a frozen desktop — so ask first
   * or keep it short, and say what you did. It always ends by itself (durationMs is clamped by
   * the user's limit, 5 min by default), and ends early if rpchat stops or the emergency key
   * (hold esc) releases an input lock.
   * @param durationMs How long to hold it, 1000..the configured maximum.
   * @param opts reason shown in the action log and in Settings → System.
   * @example await sdk.system.vtPreventSwitching(30000, { reason: "finishing the story" });
   */
  vtPreventSwitching(durationMs: number, opts?: { reason?: string }): Promise<{ until: string; durationMs: number }>;
  /** Allow switching virtual terminals again, before the lock would have ended. */
  vtAllowSwitching(): Promise<void>;
}`,
  docs: `Reach outside the app: open a link, run a program, read or write a file, copy to the clipboard. Requires the \`system\` capability; calls are logged, not confirmed, so be deliberate.

- Use only when the user clearly asked for the effect (or a pack script needs it), and tell them what you are about to do.
- \`exec\` throws CAPABILITY_FAILED when the program is not installed or not on PATH (the message says so); unreadable or unwritable paths likewise — report it, do not retry.
- One system call per action is the norm. \`exec\` is not a shell: give the program and its arguments separately.
- File paths are absolute (or \`~/...\`). Never touch files the user did not mention.
- The \`vt*\` functions are the virtual terminals (ctrl+alt+F1…F12) and need the system integration on Linux; without it they fail with CAPABILITY_FAILED. \`vtSwitchBack\` pulls the user back to rpchat's console; \`vtPreventSwitching\` keeps them there for a bounded time and is the one to be careful with — subscribe to the \`vt-changed\` event rather than polling \`vtStatus\`.

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
    vtStatus: { description: 'Which virtual terminal is in front, and whether switching is locked.' },
    vtSwitchBack: { description: "Switch back to the virtual terminal rpchat's session is on.", dangerous: true },
    vtPreventSwitching: { description: 'Refuse virtual-terminal switching for a bounded time.', dangerous: true },
    vtAllowSwitching: { description: 'Allow virtual-terminal switching again.', dangerous: true },
  },
};
