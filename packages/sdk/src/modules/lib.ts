import type { CapabilityModuleSpec } from '@rp/shared';

export const libModule: CapabilityModuleSpec = {
  id: 'lib',
  version: '1.0.0',
  title: 'Function library',
  summary: 'Save your own reusable functions once and call them as lib.<name>(...) from any later action, timer or event handler.',
  permission: 'trusted',
  apiTypeName: 'LibApi',
  typings: `/** A saved library function, as returned by sdk.lib.define() / sdk.lib.list(). */
interface LibFunctionInfo {
  /** Call it as lib.<name>(...). */
  name: string;
  description?: string;
  /** Size of its source in bytes. */
  bytes: number;
  /** ISO-8601 time of the last define. */
  updatedAt: string;
}

/**
 * Your own function library. Define a function once; from then on every action, timer handler and
 * event handler of yours sees it as the global lib.<name>, across sessions and app restarts. Each
 * function is saved as a file in your pack (characters/<id>/lib/<name>.ts), where your author may
 * also have shipped some. The library is listed in your prompt under <library> (one line each: name,
 * parameters and description — never the body). Max 50 functions per character.
 */
interface LibApi {
  /**
   * Save (or replace) a function under \`name\`. Call it later as lib.<name>(...) from any action, timer or
   * event handler; it persists across sessions.
   * @param name A JavaScript identifier (max 64 chars, no reserved words).
   * @param fn Write it as a function (arrow or \`async function\`); it may be async, may take any arguments and
   *   may use \`sdk\` and \`lib\` (your other functions) — but nothing else from the action defining it: no
   *   variables, no helpers declared above it. (A string holding a function expression also works.)
   * @param opts description: one line saying what it is for, shown in <library>.
   * @throws INVALID_ARGUMENT when the name is reserved by one of your pack's own helpers; pick another.
   * @example await sdk.lib.define("cheer", async (mood: string) => {
   *   const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
   *   if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
   *   return Boolean(pic);
   * }, { description: "show a picture for a mood" });
   */
  define(name: string, fn: ((...args: any[]) => unknown) | string, opts?: { description?: string }): Promise<LibFunctionInfo>;
  /**
   * Delete a function from the library.
   * @returns true if it existed.
   */
  remove(name: string): Promise<boolean>;
  /** Every function in the library (also listed in your prompt under <library>). */
  list(): Promise<LibFunctionInfo[]>;
  /**
   * The source of one function as it stands in its file, e.g. to read it before changing it. Throws NOT_FOUND.
   * A very large function can push the action's return value past its result cap; return what you need of it, not the whole source.
   */
  source(name: string): Promise<string>;
}`,
  docs: `Keep the steps you repeat as functions instead of rewriting them. Once defined, \`lib.<name>\` is a global in every later action, timer handler and event handler, for this character, forever (until you \`remove\` it). Redefining a name replaces it.

- A library function may be async and may call \`sdk\` and other \`lib\` functions, but it closes over **nothing** from the action that defined it: pass what it needs as arguments.
- Your prompt lists the library under \`<library>\` with each function's parameters; read \`sdk.lib.source(name)\` when you need the details before changing one.
- Functions live in your pack as \`characters/<id>/lib/<name>.ts\` (a \`// description\` line, then the function); some may have been shipped by your author, the rest you saved. \`define\` writes the file, \`remove\` deletes it.
- Prefer one clear function per repeated routine; the library is not a place for state (use \`sdk.state\` / \`sdk.memory\`).
- Your author may have shipped plumbing of their own in that folder that is not yours to call or replace: it is not listed anywhere and \`define\` refuses its name (\`lib.<name> is reserved by this pack\`).

\`\`\`ts
await sdk.lib.define("cheer", async (mood: string) => {
  const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}, { description: "show a picture for a mood" });
// in a later action:
await lib.cheer("happy");
\`\`\``,
  methods: {
    define: { description: 'Save or replace a library function.' },
    remove: { description: 'Delete a library function.' },
    list: { description: 'List the library functions.' },
    source: { description: 'Source of one library function.' },
  },
};
