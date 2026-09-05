import type { CapabilityModuleSpec, SdkSurface } from '@rp/shared';
import { SDK_PREAMBLE_TYPINGS } from './preamble.js';
import type { CapabilityRegistry } from './registry.js';

export interface GenerateTypingsOptions {
  /** Only include these modules (granted ones). Omit for all registered modules. Unknown ids are ignored. */
  modules?: string[];
}

export interface GenerateDocsOptions extends GenerateTypingsOptions {
  /** Modules to list as "not available" (denied / not granted). */
  deniedModules?: string[];
}

export type DescribeSurfaceOptions = GenerateTypingsOptions;

export const TYPINGS_HEADER = '// ---- rp-code character SDK (generated) ----';

/** Typings for the `console` global inside the sandbox, which maps onto `sdk.log`. */
export const CONSOLE_TYPINGS = `/**
 * Console output is captured into the action result that comes back to you (same as sdk.log);
 * nothing is printed on the user's screen. Use it for debugging values.
 */
declare const console: {
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};`;

function selectModules(registry: CapabilityRegistry, modules?: string[]): CapabilityModuleSpec[] {
  const all = registry.list();
  if (!modules) return all;
  const allowed = new Set(modules);
  return all.filter((m) => allowed.has(m.id));
}

/**
 * Emit the global `sdk.d.ts` text: preamble helper types, `declare const sdk: Sdk`,
 * the `Sdk` interface (one property per selected module), the `console` global,
 * then every module's `typings` verbatim under a banner. The result is a
 * self-contained, import-free declaration file that compiles against `lib.es2022`.
 */
export function generateSdkTypings(registry: CapabilityRegistry, options: GenerateTypingsOptions = {}): string {
  const specs = selectModules(registry, options.modules);
  const out: string[] = [TYPINGS_HEADER, SDK_PREAMBLE_TYPINGS.trimEnd(), ''];

  out.push('/** The SDK available to character code as the global `sdk`. */');
  out.push('declare const sdk: Sdk;');
  out.push('interface Sdk {');
  for (const spec of specs) {
    out.push(`  /** ${spec.summary.trim()} (permission: ${spec.permission}) */`);
    out.push(`  ${spec.id}: ${spec.apiTypeName};`);
  }
  out.push('}', '', CONSOLE_TYPINGS);

  for (const spec of specs) {
    out.push('', `// ---- module: ${spec.id} v${spec.version} ----`, spec.typings.trim());
  }
  out.push('');
  return out.join('\n');
}

/** General rules that precede the module docs in the prompt. */
export const GENERAL_DOCS = `# Acting with the SDK

You act by running TypeScript through the \`run_action\` tool (or, if tools are unavailable, a fenced \`\`\`action block). Rules:

- Your code is the **body of an async function**. \`sdk\` and \`console\` are globals. There is no \`import\`, \`require\`, \`fetch\`, \`setTimeout\` or DOM.
- \`await\` every \`sdk\` call (all return promises, except \`sdk.log.*\`).
- \`return\` a small JSON value if you need data back; it comes to you as the action result together with console output and any error. Then you continue your reply.
- Prefer **one action per intention**, a few calls each. Do not write speculative code "just in case".
- Never busy-wait or loop until something happens: an action has about 10 seconds and 50 sdk calls. To do something later, use \`sdk.timers.schedule\`.
- sdk errors are thrown as \`Error\` with a \`code\` (\`NOT_FOUND\`, \`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\`, ...). Let them propagate unless you can recover meaningfully.
- Do not narrate the code you run. Talk to the user in your normal text (or \`sdk.chat.say\`); keep actions invisible unless asked.`;

/**
 * Emit the markdown the prompt builder injects after the typings: general
 * rules, then each selected module's `docs` under a heading with its
 * permission, then the list of denied (unavailable) modules.
 */
export function generateSdkDocs(registry: CapabilityRegistry, options: GenerateDocsOptions = {}): string {
  const specs = selectModules(registry, options.modules);
  const sections: string[] = [GENERAL_DOCS];

  for (const spec of specs) {
    const lines = [`## sdk.${spec.id} — ${spec.title} (permission: ${spec.permission})`];
    if (spec.permission === 'prompt') {
      lines.push(
        '', '**Every call of this module shows the user a confirmation dialog** with the method and arguments; the call fails with `PERMISSION_PROMPT_REJECTED` if they decline. Use it sparingly and only when the user asked for the effect.',
      );
    }
    if (spec.permission !== 'prompt') {
      const prompted = Object.entries(spec.methods)
        .filter(([, m]) => m.permission === 'prompt')
        .map(([name]) => `\`${name}\``);
      if (prompted.length > 0) {
        lines.push('', `Methods that ask the user for confirmation on each call (unless covered by an allowlist in their settings): ${prompted.join(', ')}.`);
      }
      const dangerous = Object.entries(spec.methods)
        .filter(([, m]) => m.dangerous)
        .map(([name]) => `\`${name}\``);
      if (dangerous.length > 0) {
        lines.push('', `Methods with effects outside the app (use with care): ${dangerous.join(', ')}.`);
      }
    }
    lines.push('', spec.docs.trim());
    sections.push(lines.join('\n'));
  }

  const denied = (options.deniedModules ?? []).filter((id, i, arr) => arr.indexOf(id) === i);
  if (denied.length > 0) {
    sections.push(
      [
        '## Not available',
        '',
        `These modules are **not granted** in this session and do not exist on \`sdk\`: ${denied.map((d) => `\`sdk.${d}\``).join(', ')}.`,
        'Do not call them. If the user asks for something that needs one, explain that the capability is not enabled for this pack.',
      ].join('\n'),
    );
  }

  return sections.join('\n\n') + '\n';
}

/**
 * The compact module → method-name list the sandbox uses to build the `sdk`
 * proxy inside the isolate. Nested members appear dotted (`session.get`).
 */
export function describeSurface(registry: CapabilityRegistry, options: DescribeSurfaceOptions = {}): SdkSurface {
  return {
    modules: selectModules(registry, options.modules).map((spec) => ({
      id: spec.id,
      methods: Object.keys(spec.methods),
    })),
  };
}
