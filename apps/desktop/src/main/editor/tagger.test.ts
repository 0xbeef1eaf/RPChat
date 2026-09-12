import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmChatRequest, LlmChatResponse, LlmProvider, ProviderConfig } from '@rp/shared';
import { RpError } from '@rp/shared';
import {
  MediaTagger,
  TAG_DEFAULT_MAX_TAGS,
  TAG_RESPONSE_SCHEMA,
  absorbSuggestion,
  buildTagPrompt,
  cleanDescription,
  clampTags,
  extractJsonObject,
  parseTagResponse,
  type TagAsset,
  type TagContext,
  type TagPackContext,
} from './tagger.js';

const pack: TagPackContext = {
  id: 'com.test.luna',
  name: 'Luna',
  description: 'A desk companion',
  characters: ['Luna'],
  vocabulary: { smile: 'Luna smiling', wallpapers: 'Desktop backgrounds' },
  knownTags: ['smile', 'wallpapers', 'wave'],
};

function asset(over: Partial<TagAsset> = {}): TagAsset {
  return { path: 'media/images/luna-smile.png', kind: 'image', mime: 'image/png', bytes: 1234, absolutePath: '/tmp/luna-smile.png', folderTags: [], tags: [], ...over };
}

function context(over: Partial<TagContext> = {}): TagContext {
  return { pack, asset: asset(), basis: 'image', maxTags: 6, vocabularyOnly: false, ...over };
}

/** Provider that replays canned answers and records the requests it got. */
class FakeProvider implements LlmProvider {
  readonly kind = 'openai-compatible' as const;
  readonly id = 'p1';
  readonly requests: LlmChatRequest[] = [];
  constructor(
    readonly config: ProviderConfig,
    private readonly answers: Array<string | Error>,
  ) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(request);
    const next = this.answers.shift() ?? '{}';
    if (next instanceof Error) throw next;
    return { message: { role: 'assistant', content: [{ type: 'text', text: next }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'qwen3-vl:8b' };
  }
}

const visionConfig: ProviderConfig = { id: 'p1', kind: 'openai-compatible', label: 'Ollama', model: 'qwen3-vl:8b', baseUrl: 'http://localhost:11434/v1', supportsVision: true };

function tagger(answers: Array<string | Error>, config = visionConfig): { tagger: MediaTagger; provider: FakeProvider } {
  const provider = new FakeProvider(config, answers);
  return {
    provider,
    tagger: new MediaTagger({
      resolveProvider: async (id) => (id === undefined || id === config.id ? config : Promise.reject(new RpError('LLM_PROVIDER', `LLM provider "${id}" is not configured.`))),
      providerFactory: () => provider,
      readImage: async () => ({ mime: 'image/jpeg', data: 'AAAA', width: 768, height: 512 }),
    }),
  };
}

describe('buildTagPrompt', () => {
  it('shows the pack, the file and the vocabulary, and asks for JSON', () => {
    const { system, text } = buildTagPrompt(context({ asset: asset({ folderTags: ['portraits'], tags: ['smile'], description: 'Luna beaming' }), size: { width: 768, height: 512 } }));
    expect(system).toContain('at most 6');
    expect(system).toContain('{"tags"');
    expect(text).toContain('Pack: Luna (com.test.luna)');
    expect(text).toContain('Characters: Luna');
    expect(text).toContain('media/images/luna-smile.png');
    expect(text).toContain('768 × 512');
    expect(text).toContain('Folder tags already applied (do not repeat): portraits');
    expect(text).toContain('Tags it has today (keep the ones that still fit): smile');
    expect(text).toContain('Current description: Luna beaming');
    expect(text).toContain('- smile: Luna smiling');
    expect(text).toContain('Other tags already in use: wave');
    expect(text).toContain('The image itself is attached.');
  });

  it('names the basis and forbids invented tags when asked', () => {
    expect(buildTagPrompt(context({ basis: 'frame' })).text).toContain('frame grabbed from the middle of the video');
    expect(buildTagPrompt(context({ basis: 'filename', asset: asset({ kind: 'audio', path: 'media/audio/chime.wav', mime: 'audio/wav' }) })).text).toContain('You cannot see or hear this audio clip');
    const strict = buildTagPrompt(context({ vocabularyOnly: true }));
    expect(strict.system).toContain('Do NOT invent tags');
    expect(strict.system).toContain('meanings: leave it empty');
  });

  it('adds the author guidance when given', () => {
    expect(buildTagPrompt(context({ guidance: '  noir, tag by mood  ' })).text).toContain('Guidance from the pack author: noir, tag by mood');
  });
});

describe('extractJsonObject', () => {
  it('finds the object inside fences and chatter, braces in strings included', () => {
    expect(extractJsonObject('Sure!\n```json\n{"tags":["a"]}\n```\nHope that helps')).toBe('{"tags":["a"]}');
    expect(extractJsonObject('{"description":"a {smiling} face","meanings":{"x":"y"}}')).toBe('{"description":"a {smiling} face","meanings":{"x":"y"}}');
    expect(extractJsonObject('<think>Maybe {"tags":["wrong"]}</think>\n{"tags":["right"]}')).toBe('{"tags":["right"]}');
    expect(extractJsonObject('Let me think {not json}</think> {"tags":["right"]}')).toBe('{"tags":["right"]}'); // reasoning without an opening tag
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('{"unclosed": true')).toBeUndefined();
  });
});

