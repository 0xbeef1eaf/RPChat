import type { CapabilityModuleSpec } from '@rp/shared';

export const uiModule: CapabilityModuleSpec = {
  id: 'ui',
  version: '1.2.0',
  title: 'User interface',
  summary: 'OS notifications; ask the user yes/no, multiple-choice or free-text questions; let them pick files or folders.',
  permission: 'pack',
  apiTypeName: 'UiApi',
  typings: `/**
 * Get the user's attention or ask a quick structured question. confirm(), choose() and
 * ask() open a small window in front of the user and block the action until it is
 * answered, so keep such actions small: ask, then act on the answer or return it.
 */
interface UiApi {
  /**
   * Show an operating-system notification (also works when the app is in the background).
   * Keep it short; it is for things worth interrupting the user for.
   * @param title Notification title (max 100 characters).
   * @param body Optional body text (max 300 characters).
   * @param opts urgency: how much of the user's attention this deserves.
   *   "low" is quiet (no sound) and may be shown only in the notification centre - for things
   *   the user can read whenever they like. "normal" (the default) makes a sound and disappears
   *   on its own. "critical" also stays on screen until the user dismisses it and can break
   *   through do-not-disturb - reserve it for things that go wrong if they are missed.
   *   Urgency is a hint: Linux honours all three, other desktops may ignore it.
   * @example await sdk.ui.notify("Luna", "Your tea has steeped long enough!");
   * @example await sdk.ui.notify("Luna", "Your train leaves in 5 minutes.", { urgency: "critical" });
   */
  notify(title: string, body?: string, opts?: { urgency?: "low" | "normal" | "critical" }): Promise<void>;
  /**
   * Ask a yes/no question in a window of its own, in front of whatever the user is doing.
   * @param question The question to show.
   * @returns true for yes, false for no (or when the user dismissed it).
   * @example const ok = await sdk.ui.confirm("Play the song I mentioned?");
   */
  confirm(question: string): Promise<boolean>;
  /**
   * Ask the user to pick one option from a list (in a window of its own).
   * @param question The question to show.
   * @param options 2 to 10 short labels.
   * @returns The chosen option string, or null if the user dismissed the dialog.
   * @example const drink = await sdk.ui.choose("What are you drinking?", ["tea", "coffee", "water"]);
   */
  choose(question: string, options: string[]): Promise<string | null>;
  /**
   * Ask the user to type something (a name, a URL, a longer note), in a window of its own.
   * @param question The question to show.
   * @param opts placeholder, defaultValue, multiline (textarea instead of a single line).
   * @returns The text (trimmed, may be empty), or null if the user dismissed the dialog.
   * @example const name = await sdk.ui.ask("What should I call your cat?", { placeholder: "Miso" });
   */
  ask(question: string, opts?: { placeholder?: string; defaultValue?: string; multiline?: boolean }): Promise<string | null>;
  /**
   * Open the native file picker so the user can hand you a file. You get absolute paths;
   * read them with sdk.system.readFile if the pack has that capability.
   * @param opts title; filters like [{ name: "Images", extensions: ["png","jpg"] }]; multiple to allow several.
   * @returns Absolute paths chosen, or null if the user cancelled.
   * @example const [photo] = (await sdk.ui.pickFile({ title: "Show me a photo", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] })) ?? [];
   */
  pickFile(opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multiple?: boolean }): Promise<string[] | null>;
  /**
   * Open the native folder picker.
   * @param opts title.
   * @returns The absolute folder path, or null if the user cancelled.
   * @example const dir = await sdk.ui.pickFolder({ title: "Where do you keep your music?" });
   */
  pickFolder(opts?: { title?: string }): Promise<string | null>;
}`,
  docs: `Notify the user outside the chat, or ask a quick structured question. Available unless the user switched \`ui\` off under Settings → Permissions.

- \`notify\` is an OS notification — useful when the user may not be looking at the chat (e.g. from a timer). Do not spam it.
- \`notify\` urgency: \`low\` is silent and unobtrusive, \`normal\` (default) makes a sound and times out, \`critical\` stays on screen until dismissed and can pierce do-not-disturb. Choose it from the message, not from how much you want to be noticed: a reminder is \`normal\`, "your build failed" is \`critical\`, "the song changed" is \`low\`. Only Linux is guaranteed to honour all three.
- \`confirm\` / \`choose\` / \`ask\` open a focused window and wait for the answer; the answer comes back into the same action, so you can act on it immediately. Prefer asking in normal conversation unless a structured choice makes the interaction clearer.
- A dismissed dialog (answered, or its window closed) returns \`false\` / \`null\` — handle it gracefully.
- \`notify\` throws CAPABILITY_FAILED where the OS has no notification service; say it in the chat instead.

\`\`\`ts
const pick = await sdk.ui.choose("Which one?", ["sunset", "forest", "city"]);
if (pick) await sdk.media.showImage(\`media/images/\${pick}.png\`, { durationMs: 10000 });
return { pick };
\`\`\``,
  methods: {
    notify: { description: 'Show an OS notification, optionally low or critical urgency.' },
    confirm: { description: 'Ask the user a yes/no question.' },
    choose: { description: 'Ask the user to pick one of several options.' },
    ask: { description: 'Ask the user to type a text answer.' },
    pickFile: { description: 'Let the user choose one or more files with the native picker.' },
    pickFolder: { description: 'Let the user choose a folder with the native picker.' },
  },
};
