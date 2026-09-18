/**
 * Monaco, set up once for the code this app edits: a character's TypeScript against the
 * SDK it will really run with, and JSON.
 *
 * The typings come from `capabilities.typings()` — the same generated `sdk.d.ts` the model
 * is shown and the Settings → SDK reference tab prints — so completion, hovers and type
 * errors here describe the modules this install actually has, plugins included, and cannot
 * drift from what the sandbox accepts.
 *
 * Only the pieces we use are imported: `editor.main` would also carry the tokenizers of
 * eighty languages nobody edits here, while the TypeScript and JSON language features bring
 * the editor's own contributions (suggestions, hovers, find, folding) along with them.
 *
 * The language services run in web workers, and our renderer is a `file://` page. Under the
 * app's CSP (script-src 'self', no worker-src) Chromium refuses to start a worker from a
 * `blob:` or `data:` URL but accepts a sibling `file://` script, which is exactly what
 * Vite's `?worker` import produces: one chunk per worker, next to the bundle. Those chunks
 * are big — TypeScript's carries the compiler and every `lib.*.d.ts` — so nothing in this
 * module is fetched until a code box is on screen and something calls `loadMonaco()`.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import { ModuleKind, ScriptTarget, getTypeScriptWorker, typescriptDefaults } from 'monaco-editor/languages/features/typescript/register';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import 'monaco-editor/languages/definitions/typescript/register';
import { api } from '../api';

export type MonacoApi = typeof monaco;
export type CodeEditorInstance = monaco.editor.IStandaloneCodeEditor;
export type CodeModel = monaco.editor.ITextModel;

/** One worker per language service; anything else Monaco asks for is its own editor worker. */
const WORKERS: Record<string, new (options?: { name?: string }) => Worker> = {
  typescript: TsWorker,
  javascript: TsWorker,
  json: JsonWorker,
};

/**
 * Compiler errors that are right about the file and wrong about the code. Everything the
 * author writes in these boxes is spliced into something larger before it runs: a script
 * is the body of an async function (`return` is how it answers, see
 * packages/sandbox/src/transpile.ts) and a library file is one function expression. Left
 * alone, TypeScript would underline the shape of every one of them.
 */
const IGNORED_DIAGNOSTICS = [
  1108, // "A 'return' statement can only be used within a function body."
  1375, // "'await' expressions are only allowed at the top level of a file when that file is a module."
  1378, // "Top-level 'await' expressions are only allowed when the 'module' option is set to ..."
];

/**
 * The globals the host binds that are not part of the SDK surface, so no generated typing
 * declares them. `input` is prepended to the code as `const input = <json>;` by the
 * behaviour runner (packages/core/src/behaviours.ts) — the Input field in the Sandbox, or
 * the payload of the event that triggered a hook.
 */
const HOST_GLOBAL_TYPINGS = `/**
 * What this run was given: the Sandbox's Input field, or the trigger's payload
 * (e.g. { event, data } for an event handler). \`null\` when there is none.
 */
declare const input: any;
`;

const SDK_TYPINGS_FILE = 'file:///sdk.d.ts';
const HOST_TYPINGS_FILE = 'file:///host-globals.d.ts';
/** Redefined from the app's own CSS custom properties whenever the theme changes. */
const THEME = 'rp-code';

let loading: Promise<MonacoApi> | undefined;

/** Monaco, configured, loaded at most once however many code boxes ask for it. */
export function loadMonaco(): Promise<MonacoApi> {
  loading ??= configure();
  return loading;
}

async function configure(): Promise<MonacoApi> {
  (globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    getWorker: (_moduleId, label) => new (WORKERS[label] ?? EditorWorker)({ name: label }),
  };

  typescriptDefaults.setCompilerOptions({
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    // Every box is a file of its own to the type checker, and they are open at the same
    // time (the five behaviour hooks, say). Without this each would be a global script and
    // a `const` two of them happen to share would be a redeclaration error in both.
    moduleDetection: 3 /* ts.ModuleDetectionKind.Force */,
    // No DOM: a script runs in a QuickJS isolate, where the only globals are the ones
    // below. This also leaves `console` to the SDK's own declaration of it.
    lib: ['esnext'],
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
  });
  typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // Suggestions are the faint "declared but never read" kind, and they are wrong here: the
    // `return` that uses a value is itself a statement TypeScript does not count (it belongs to
    // the function this code becomes), so the value it returns reads as unused.
    noSuggestionDiagnostics: true,
    diagnosticCodesToIgnore: IGNORED_DIAGNOSTICS,
  });
  // The worker resolves a model by URI, so it needs every open model, not just the focused one.
  typescriptDefaults.setEagerModelSync(true);
  jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: false, enableSchemaRequest: false, schemas: [] });

  applyThemeColors();
  watchTheme();
  await setSdkTypings();
  return monaco;
}

