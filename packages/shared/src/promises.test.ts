import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findFloatingPromises } from './promises.js';

const kinds = (source: string): string[] => findFloatingPromises(source).map((p) => p.kind);

describe('findFloatingPromises', () => {
  it('finds the sdk call nobody awaits', () => {
    const found = findFloatingPromises(`sdk.messaging.send("phone", "hi");`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'sdk-call', line: 1, column: 1 });
    expect(found[0]!.message).toContain('`sdk.messaging.send(…)`');
  });

  it('leaves awaited, returned and assigned calls alone', () => {
    expect(kinds(`await sdk.messaging.send("phone", "hi");`)).toEqual([]);
    expect(kinds(`return sdk.messaging.send("phone", "hi");`)).toEqual([]);
    expect(kinds(`const p = sdk.messaging.send("phone", "hi");\nawait p;`)).toEqual([]);
    expect(kinds(`void sdk.messaging.send("phone", "hi");`)).toEqual([]);
    expect(kinds(`await Promise.all([sdk.chat.say("a"), sdk.chat.say("b")]);`)).toEqual([]);
  });

  it('finds the whole shape of the report that started this', () => {
    const source = `const message = await sdk.llm.ask("where are you?")
console.log(message)
const channels = await sdk.messaging.channels()
if (channels.length === 0) {
  await sdk.memory.remember("no channels", { tags: ["user"], importance: 5 })
} else {
  channels.map(async channel => {
    console.log(await sdk.messaging.send(channel.name, message))
  })
  sdk.memory.recall("no channels")
    .then(async memory => {
      await sdk.memory.forget(memory[0].id)
    })
}
`;
    const found = findFloatingPromises(source);
    expect(found.map((p) => [p.kind, p.line])).toEqual([
      ['async-callback', 7],
      ['sdk-call', 10],
    ]);
  });

  it('finds a dangling .then chain on something that is not the sdk', () => {
    expect(kinds(`lookUp(1).then((v) => console.log(v));`)).toEqual(['then-chain']);
    expect(kinds(`await lookUp(1).then((v) => console.log(v));`)).toEqual([]);
  });

  it('finds a call to an async function declared in the same script', () => {
    expect(kinds(`async function tuck() { await sdk.chat.say("night"); }\ntuck();`)).toEqual(['local-async-call']);
    expect(kinds(`const tuck = async () => { await sdk.chat.say("night"); };\ntuck();`)).toEqual(['local-async-call']);
    expect(kinds(`function tuck() { return 1; }\ntuck();`)).toEqual([]);
  });

  it('treats the character library like the sdk', () => {
    expect(kinds(`lib.startGame({ rounds: 3 });`)).toEqual(['sdk-call']);
    expect(kinds(`await lib.startGame({ rounds: 3 });`)).toEqual([]);
  });

  it('reads statements without semicolons the way the compiler does', () => {
    expect(kinds(`console.log("a")\nsdk.chat.say("b")`)).toEqual(['sdk-call']);
    // A line that continues the expression above is one statement, awaited at its head.
    expect(kinds(`await sdk.chat\n  .say("b")`)).toEqual([]);
    expect(kinds(`const all = [1, 2]\n  .map((n) => n + 1)`)).toEqual([]);
  });

  it('looks inside every block, not just the top level', () => {
    expect(kinds(`for (const c of channels) {\n  sdk.messaging.send(c.name, "hi")\n}`)).toEqual(['sdk-call']);
    expect(kinds(`if (a) sdk.chat.say("x");\nelse { sdk.chat.say("y"); }`)).toEqual(['sdk-call', 'sdk-call']);
    expect(kinds(`if (a) await sdk.chat.say("x");`)).toEqual([]);
    expect(kinds(`for (const c of cs) sdk.chat.say(c);`)).toEqual(['sdk-call']);
    expect(kinds(`while (go) lib.tick();`)).toEqual(['sdk-call']);
    expect(kinds(`sdk.events.on("tick", async () => {\n  sdk.chat.say("x");\n});`)).toEqual(['sdk-call', 'sdk-call']);
  });

  it('is not fooled by comments, strings, templates or regexes', () => {
    expect(kinds(`// sdk.chat.say("x")\n/* sdk.chat.say("y") */\nconst s = "sdk.chat.say(1)";`)).toEqual([]);
    expect(kinds('const t = `${await sdk.chat.say("x")} and ${1 / 2}`;')).toEqual([]);
    expect(kinds(`const re = /sdk.chat.say\\(/g;\nconst n = 4 / 2 / 1;`)).toEqual([]);
  });

  it('keeps object literals and destructuring out of it', () => {
    expect(kinds(`const handlers = { onTick: async () => { await sdk.chat.say("x"); } };`)).toEqual([]);
    expect(kinds(`const { a, b } = await sdk.state.get("k");`)).toEqual([]);
  });

  it('survives source that does not parse', () => {
    expect(() => findFloatingPromises('const x = "unterminated')).not.toThrow();
    expect(() => findFloatingPromises('function (){{{')).not.toThrow();
    expect(findFloatingPromises('')).toEqual([]);
  });

  /**
   * The packs shipped with the app are the corpus every false positive would show up in: they are
   * real hook bodies and library functions, written the way the editor's authors write them.
   */
  it('reports nothing in the example packs', () => {
    const root = join(fileURLToPath(new URL('../../../', import.meta.url)), 'examples/packs');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .map((path) => ({ path, found: findFloatingPromises(readFileSync(path, 'utf8')) }))
      .filter((entry) => entry.found.length > 0)
      .map((entry) => `${entry.path}: ${entry.found.map((f) => `${f.kind}@${f.line}`).join(', ')}`);
    expect(offenders).toEqual([]);
  });
});