describe('cleanDescription', () => {
  it('collapses whitespace, strips quotes and clamps to the media.json limit', () => {
    expect(cleanDescription('  "Luna\n  waving"  ')).toBe('Luna waving');
    expect(cleanDescription(42)).toBe('');
    const long = cleanDescription(`${'word '.repeat(60)}end.`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('word')).toBe(true);
  });
});

describe('parseTagResponse', () => {
  it('normalises tags, drops folder tags and caps the list', () => {
    const ctx = context({ asset: asset({ folderTags: ['portraits'] }), maxTags: 3 });
    const out = parseTagResponse('```json\n{"tags":["#Smile","portraits","Warm Light","cosy","extra","spare"],"description":"Luna smiling warmly."}\n```', ctx);
    expect(out.tags).toEqual(['smile', 'cosy', 'extra']); // "Warm Light" is not a valid tag, "portraits" comes from the folder
    expect(out.newTags).toEqual(['cosy', 'extra']);
    expect(out.description).toBe('Luna smiling warmly.');
    expect(out.error).toBeUndefined();
    expect(out.basis).toBe('image');
  });

  it('keeps meanings only for invented tags', () => {
    const out = parseTagResponse('{"tags":["smile","cosy"],"meanings":{"cosy":"Warm and relaxed","smile":"ignored","nope":"unused"}}', context());
    expect(out.vocabulary).toEqual({ cosy: 'Warm and relaxed' });
  });

  it('honours vocabularyOnly and accepts a comma-separated string', () => {
    const out = parseTagResponse('{"tags":"smile, cosy, wave","description":"x"}', context({ vocabularyOnly: true }));
    expect(out.tags).toEqual(['smile', 'wave']);
    expect(out.newTags).toEqual([]);
  });

  it('reports a non-JSON or broken answer instead of throwing', () => {
    expect(parseTagResponse('I cannot see the image.', context()).error).toContain('did not answer with JSON');
    expect(parseTagResponse('{"tags": [oops]}', context()).error).toContain('could not be parsed');
    expect(parseTagResponse('', context()).error).toContain('(empty answer)');
  });
});

