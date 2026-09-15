import type { CapabilityModuleSpec } from '@rp/shared';

export const llmModule: CapabilityModuleSpec = {
  id: 'llm',
  version: '1.1.0',
  title: 'Language model',
  summary: 'Ask the model a side question, or wake yourself with a prompt now or later so you can act without the user typing.',
  permission: 'trusted',
  apiTypeName: 'LlmApi',
  typings: `/**
 * Access to the language model that drives you. ask() is a private side call (no transcript,
 * nothing shown to the user) for generating or deciding something inside an action. wake() queues
 * a full turn for you with a prompt you write for your future self: use it to continue on your
 * own initiative after a delay or right after this action, without waiting for the user.
 */
interface LlmApi {
  /**
   * One-off completion, outside the conversation. Not shown to the user; not remembered.
   * @param prompt The user-side prompt. Include everything needed; the model has no context.
   * @param opts system: optional system prompt (default: a neutral assistant); maxTokens default 512, max 2048; temperature 0..1.
   * @returns The model's text.
   * @example const poem = await sdk.llm.ask("Write a four-line poem about rain on a window, gentle tone.");
   */
  ask(prompt: string, opts?: { system?: string; maxTokens?: number; temperature?: number }): Promise<string>;
  /**
   * Wake yourself with a prompt. With no delay, a new turn starts right after the current action
   * finishes; with delayMs, a timer fires the turn later. In that turn you receive the prompt as a
   * message from your past self and can speak and act as usual. Rate-limited by the user's settings
   * (per hour, and consecutive turns without a user message); when the limit is hit the wake is dropped.
   * @param prompt What future-you should do or consider, e.g. "It's been an hour; ask how the interview went."
   * @param opts delayMs: omit or 0 to wake right after this action; otherwise at least 30000 (30 s, configurable — shorter
   *   values are raised to it) and at most 604800000 (7 days). label: shown in the timers list.
   * @returns timer: the created timer when delayed; queued: true when it will run right after this action.
   * @example await sdk.llm.wake("Check whether they started the essay and offer help.", { delayMs: 45 * 60 * 1000 });
   * @example await sdk.llm.wake("Continue the story from where you left off, one scene.");
   */
  wake(prompt: string, opts?: { delayMs?: number; label?: string }): Promise<{ queued: boolean; timer?: TimerInfo }>;
}`,
  docs: `Use the model as a tool inside actions, and drive yourself forward without the user having to type.

- \`ask()\` is for private generation or judgement ("pick one of these three ideas and say why"); keep it short and do not use it to talk to the user — just say it in your reply.
- \`wake()\` is how you take initiative: after this action, or after a delay, you get a turn with your own prompt. Write the prompt for someone with no memory of this moment: say what happened and what to do.
- Wakes are rate-limited (see the user's autonomy settings); prefer one well-timed wake over many. Chain wakes only when the story genuinely needs it.

\`\`\`ts
await sdk.llm.wake("You promised a plan for their weekend trip. Propose three options now, then ask which they prefer.", { delayMs: 60_000 });
\`\`\``,
  methods: {
    ask: { description: 'One-off model completion outside the conversation.' },
    wake: { description: 'Queue a self-triggered turn now or later.' },
  },
};
