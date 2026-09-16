import type { CapabilityModuleSpec } from '@rp/shared';

/**
 * `lib` — the character's own function library. Unlike every other module this
 * one is not a separate namespace on `sdk`: the sandbox makes `sdk.lib` the very
 * `lib` object the prelude defines (bootstrap: `__rp_lib`), so `sdk.lib.cheer()`
 * and `lib.cheer()` are the same call and a character that reaches for the wrong
 * one still gets what it meant. Only `register` / `unregister` cross to the host.
 */
export const libModule: CapabilityModuleSpec = {
  id: 'lib',
  version: '2.0.0',
  title: 'Function library',
  summary: 'Your own saved functions — the same object as the global `lib`: call them as lib.<name>(...) and save new ones with lib.register().',
  permission: 'trusted',
  apiTypeName: 'LibApi',
  typings: `/** A saved library function, as returned by lib.register(). */
interface LibFunctionInfo {
  /** Call it as lib.<name>(...). */
  name: string;
  description?: string;
  /** An internal helper: your other library functions can call it, your action code cannot. */
  internal?: boolean;
  /** Size of its source in bytes. */
  bytes: number;
  /** ISO-8601 time of the last register. */
  updatedAt: string;
}

/**
 * Your own function library, as the global \`lib\` (\`sdk.lib\` is the same object, so
 * \`lib.cheer(...)\` and \`sdk.lib.cheer(...)\` are one and the same call). Every member
 * apart from \`register\` and \`unregister\` is a function you or your author saved:
 * call it as \`lib.<name>(...)\`. Registering one persists it across sessions and app
 * restarts — each is a file in your pack (characters/<id>/lib/<name>.ts). The library
 * is listed in your prompt under <library> (one line each: name, parameters and
 * description — never the body); \`String(lib.<name>)\` gives you the source of one and
 * \`Object.keys(lib)\` the names. Max 50 functions per character.
 */
interface LibApi {
  /**
   * Save (or replace) a function under \`name\`. Call it afterwards as lib.<name>(...) from any
   * action, timer or event handler — including this one, from the next action on; it persists
   * across sessions.
   * @param name A JavaScript identifier (max 64 chars, no reserved words, not \`register\` or \`unregister\`).
   * @param fn Write it as a function (arrow or \`async function\`); it may be async, may take any arguments and
   *   may use \`sdk\` and \`lib\` (your other functions) — but nothing else from the action defining it: no
   *   variables, no helpers declared above it. (A string holding a function expression also works.)
   * @param opts description: one line saying what it is for, shown in <library>. internal: true keeps it out
   *   of <library> and out of the \`lib\` your action code sees — only your other library functions reach it.
   * @throws INVALID_ARGUMENT when the name is reserved by one of your pack's own helpers; pick another.
   * @example await lib.register("cheer", async (mood: string) => {
   *   const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
   *   if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
   *   return Boolean(pic);
   * }, { description: "show a picture for a mood" });
   */
  register(name: string, fn: ((...args: any[]) => unknown) | string, opts?: { description?: string; internal?: boolean }): Promise<LibFunctionInfo>;
  /**
   * Delete a function from the library.
   * @returns true if it existed.
   */
  unregister(name: string): Promise<boolean>;
  /** Every other member is one of your saved functions: \`await lib.<name>(...)\`. */
  [name: string]: (...args: any[]) => any;
}`,
  docs: `Keep the steps you repeat as functions instead of rewriting them. \`lib.<name>\` is a global in every action, timer handler and event handler, for this character, forever (until you \`unregister\` it). Registering a name again replaces it.

- \`sdk.lib\` **is** the \`lib\` object, not a second API: \`sdk.lib.cheer(1)\` and \`lib.cheer(1)\` run the same saved function, and \`sdk.lib.register\` is \`lib.register\`. There is no \`sdk.lib.define\`.
- A library function may be async and may call \`sdk\` and other \`lib\` functions, but it closes over **nothing** from the action that registered it: pass what it needs as arguments.
- Your prompt lists the library under \`<library>\` with each function's parameters; \`String(lib.<name>)\` is its source, e.g. to read it before changing it, and \`Object.keys(lib)\` are the names.
- Functions live in your pack as \`characters/<id>/lib/<name>.ts\` (a \`// description\` line, then the function); some may have been shipped by your author, the rest you saved. \`register\` writes the file, \`unregister\` deletes it.
- Prefer one clear function per repeated routine; the library is not a place for state (use \`sdk.state\` / \`sdk.memory\`).
- \`{ internal: true }\` saves a helper your other library functions can call while it stays out of \`<library>\` and out of the \`lib\` your action code sees. Your author may have shipped plumbing of their own that way: it is not yours to call or replace, and \`register\` refuses its name (\`lib.<name> is reserved by this pack\`) unless you pass \`internal: true\` yourself.

\`\`\`ts
await lib.register("cheer", async (mood: string) => {
  const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}, { description: "show a picture for a mood" });
// in a later action:
await lib.cheer("happy");
\`\`\``,
  methods: {
    register: { description: 'Save or replace a library function.' },
    unregister: { description: 'Delete a library function.' },
  },
};
