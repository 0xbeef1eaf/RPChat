import type { RunLimits } from './action.js';
import type { ProviderConfig } from './llm.js';

export interface AppSettings {
  providers: ProviderConfig[];
  /** Id of the provider used when a session has no override. */
  defaultProviderId?: string;
  /** Max LLM ⇄ action rounds per user message. Default 4. */
  maxActionRounds: number;
  /** Approximate token budget for the transcript window. Default 24_000. */
  contextTokenBudget: number;
  runLimits: RunLimits;
  /** Prefer native tool calling when the provider supports it. Default true. */
  useToolCalling: boolean;
  userDisplayName: string;
  theme: 'system' | 'light' | 'dark';
  /** Whether media windows stay above other windows. */
  mediaAlwaysOnTop: boolean;
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'runLimits'> & { runLimits?: RunLimits } = {
  providers: [],
  maxActionRounds: 4,
  contextTokenBudget: 24_000,
  useToolCalling: true,
  userDisplayName: 'You',
  theme: 'system',
  mediaAlwaysOnTop: true,
};
