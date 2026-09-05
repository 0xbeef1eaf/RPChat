import type { CapabilityModuleSpec } from '@rp/shared';
import { chatModule } from './chat.js';
import { logModule } from './log.js';
import { stateModule } from './state.js';
import { packModule } from './pack.js';
import { timersModule } from './timers.js';
import { memoryModule } from './memory.js';
import { llmModule } from './llm.js';
import { displayModule } from './display.js';
import { mediaModule } from './media.js';
import { uiModule } from './ui.js';
import { systemModule } from './system.js';
import { wallpaperModule } from './wallpaper.js';
import { browserModule } from './browser.js';
import { inputModule } from './input.js';

export { chatModule, logModule, stateModule, packModule, timersModule, llmModule, memoryModule, displayModule, mediaModule, uiModule, wallpaperModule, browserModule, inputModule, systemModule };

/** All v1 standard modules in their canonical (prompt) order. */
export const standardModules: readonly CapabilityModuleSpec[] = [
  chatModule,
  logModule,
  stateModule,
  packModule,
  timersModule,
  llmModule,
  memoryModule,
  displayModule,
  mediaModule,
  uiModule,
  wallpaperModule,
  browserModule,
  inputModule,
  systemModule,
];
