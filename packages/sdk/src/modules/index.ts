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
import { presenceModule } from './presence.js';
import { screenModule } from './screen.js';
import { calendarModule } from './calendar.js';
import { webModule } from './web.js';
import { eventsModule } from './events.js';
import { avatarModule } from './avatar.js';
import { widgetsModule } from './widgets.js';
import { voiceModule } from './voice.js';
import { desktopModule } from './desktop.js';
import { filesModule } from './files.js';
import { moodModule } from './mood.js';
import { routineModule } from './routine.js';
import { messagingModule } from './messaging.js';

export {
  chatModule, logModule, stateModule, packModule, timersModule, llmModule, memoryModule, displayModule,
  mediaModule, uiModule, wallpaperModule, browserModule, inputModule,
  presenceModule, screenModule, calendarModule, webModule, eventsModule, avatarModule, widgetsModule,
  voiceModule, desktopModule, filesModule, moodModule, routineModule, messagingModule,
  systemModule,
};

/** All standard modules in their canonical (prompt) order: v1 modules, then the phase-2 "living" modules, `system` last. */
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
  presenceModule,
  screenModule,
  calendarModule,
  webModule,
  eventsModule,
  avatarModule,
  widgetsModule,
  voiceModule,
  desktopModule,
  filesModule,
  moodModule,
  routineModule,
  messagingModule,
  systemModule,
];
