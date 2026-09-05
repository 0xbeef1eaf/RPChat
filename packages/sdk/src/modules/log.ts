import type { CapabilityModuleSpec } from '@rp/shared';

export const logModule: CapabilityModuleSpec = {
  id: 'log',
  version: '1.0.0',
  title: 'Logging',
  summary: 'Debug output captured into the action result (console.* maps here).',
  permission: 'trusted',
  apiTypeName: 'LogApi',
  typings: `/**
 * Debug output. Entries are captured into the action result you receive back
 * (and the app's action log); the user does not see them in the chat.
 * The global console.log/debug/info/warn/error map onto these methods.
 * Non-string arguments are JSON-stringified. Output is capped at 16 KiB per action.
 */
interface LogApi {
  /** Verbose diagnostics. @example sdk.log.debug("assets", assets.length); */
  debug(...args: unknown[]): void;
  /** Informational note about what the action did. */
  info(...args: unknown[]): void;
  /** Something unexpected but recoverable happened. */
  warn(...args: unknown[]): void;
  /** Something failed; include the error message or object. @example sdk.log.error("no image", err); */
  error(...args: unknown[]): void;
}`,
  docs: `Diagnostic output. Everything logged comes back to you in the action result; the user never sees it in the chat.

- \`console.log(...)\` is the same as \`sdk.log.info(...)\`. These calls are synchronous (no \`await\` needed).
- Prefer \`return\` for data you actually need; use logs for values that help you understand what happened.
- Output is truncated after 16 KiB, so do not dump large arrays or file contents.

\`\`\`ts
const assets = await sdk.pack.listAssets("media/images");
sdk.log.info("found", assets.length, "images");
\`\`\``,
  methods: {
    debug: { description: 'Log at debug level.' },
    info: { description: 'Log at info level.' },
    warn: { description: 'Log at warn level.' },
    error: { description: 'Log at error level.' },
  },
};