describe('absorbSuggestion', () => {
  const base: TagPackContext = { ...pack, vocabulary: { smile: 'Luna smiling' }, knownTags: ['smile', 'wave'] };
  const suggestion = { tags: ['smile', 'cosy'], vocabulary: { cosy: 'Warm and relaxed' } };

  it('adds the tags and meanings a run has coined so far', () => {
    const next = absorbSuggestion(base, suggestion);
    expect(next.knownTags).toEqual(['smile', 'wave', 'cosy']);
    expect(next.vocabulary).toEqual({ smile: 'Luna smiling', cosy: 'Warm and relaxed' });
  });

  it('never overwrites a meaning the author wrote, and ignores a failed answer', () => {
    expect(absorbSuggestion(base, { tags: ['smile'], vocabulary: { smile: 'model wording' } }).vocabulary).toEqual({ smile: 'Luna smiling' });
    expect(absorbSuggestion(base, { ...suggestion, error: 'timed out' })).toBe(base);
    expect(absorbSuggestion(base, { tags: ['smile', 'wave'], vocabulary: {} })).toBe(base); // nothing new
  });
});

describe('clampTags', () => {
  it('defaults and clamps to the media.json limit', () => {
    expect(clampTags(undefined)).toBe(TAG_DEFAULT_MAX_TAGS);
    expect(clampTags('x')).toBe(TAG_DEFAULT_MAX_TAGS);
    expect(clampTags(0)).toBe(1);
    expect(clampTags(99)).toBe(20);
    expect(clampTags(3.7)).toBe(3);
  });
});