/**
 * Put the generated `sdk.d.ts` in front of the type checker. Called again when the
 * capability registry changes (a plugin adding or dropping modules), which is the only way
 * the surface moves while the app is running. The editor is still worth having without it,
 * so a failure here is reported and swallowed.
 */
export async function refreshSdkTypings(): Promise<void> {
  if (loading !== undefined) await setSdkTypings();
}

async function setSdkTypings(): Promise<void> {
  const libs = [{ content: HOST_GLOBAL_TYPINGS, filePath: HOST_TYPINGS_FILE }];
  try {
    libs.unshift({ content: await api().capabilities.typings(), filePath: SDK_TYPINGS_FILE });
  } catch (err) {
    console.error('[monaco] SDK typings unavailable: the editor has no completion for sdk.*', err);
  }
  typescriptDefaults.setExtraLibs(libs);
}

/** True when the app is currently painting its dark palette (`data-theme`, else the system's). */
function isDark(): boolean {
  const attribute = document.documentElement.getAttribute('data-theme');
  if (attribute === 'dark') return true;
  if (attribute === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** A CSS custom property, when it holds a plain hex colour — the only kind Monaco parses. */
function cssColor(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : undefined;
}

/**
 * Dress Monaco in the app's own colours. Only the current palette is readable (the custom
 * properties resolve to one theme at a time), so the theme is redefined under the same name
 * every time the palette changes rather than defined once per theme.
 */
function applyThemeColors(): void {
  const styles = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  const use = (key: string, property: string): void => {
    const color = cssColor(styles, property);
    if (color) colors[key] = color;
  };
  use('editor.background', '--bg-elev');
  use('editor.foreground', '--fg');
  use('editorGutter.background', '--code-bg');
  use('editorLineNumber.foreground', '--fg-muted');
  use('editorLineNumber.activeForeground', '--fg');
  use('editorWidget.background', '--bg-elev');
  use('editorWidget.border', '--border');
  use('editorSuggestWidget.background', '--bg-elev');
  use('editorSuggestWidget.border', '--border');
  use('editorHoverWidget.background', '--bg-elev');
  use('editorHoverWidget.border', '--border');
  use('focusBorder', '--accent');
  monaco.editor.defineTheme(THEME, { base: isDark() ? 'vs-dark' : 'vs', inherit: true, rules: [], colors });
  monaco.editor.setTheme(THEME);
}

/** Follow the theme: the Settings switch writes `data-theme`, "system" follows the OS. */
function watchTheme(): void {
  new MutationObserver(applyThemeColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeColors);
}

/** The editor options every code box shares; the caller adds the model and what differs. */
export function editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
  return {
    theme: THEME,
    fontFamily: mono || undefined,
    fontSize: 12.5,
    lineHeight: 19,
    tabSize: 2,
    insertSpaces: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // The boxes sit in panels that clip their overflow; widgets go to the body instead.
    fixedOverflowWidgets: true,
    // A short editor in a long page must not swallow the page's scrolling.
    scrollbar: { alwaysConsumeMouseWheel: false },
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    renderLineHighlight: 'line',
    padding: { top: 8, bottom: 8 },
    wordWrap: 'off',
    suggest: { showWords: false },
  };
}

/**
 * How the headful smoke run (dev-mode.ts) proves the editor works end to end: an answer
 * only comes back if Monaco loaded, its TypeScript worker started — a `file://` worker, the
 * one kind the CSP allows — and the generated `sdk.d.ts` reached it. It asks about a
 * throwaway model of its own and changes nothing.
 */
async function completionProbe(source: string, offset: number): Promise<string[]> {
  await loadMonaco();
  const model = monaco.editor.createModel(source, 'typescript', monaco.Uri.parse(`inmemory://rp/probe-${Date.now()}.ts`));
  try {
    const client = await (await typeScriptWorker())(model.uri);
    const completions = (await client.getCompletionsAtPosition(model.uri.toString(), offset)) as { entries?: Array<{ name: string }> } | undefined;
    return (completions?.entries ?? []).map((entry) => entry.name);
  } finally {
    model.dispose();
  }
}

/**
 * Monaco sets the TypeScript mode up the first time a model claims that language, and does
 * it through an `import()`, so asking for the worker in the same breath as creating the
 * model loses the race (it rejects with "TypeScript not registered!"). Wait for it.
 */
async function typeScriptWorker(): Promise<Awaited<ReturnType<typeof getTypeScriptWorker>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getTypeScriptWorker();
    } catch (err) {
      if (attempt >= 50) throw err instanceof Error ? err : new Error(String(err));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

(globalThis as { __rpCompletionProbe?: typeof completionProbe }).__rpCompletionProbe = completionProbe;
