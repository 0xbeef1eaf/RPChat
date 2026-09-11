import type { CapabilityModuleSpec } from '@rp/shared';

export const widgetsModule: CapabilityModuleSpec = {
  id: 'widgets',
  version: '1.0.0',
  title: 'Widgets',
  summary: 'Put small self-made HTML windows on the desktop (timers, notes, mini games) and talk to them.',
  permission: 'pack',
  apiTypeName: 'WidgetsApi',
  typings: `/**
 * Small floating windows whose content is HTML you write. The HTML runs in a sandboxed iframe
 * (scripts allowed; no network, no access to the app). Inside the widget, window.parent.postMessage(msg, "*")
 * raises the 'widget-message' event with data { widgetId, message } so your subscriptions can react;
 * messages you send with update({ postMessage }) arrive as a "message" event in the widget.
 */
interface WidgetsApi {
  /**
   * Open a widget (or replace one with the same id).
   * @param spec id: your own stable id (default generated); title: title bar text; html: full HTML document or fragment;
   *   width/height in px (default 320 x 240); plus overlay placement (monitor, position, x, y, layer, opacity, clickThrough).
   * @returns The widget's id and title.
   * @example await sdk.widgets.show({ id: "note", title: "Today", html: "<h2>Plan</h2><ul><li>walk</li></ul>", position: "top-right", width: 260, height: 180 });
   */
  show(spec: { id?: string; title?: string; html: string; width?: number; height?: number } & OverlayOptions): Promise<WidgetInfo>;
  /**
   * Change an open widget: replace its HTML, retitle it, or post a message to its script.
   * @param id Widget id.
   * @param patch html: new content (state inside the old page is lost); title; postMessage: Json delivered to the widget's "message" event.
   * @example await sdk.widgets.update("timer", { postMessage: { secondsLeft: 90 } });
   */
  update(id: string, patch: { html?: string; title?: string; postMessage?: Json }): Promise<void>;
  /** Close one widget. No error if it is already closed. */
  close(id: string): Promise<void>;
  /** Close all widgets of this character. */
  closeAll(): Promise<void>;
  /** Open widgets of this character. */
  list(): Promise<WidgetInfo[]>;
}`,
  docs: `Build tiny tools on the desktop: a countdown, a shared note, a mood board, a two-button poll. Requires the \`widgets\` capability.

- Write compact self-contained HTML with inline CSS/JS; there is no network inside the widget. Keep it readable at 300 px.
- Two-way talk: in the widget, \`parent.postMessage({ choice: "tea" }, "*")\` → subscribe with \`sdk.events.on("widget-message", async (input) => { ... }, { filter: { widgetId: "poll" } })\`. From you: \`update(id, { postMessage })\`.
- Use stable ids and \`closeAll()\` when the play is over; do not leave stale windows around.

\`\`\`ts
await sdk.widgets.show({ id: "poll", title: "Tea or coffee?", width: 240, height: 120, position: "bottom-left",
  html: '<button onclick="parent.postMessage({c:\\'tea\\'},\\'*\\')">Tea</button> <button onclick="parent.postMessage({c:\\'coffee\\'},\\'*\\')">Coffee</button>' });
await sdk.events.on("widget-message", async (input) => {
  await sdk.llm.wake({ reason: "poll answer: " + JSON.stringify(input.data) });
}, { filter: { widgetId: "poll" }, once: true });
\`\`\``,
  methods: {
    show: { description: 'Open or replace a widget window.' },
    update: { description: 'Update a widget (html, title or postMessage).' },
    close: { description: 'Close a widget.' },
    closeAll: { description: 'Close all widgets of the character.' },
    list: { description: 'List open widgets.' },
  },
};
