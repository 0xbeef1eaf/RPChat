import type { CapabilityModuleSpec } from '@rp/shared';

export const displayModule: CapabilityModuleSpec = {
  id: 'display',
  version: '1.0.0',
  title: 'Display information',
  summary: "Discover the user's monitors and what the overlay backend can do (read-only).",
  permission: 'trusted',
  apiTypeName: 'DisplayApi',
  typings: `/**
 * Read-only information about the user's screens and the overlay backend. Use it to decide
 * where and how to show media: which monitor, whether layers/opacity/click-through work.
 * Nothing here changes the screen; use sdk.media for that.
 */
interface DisplayApi {
  /**
   * List monitors with their logical geometry, scale, which one is primary and which holds the pointer.
   * @returns Monitors in backend order; index 0 is not necessarily the primary one.
   * @example const [m] = (await sdk.display.monitors()).filter(m => m.hasCursor);
   */
  monitors(): Promise<MonitorInfo[]>;
  /**
   * Describe the active display backend and its capabilities (supported layers, opacity, click-through,
   * monitor selection, exact positioning). Call once per session and adapt your overlay options.
   * @example const { supports } = await sdk.display.backend(); if (!supports.layers.includes('background')) { ... }
   */
  backend(): Promise<DisplayBackendInfo>;
}`,
  docs: `Ask the desktop about its monitors and overlay abilities before placing media. Always available.

- \`monitors()\` returns logical geometry; use \`name\`, \`index\` or \`'cursor'\`/\`'primary'\` as the \`monitor\` option of \`sdk.media.*\`.
- \`backend()\` tells you which \`layer\` values, \`opacity\`, \`clickThrough\` and exact \`x\`/\`y\` placement actually work here (for example, on Wayland compositors other than Hyprland exact placement is not possible). Unsupported options are degraded, not rejected — check this once and remember the answer in session state.

\`\`\`ts
const info = await sdk.display.backend();
const monitors = await sdk.display.monitors();
const target = monitors.find(m => m.hasCursor) ?? monitors.find(m => m.primary)!;
await sdk.state.session.set("display", { backend: info.name, monitor: target.name });
return { backend: info.name, layers: info.supports.layers, monitors: monitors.map(m => m.name) };
\`\`\``,
  methods: {
    monitors: { description: 'List monitors and their geometry.' },
    backend: { description: 'Describe the overlay backend and its capabilities.' },
  },
};
