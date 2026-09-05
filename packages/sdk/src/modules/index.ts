import type { CapabilityModuleSpec } from '@rp/shared';
import { chatModule } from './chat.js';
import { logModule } from './log.js';
import { stateModule } from './state.js';
import { packModule } from './pack.js';
import { timersModule } from './timers.js';
import { mediaModule } from './media.js';
import { uiModule } from './ui.js';
import { systemModule } from './system.js';

export { chatModule, logModule, stateModule, packModule, timersModule, mediaModule, uiModule, systemModule };

/** All v1 standard modules in their canonical (prompt) order. */
export const standardModules: readonly CapabilityModuleSpec[] = [
  chatModule,
  logModule,
  stateModule,
  packModule,
  timersModule,
  mediaModule,
  uiModule,
  systemModule,
];