describe('MediaTagger.suggest', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-tagger-'));
    fs.writeFileSync(path.join(tmp, 'notes.md'), 'Luna keeps a diary of the day.');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('sends the image and returns one suggestion per asset', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["smile","cosy"],"description":"Luna smiling.","meanings":{"cosy":"Warm and relaxed"}}']);
    const [out] = await t.suggest(pack, [asset()], { maxTags: 4 });
    expect(out).toMatchObject({ path: 'media/images/luna-smile.png', tags: ['smile', 'cosy'], newTags: ['cosy'], description: 'Luna smiling.', basis: 'image', model: 'qwen3-vl:8b' });
    const [request] = provider.requests;
    expect(request?.model).toBe('qwen3-vl:8b');
    expect(request?.messages[0]?.content[0]).toEqual({ type: 'image', mime: 'image/jpeg', data: 'AAAA' });
    expect(request?.responseFormat).toBeUndefined(); // opt-in: not every server accepts a schema
  });

  it('constrains the answer to the tag schema when asked to', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["smile"],"description":"Luna smiling."}']);
    await t.suggest(pack, [asset()], { jsonSchema: true });
    expect(provider.requests[0]?.responseFormat).toEqual({ type: 'json_schema', name: 'media_tags', schema: TAG_RESPONSE_SCHEMA });
  });

  it('offers a later asset the vocabulary an earlier one invented', async () => {
    const { tagger: t, provider } = tagger([
      '{"tags":["cosy"],"description":"Luna in warm light.","meanings":{"cosy":"Warm and relaxed"}}',
      '{"tags":["cosy"],"description":"Luna reading."}',
    ]);
    const out = await t.suggest(pack, [asset(), asset({ path: 'media/images/luna-read.png' })]);
    expect(out[0]?.newTags).toEqual(['cosy']); // coined here …
    expect(out[1]?.newTags).toEqual([]); //       … and known by the time the second asset is tagged
    expect(provider.requests[1]?.messages[0]?.content.at(-1)).toMatchObject({ text: expect.stringContaining('cosy: Warm and relaxed') });
  });

  it('passes the reasoning effort on to the provider', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["smile"],"description":"Luna smiling."}']);
    await t.suggest(pack, [asset()], { reasoningEffort: 'none' });
    expect(provider.requests[0]?.reasoningEffort).toBe('none');
  });

  it('treats a renderer-decoded still as the image itself, not a video frame', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["portrait"]}']);
    const webp = asset({ path: 'media/images/luna.webp', mime: 'image/webp', frame: 'UE5H' });
    const [out] = await t.suggest(pack, [webp]);
    expect(out?.basis).toBe('image'); // 'frame' would tell the UI (and the model) it came from a video
    expect(provider.requests[0]?.messages[0]?.content[0]).toEqual({ type: 'image', mime: 'image/png', data: 'UE5H' });
  });

  it('tells the model a still of an animated file may not be the whole story', () => {
    const gif = buildTagPrompt(context({ asset: asset({ path: 'media/images/wave.gif', mime: 'image/gif' }) }));
    expect(gif.text).toContain('it may be animated');
    expect(buildTagPrompt(context()).text).toContain('The image itself is attached.');
  });

  it('names the cause when main cannot decode a file itself', async () => {
    const provider = new FakeProvider(visionConfig, []);
    const t = new MediaTagger({ resolveProvider: async () => visionConfig, providerFactory: () => provider, readImage: async () => undefined });
    const [out] = await t.suggest(pack, [asset({ path: 'media/images/luna.avif', mime: 'image/avif' })]);
    expect(out?.error).toContain('PNG and JPEG only');
    expect(out?.error).toContain('.avif');
  });

  it('uses a renderer-supplied video frame and quotes text files', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["loop"]}', '{"tags":["diary"]}']);
    const video = asset({ path: 'media/video/ring.webm', kind: 'video', mime: 'video/webm', frame: 'RlJBTUU=' });
    const text = asset({ path: 'media/text/notes.md', kind: 'text', mime: 'text/markdown', absolutePath: path.join(tmp, 'notes.md') });
    const out = await t.suggest(pack, [video, text]);
    expect(out.map((s) => s.basis)).toEqual(['frame', 'text']);
    expect(provider.requests[0]?.messages[0]?.content[0]).toEqual({ type: 'image', mime: 'image/png', data: 'RlJBTUU=' });
    expect(provider.requests[1]?.messages[0]?.content).toHaveLength(1); // text only
    expect(JSON.stringify(provider.requests[1]?.messages[0]?.content)).toContain('Luna keeps a diary');
  });

  it('tags audio from its name without an image part', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["notification"],"description":"A soft chime."}']);
    const [out] = await t.suggest(pack, [asset({ path: 'media/audio/chime.wav', kind: 'audio', mime: 'audio/wav' })]);
    expect(out?.basis).toBe('filename');
    expect(out?.tags).toEqual(['notification']);
    expect(provider.requests[0]?.messages[0]?.content.some((p) => p.type === 'image')).toBe(false);
  });

  it('refuses images on a provider without vision, and says how to fix it', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["x"]}'], { ...visionConfig, supportsVision: false });
    const [out] = await t.suggest(pack, [asset()]);
    expect(out?.error).toContain('not marked as vision-capable');
    expect(out?.error).toContain('qwen3-vl');
    expect(out?.tags).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });

  it('explains an empty answer from a reasoning model that ran out of tokens', async () => {
    const provider = new FakeProvider(visionConfig, []);
    provider.chat = async () => ({ message: { role: 'assistant', content: [] }, stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 }, model: 'qwen3-vl:8b' });
    const t = new MediaTagger({ resolveProvider: async () => visionConfig, providerFactory: () => provider, readImage: async () => ({ mime: 'image/jpeg', data: 'AAAA' }) });
    const [out] = await t.suggest(pack, [asset()]);
    expect(out?.error).toContain('spent all 3000 tokens reasoning');
    expect(out?.error).toContain('instruct build');
  });

  it('turns a provider failure into an error entry and keeps going', async () => {
    const { tagger: t } = tagger([new RpError('LLM_PROVIDER', 'connection refused'), '{"tags":["smile"]}']);
    const out = await t.suggest(pack, [asset(), asset({ path: 'media/images/luna-wave.png' })]);
    expect(out[0]?.error).toBe('connection refused');
    expect(out[1]?.tags).toEqual(['smile']);
  });

  it('fails the whole run when the provider cannot be resolved', async () => {
    const { tagger: t } = tagger([]);
    await expect(t.suggest(pack, [asset()], { providerId: 'gone' })).rejects.toThrow(/not configured.*Settings → Providers/);
  });

  it('prefers an explicit model over the provider default', async () => {
    const { tagger: t, provider } = tagger(['{"tags":["smile"]}']);
    await t.suggest(pack, [asset()], { model: ' qwen3-vl:32b ' });
    expect(provider.requests[0]?.model).toBe('qwen3-vl:32b');
  });
});
