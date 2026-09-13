/**
 * Compact SDK index for the LLM prompt: one line per method with its signature and a
 * one-sentence description, one line per helper type, and one example per module.
 * Roughly a fifth of the size of the full `sdk.d.ts` + docs; the full text of any one
 * module is available on demand through `sdk.help.module(id)`.
 */
import type { CapabilityModuleSpec } from '@rp/shared';
import { GENERAL_DOCS } from './generate.js';
import { SDK_PREAMBLE_TYPINGS } from './preamble.js';
import type { CapabilityRegistry } from './registry.js';
import { extractInterfaceBody, stripComments } from './validate.js';

export interface GenerateIndexOptions {
  modules?: string[];
  /** Include the compressed preamble helper types (default true). */
  helperTypes?: boolean;
}

/** `name(sig): ret` lines for the methods of an interface body (comments stripped), nested as `group.name`. */
export function indexMethods(body: string): string[] {
  const out: string[] = [];
  const members = splitMembers(body);
  for (const member of members) {
    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*([(<])/.exec(member);
    if (m) {
      out.push(collapse(member));
      continue;
    }
    const g = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*\{([\s\S]*)\}\s*$/.exec(member);
    if (g) {
      for (const inner of indexMethods(g[2]!)) out.push(`${g[1]!}.${inner}`);
    }
  }
  return out;
}

/** Split an interface body into top-level members (terminated by `;` or `}` at depth 0). */
function splitMembers(body: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '{' || ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === '>' || ch === ']') {
      // `=>` arrows contain `>` without a matching `<`.
      if (ch === '>' && body[i - 1] === '=') {
        current += ch;
        continue;
      }
      depth--;
    }
    if (ch === ';' && depth === 0) {
      if (current.trim()) members.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (ch === '}' && depth === 0) {
      if (current.trim()) members.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) members.push(current.trim());
  return members;
}

function collapse(text: string): string {
  let t = text.replace(/\s+/g, ' ').replace(/=>/g, '\u0000');
  t = t.replace(/\s*([()[\]<>,;:?|&=\u0000{}])\s*/g, '$1');
  t = t
    .replace(/([,;:])(?=[^\s])/g, '$1 ')
    .replace(/\?:/g, '?: ')
    .replace(/\|/g, ' | ')
    .replace(/&/g, ' & ')
    .replace(/=(?!>)/g, ' = ')
    .replace(/\u0000/g, ' => ')
    .replace(/\{(?=[^\s}])/g, '{ ')
    .replace(/(?<=[^\s{])\}/g, ' }')
    .replace(/\s{2,}/g, ' ')
    .replace(/\?:\s+/g, '?: ');
  return t.trim();
}

/** First sentence of the TSDoc block that precedes `name(` in `typings` (undefined when none). */
export function docSummary(typings: string, name: string): string | undefined {
  const last = name.split('.').pop()!;
  const re = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*(?:readonly\\s+)?${last}\\s*\\??\\s*[(<]`);
  const m = re.exec(typings);
  if (!m) return undefined;
  const text = m[1]!
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .join(' ')
    .split(/\s@\w+/)[0]!
    .trim();
  const sentence = /^(.*?[.!?])(\s+[A-Z]|$)/.exec(text);
  const out = (sentence ? sentence[1]! : text).trim();
  return out.length > 0 ? out : undefined;
}

export interface MethodDoc {
  /** The description text before the first tag, whitespace-collapsed. */
  summary?: string;
  params: Array<{ name: string; text: string }>;
  returns?: string;
  examples: string[];
}

/** The whole TSDoc block that precedes `name(` in `typings`: summary, every @param, @returns and @example. */
export function docFor(typings: string, name: string): MethodDoc {
  const last = name.split('.').pop()!;
  const re = new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*(?:readonly\\s+)?${last}\\s*\\??\\s*[(<]`);
  const m = re.exec(typings);
  const doc: MethodDoc = { params: [], examples: [] };
  if (!m) return doc;
  const lines = m[1]!.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trimEnd());
  // Split into blocks: text before the first tag, then one block per @tag (continuation lines belong to the tag).
  const blocks: Array<{ tag: string; text: string }> = [];
  let current: { tag: string; text: string } = { tag: '', text: '' };
  for (const line of lines) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line.trim());
    if (tag) {
      blocks.push(current);
      current = { tag: tag[1]!, text: tag[2] ?? '' };
    } else current.text += (current.text ? '\n' : '') + line;
  }
  blocks.push(current);
  const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();
  for (const b of blocks) {
    if (b.tag === '') {
      const text = squash(b.text);
      if (text) doc.summary = text;
    } else if (b.tag === 'param') {
      const pm = /^([A-Za-z_$][\w$]*)\s*(.*)$/s.exec(b.text.trim());
      if (pm) doc.params.push({ name: pm[1]!, text: squash(pm[2] ?? '') });
    } else if (b.tag === 'returns' || b.tag === 'return') {
      doc.returns = squash(b.text);
    } else if (b.tag === 'example') {
      const ex = b.text.split('\n').map((l) => l.trimEnd()).join('\n').trim();
      if (ex) doc.examples.push(ex);
    }
  }
  return doc;
}

