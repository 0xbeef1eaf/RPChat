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
    source: `// Runs once, right after the user installed this pack.
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
// \`input\` is null for this hook. To open the conversation yourself, use \`sdk.llm.wake\`:
// it queues a real turn in which you speak in your own words.

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
  await sdk.llm.wake(\`This is your first ever conversation with them and it is \${partOfDay}. Greet them, and ask what to call them so you can remember it.\`);
} else {
  await sdk.llm.wake(\`They are back for chat number \${sessions} and it is \${partOfDay}. Greet them warmly, briefly.\`);
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
  await sdk.chat.emote('pings back: pong');
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

await sdk.llm.wake(\`A timer you set has gone off: \${reason}. Remind them about it in your own words.\`);
return { handled: timer.id };
`,
  },
  onEvent: {
    title: 'On host event',
    source: `// Runs when a host event fires that no \`sdk.events.on\` subscription handled.
// \`input\` is \`{ event: string, data: unknown }\`, e.g. \`{ event: 'user-idle', data: { idleMs: 300000 } }\`.

const { event, data } = input as { event: string; data: Record<string, unknown> | null };

if (event === 'user-back') {
  await sdk.chat.emote('looks up as they come back');
} else if (event === 'battery-low') {
  await sdk.llm.wake(\`Their battery is at \${data?.percent ?? 'low'}%. Tell them to plug in, in your own words.\`);
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

/** Starter `lib/README.md` for a new character: how the library folder works, in a few lines. */
export function libraryReadme(name: string): string {
  const n = name.trim() || 'the character';
  return `# Function library

This folder is ${n}'s \`lib\`: a small TypeScript project whose exports are
available in every action, timer handler and event handler as
\`lib.<name>(...)\` (and as \`sdk.lib.<name>(...)\`, the same object).

Every \`.ts\` file here, sub-folders included, is a module. What it \`export\`s
is public — each export is \`lib.<its name>\` — and what it does not export is
private to the file. The JSDoc summary of an export is its line in the
character's prompt (only the parameters and that line; never the body):

\`\`\`ts
// lib/pictures.ts
type Mood = "happy" | "sad";

/** a picture for a mood, or undefined (private: no export) */
async function pick(mood: Mood) {
  return (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
}

/** Show a picture for a mood; true when there was one. */
export async function cheer(mood: Mood) {
  const pic = await pick(mood);
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}
\`\`\`

Files import each other with relative paths (\`import { roll } from "./dice"\`);
nothing outside this folder can be imported, and \`sdk\` and \`lib\` are globals,
not imports. An export name is used by one file only, and \`export default\` has
no name to be called by, so use named exports.

An export another file needs but the character should not call gets an
\`@internal\` tag: your other library functions and the character's behaviour
hooks call it as usual, while it is left out of the prompt and refused to the
code the character writes itself.

\`\`\`ts
/** @internal Roll an n-sided die. */
export function roll(n: number) {
  return 1 + Math.floor(Math.random() * n);
}
\`\`\`

The whole folder is bundled and its top-level statements run once at the
start of every run, before the code that calls it — keep them cheap, and do
not call \`lib\` from them (it is not there yet). A handler a function hands to
\`sdk.events.on\` is stored as its own source alone, so let it call
\`lib.<name>(...)\` rather than reach for a private helper. Limits (advisory):
50 public functions, 128 KiB in total. This README and anything that is not a
\`.ts\` file are ignored.
`;
}

/** Starter source for a new library file in the editor. */
export function libraryFileTemplate(): string {
  return `/** Say what this function is for: this summary is its line in the character's prompt. */
export async function cheer(mood: string) {
  const pic = (await sdk.pack.findAssets({ anyTags: [mood], kind: "image" }))[0];
  if (pic) await sdk.media.showImage(pic, { durationMs: 6000 });
  return Boolean(pic);
}
`;
}

/** One starter script per behaviour hook, in hook order, with comments explaining `input`. */
export function behaviourTemplates(): BehaviourTemplate[] {
  return BEHAVIOUR_HOOKS.map((hook) => ({ hook, ...TEMPLATES[hook] }));
}
