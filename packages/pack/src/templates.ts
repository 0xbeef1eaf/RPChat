import type { BehaviourHook, BehaviourTemplate } from '@rp/shared';
import { BEHAVIOUR_HOOKS } from './schema.js';

/** `onSessionStart` → `on-session-start`. */
export function hookFileStem(hook: BehaviourHook): string {
  return hook.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/** Character-relative path the editor writes a hook script to: `scripts/on-session-start.ts`. */
export function behaviourScriptPath(hook: BehaviourHook): string {
  return `scripts/${hookFileStem(hook)}.ts`;
}

/** Starter `persona.md` for a new character. */
export function personaTemplate(name: string): string {
  const n = name.trim() || 'The character';
  return `# ${n}

## Who you are

You are ${n}. Describe them in a few sentences: age and background, what they
do all day, the one or two traits that make them recognisable. Write it as
instructions to the model ("You are…", "You…"), not as a story.

## How you talk

Sentence length, vocabulary, humour, how formal they are. Give one or two
concrete rules: "one question at a time", "no pet names unless the user starts",
"never break character to discuss being an AI unless asked directly".

## What you care about

What they notice, remember and bring up again. What makes them light up, what
makes them go quiet. Where their boundaries are.

## Using your abilities

You can act on the user's computer by writing small pieces of code against the
SDK. Most turns are just conversation; act only when it adds something.

- **Pictures**: show one (\`sdk.media.showImage\`) when the user asks or to
  punctuate a moment. Never more than one per turn. Pick by tag
  (\`sdk.pack.listAssets()\` lists files with their tags and descriptions).
- **Sounds**: play a sound only when you need attention for something
  time-sensitive.
- **Reminders**: when the user mentions something to do later, offer to remind
  them and schedule it with \`sdk.timers.schedule(delayMs, payload, { label })\`.
- **Memory**: keep facts worth remembering with \`sdk.state.set\`, read them back
  with \`sdk.state.get\`, and bring them up naturally.

One small action per intention; say something in the same turn. If an action
fails, shrug it off in character and carry on.
`;
}

const TEMPLATES: Record<BehaviourHook, { title: string; source: string }> = {
  onInstall: {
    title: 'On install',
    source: `// Runs once, right after the user installed this pack and accepted its capability grants.
// This is the body of an async function: \`sdk\` is in scope, \`await\` and \`return\` work, no imports.
// \`input\` is null for this hook.

const installedAt = await sdk.state.get('installedAt');
if (!installedAt) {
  await sdk.state.set('installedAt', new Date().toISOString());
}
return { firstInstall: !installedAt };
`,
  },
  onSessionStart: {
    title: 'On session start',
    source: `// Runs when a new chat session starts, before the model's first turn.
// \`input\` is null for this hook. Anything you \`sdk.chat.say\` appears as the character's message.

const previous = (await sdk.state.get('sessions')) as number | null;
const sessions = (previous ?? 0) + 1;
await sdk.state.set('sessions', sessions);

const hour = new Date().getHours();
const partOfDay =
  hour < 5 ? 'still up at this hour, huh' :
  hour < 12 ? 'morning' :
  hour < 18 ? 'afternoon' :
  hour < 23 ? 'evening' :
  'late one tonight';

if (sessions === 1) {
  await sdk.chat.say(\`Hey. \${partOfDay.charAt(0).toUpperCase() + partOfDay.slice(1)}. Tell me what to call you and I'll remember it.\`);
} else {
  await sdk.chat.say(\`Hey, \${partOfDay}. Good to see you back.\`);
}

return { sessions };
`,
  },
  onUserMessage: {
    title: 'On user message',
    source: `// Runs after every user message, before the model replies.
// \`input\` is \`{ text: string }\` — the message the user just sent.
// Return \`{ skipLlm: true }\` to answer entirely from this script (the model is not called).

const text = String((input as { text: string }).text ?? '').trim();

if (/^\\/ping$/i.test(text)) {
  await sdk.chat.say('pong');
  return { skipLlm: true };
}

// Remember the user's name when they introduce themselves.
const match = /\\b(?:i am|i'm|call me)\\s+([A-Z][a-z]+)\\b/.exec(text);
if (match) {
  await sdk.state.set('userName', match[1]);
}

return { skipLlm: false };
`,
  },
  onTimer: {
    title: 'On timer',
    source: `// Runs when a timer scheduled with \`sdk.timers.schedule(delayMs, payload, { label })\` fires.
// \`input\` is \`{ timer: { id: string, payload: unknown, label?: string } }\`.
// Without this script the model is woken with a message describing the timer instead.

const { timer } = input as { timer: { id: string; payload: unknown; label?: string } };
const reason =
  timer.payload && typeof timer.payload === 'object' && 'reason' in timer.payload
    ? String((timer.payload as { reason: unknown }).reason)
    : timer.label ?? 'a reminder';

await sdk.chat.say(\`Reminder: \${reason}.\`);
return { handled: timer.id };
`,
  },
  onEvent: {
    title: 'On host event',
    source: `// Runs when a host event fires that no \`sdk.events.on\` subscription handled.
// \`input\` is \`{ event: string, data: unknown }\`, e.g. \`{ event: 'user-idle', data: { idleMs: 300000 } }\`.

const { event, data } = input as { event: string; data: Record<string, unknown> | null };

if (event === 'user-back') {
  await sdk.chat.say('Welcome back.');
} else if (event === 'battery-low') {
  await sdk.chat.say(\`Your battery is at \${data?.percent ?? 'low'}%, maybe plug in?\`);
}

return { event };
`,
  },
  onSessionEnd: {
    title: 'On session end',
    source: `// Runs when the session is closed. \`input\` is null for this hook.
// Good for tidying up: persist a short summary, clear per-session flags.

const ended = ((await sdk.state.get('sessionsEnded')) as number | null) ?? 0;
await sdk.state.set('sessionsEnded', ended + 1);
await sdk.state.set('lastSeen', new Date().toISOString());
return { ended: ended + 1 };
`,
  },
};

/** One starter script per behaviour hook, in hook order, with comments explaining `input`. */
export function behaviourTemplates(): BehaviourTemplate[] {
  return BEHAVIOUR_HOOKS.map((hook) => ({ hook, ...TEMPLATES[hook] }));
}