/** One line per helper `interface`/`type` declared in `source` (not `apiTypeName`). */
export function indexTypes(source: string, apiTypeName?: string): string[] {
  const clean = stripComments(source);
  const out: string[] = [];
  const re = /\b(interface|type)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const name = m[2]!;
    if (name === apiTypeName) continue;
    if (m[1] === 'interface') {
      const head = /\s+extends\s+([^{]+)\{/.exec(clean.slice(m.index + m[0].length, clean.indexOf('{', m.index) + 1));
      const body = extractInterfaceBody(clean, name);
      if (body === undefined) continue;
      const members = splitMembers(body).map((x) => collapse(x.replace(/^readonly\s+/, '')));
      const ext = head ? ` extends ${head[1]!.trim()}` : '';
      out.push(`${name}${ext} { ${members.join('; ')} }`);
    } else {
      const start = m.index;
      let end = clean.indexOf(';', start);
      if (end < 0) end = clean.length;
      // keep going past `;` inside braces (object types)
      let depth = 0;
      for (let i = start; i < clean.length; i++) {
        const ch = clean[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === ';' && depth === 0) {
          end = i;
          break;
        }
      }
      out.push(collapse(clean.slice(start, end).replace(/^type\s+/, '')));
    }
  }
  return out;
}

function firstExample(docs: string): string | undefined {
  const m = /```(?:ts|typescript|js)?\n([\s\S]*?)```/.exec(docs);
  if (!m) return undefined;
  const code = m[1]!.trim();
  return code.split('\n').length <= 6 ? code : code.split('\n').slice(0, 6).join('\n') + '\n// …';
}

/** Index one module: heading, summary, methods, helper types, example. */
export function indexModule(spec: CapabilityModuleSpec): string {
  const lines: string[] = [`## sdk.${spec.id} — ${spec.title} (${spec.permission})`, spec.summary.trim()];
  const clean = stripComments(spec.typings);
  const body = extractInterfaceBody(clean, spec.apiTypeName) ?? '';
  for (const sig of indexMethods(body)) {
    const name = sig.slice(0, sig.search(/[(<]/));
    const doc = docFor(spec.typings, name);
    const desc = doc.summary ?? spec.methods[name]?.description;
    lines.push(`- ${sig}${desc ? ` — ${desc}` : ''}`);
    for (const p of doc.params) if (p.text) lines.push(`    ${p.name}: ${p.text}`);
    if (doc.returns) lines.push(`    returns: ${doc.returns}`);
    const example = doc.examples[0];
    if (example) lines.push(`    e.g. ${example.split('\n').join('\n         ')}`);
  }
  const types = indexTypes(spec.typings, spec.apiTypeName);
  if (types.length > 0) lines.push(`Types: ${types.join(' · ')}`);
  const example = firstExample(spec.docs);
  if (example) lines.push('```ts', example, '```');
  return lines.join('\n');
}

export const INDEX_INTRO = `# SDK index
Every \`sdk\` method below returns a Promise (await it) unless its return type says otherwise. Signatures are TypeScript. Helper types used by several modules are listed under "Shared types". This index is abridged: \`await sdk.help.module("<id>")\` returns the complete typings and guide for one module — use it when you need option details you do not see here.`;

/** Keep only the preamble type lines whose name is referenced by `text` (transitively through other kept types). */
function referencedTypes(lines: string[], text: string): string[] {
  const byName = new Map<string, string>();
  for (const line of lines) {
    const name = /^([A-Za-z_$][\w$]*)/.exec(line)?.[1];
    if (name) byName.set(name, line);
  }
  const kept = new Set<string>();
  const queue: string[] = [];
  const scan = (source: string): void => {
    for (const name of byName.keys()) {
      if (!kept.has(name) && new RegExp(`\\b${name}\\b`).test(source)) {
        kept.add(name);
        queue.push(name);
      }
    }
  };
  scan(text);
  while (queue.length > 0) scan(byName.get(queue.pop()!)!);
  return lines.filter((line) => kept.has(/^([A-Za-z_$][\w$]*)/.exec(line)?.[1] ?? ''));
}

/** The compact reference the prompt builder injects instead of the full typings + docs. */
export function generateSdkIndex(registry: CapabilityRegistry, options: GenerateIndexOptions = {}): string {
  const all = registry.list();
  const allowed = options.modules ? new Set(options.modules) : undefined;
  const specs = allowed ? all.filter((m) => allowed.has(m.id)) : all;
  const sections: string[] = [GENERAL_DOCS, INDEX_INTRO];
  sections.push(`Available modules: ${specs.map((s) => `sdk.${s.id}`).join(', ')}.`);
  for (const spec of specs) sections.push(indexModule(spec));
  if (options.helperTypes !== false) {
    const shared = referencedTypes(indexTypes(SDK_PREAMBLE_TYPINGS), sections.join('\n'));
    if (shared.length > 0) sections.push(`## Shared types\n${shared.join('\n')}`);
  }
  // Modules the user switched off (Settings → Permissions) are not mentioned at all: only available modules exist for the character.
  return sections.join('\n\n') + '\n';
}
