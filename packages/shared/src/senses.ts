import type { CharacterRef, Json, SessionId } from './ids.js';

/** What the host can tell about the user right now. Fields are null/undefined when unknown on this platform. */
export interface PresenceSnapshot {
  at: string;
  /** Milliseconds since the last keyboard/mouse input. */
  idleMs: number;
  /** idleMs below the configured threshold (default 2 min). */
  atKeyboard: boolean;
  activeWindow: { title: string; app: string; class?: string } | null;
  screenLocked: boolean | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  nowPlaying: NowPlaying | null;
  /** Milliseconds since the user's last chat message in this session (null if none). */
  sinceLastMessageMs: number | null;
  localTime: string;
  dayPart: 'night' | 'early-morning' | 'morning' | 'afternoon' | 'evening' | 'late-evening';
}

export interface NowPlaying {
  title: string;
  artist?: string;
  album?: string;
  app?: string;
  status: 'playing' | 'paused' | 'stopped';
  positionMs?: number;
  durationMs?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  description?: string;
  calendar: string;
}

/** Host-level events characters can subscribe to with `sdk.events.on`. */
export type HostEventName =
  | 'user-idle'          // data: { idleMs }        fires once when idle crosses the subscription's idleMs (default 5 min)
  | 'user-back'          // data: { idleMs }        first input after user-idle
  | 'window-changed'     // data: { title, app, class? }
  | 'app-launched'       // data: { app }           app seen for the first time since the last window-changed sequence
  | 'file-added'         // data: { path, dir, name } in a watched directory
  | 'battery-low'        // data: { percent }       crosses below filter.percent (default 20)
  | 'screen-locked'      // data: {}
  | 'screen-unlocked'    // data: {}
  | 'song-changed'       // data: NowPlaying
  | 'time'               // data: { hour, minute, weekday, iso }  matches filter { hour?, minute?, weekday? } evaluated each minute
  | 'widget-message'     // data: { widgetId, message }
  | 'avatar-clicked'     // data: {}
  | 'routine-changed';   // data: { from, to, label? }

/** Subscribable event names: host events plus character-raised `custom:<name>` events. */
export type EventName = HostEventName | `custom:${string}`;

export interface HostEvent {
  name: EventName;
  data: Json;
  at: string;
}

export interface EventSubscription {
  id: string;
  sessionId: SessionId;
  characterRef: CharacterRef;
  event: EventName;
  /** Event-specific filter, see HostEventName comments. */
  filter?: Record<string, Json>;
  /** Action body run with `input = { event, data, ...input }`. */
  code: string;
  input?: Json;
  label?: string;
  once?: boolean;
  createdAt: string;
  fired: number;
  lastFiredAt?: string;
}

export interface MoodState {
  /** -1 (miserable) .. 1 (elated). Decays toward the character's baseline. */
  mood: number;
  /** 0 (exhausted) .. 1 (energised). Follows the routine and decays toward baseline. */
  energy: number;
  tags: string[];
  updatedAt: string;
  /** Free-text reasons for the last few changes, newest first (max 5). */
  recent: Array<{ at: string; reason: string; mood?: number; energy?: number }>;
}

export type RoutineStateName = 'available' | 'busy' | 'away' | 'asleep';

export interface RoutineEntry {
  /** 24h local time `HH:MM`. */
  at: string;
  /** 0 = Sunday .. 6. Omit for every day. */
  days?: number[];
  state: RoutineStateName;
  label?: string;
  /** Self-wake prompt when this entry becomes active (subject to autonomy limits). */
  wakePrompt?: string;
}

export interface RoutineStatus {
  state: RoutineStateName;
  label?: string;
  since?: string;
  until?: string;
  next?: RoutineEntry;
}

export interface MessagingChannel {
  name: string;
  kind: 'discord' | 'slack' | 'telegram' | 'generic-json' | 'command';
  /** Webhook URL for webhook kinds; for telegram: `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>`. */
  url?: string;
  /** For `command`: template with `{text}` and `{channel}` placeholders. */
  command?: { command: string; shell?: boolean; timeoutMs?: number };
}
