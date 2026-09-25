/**
 * The BERT tokeniser the on-device embedding model expects, written out rather than pulled in.
 *
 * A sentence-transformer is two halves: a small ONNX graph and the exact text→ids convention it was
 * trained with. The graph needs a runtime; this half needs a vocabulary file and about a hundred
 * lines, and getting it from a library would mean taking a transformers stack (and a second copy of
 * ONNX Runtime) for a function whose whole specification is public and testable against known ids.
 *
 * This is the `bert-base-uncased` recipe, which is what BGE and MiniLM use: strip control
 * characters, lower-case, drop combining marks, split on whitespace and punctuation, give every CJK
 * character its own token, then match each word greedily against the vocabulary, longest prefix
 * first, with `##` on every continuation piece.
 */

/** Never match a prefix longer than this inside one word: the original caps it and emits `[UNK]` instead. */
const MAX_WORD_CHARS = 100;

export const CLS_TOKEN = '[CLS]';
export const SEP_TOKEN = '[SEP]';
export const UNK_TOKEN = '[UNK]';
export const PAD_TOKEN = '[PAD]';

/** CJK blocks BERT treats as one token per character (the ranges from the reference implementation). */
const CJK = /[一-鿿㐀-䶿豈-﫿぀-ヿ]/u;

const PUNCTUATION = /[\p{P}\p{S}]/u;

/** Whitespace, punctuation and CJK splitting, after lower-casing and dropping accents. */
export function basicTokenize(text: string): string[] {
  const cleaned = text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/[\u0000�]/g, '')
    .replace(/\p{Cc}/gu, ' ')
    .toLowerCase();
  const out: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) out.push(current);
    current = '';
  };
  for (const char of cleaned) {
    if (/\s/u.test(char)) flush();
    else if (PUNCTUATION.test(char) || CJK.test(char)) {
      flush();
      out.push(char);
    } else current += char;
  }
  flush();
  return out;
}

/** Vocabulary of a BERT model: `vocab.txt`, one token per line, the line number being the id. */
export class WordPieceVocab {
  private readonly ids: Map<string, number>;

  constructor(vocabText: string) {
    this.ids = new Map();
    const lines = vocabText.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const token = (lines[i] as string).replace(/\r$/, '');
      if (token.length === 0 && i === lines.length - 1) continue; // trailing newline
      if (!this.ids.has(token)) this.ids.set(token, i);
    }
    for (const required of [CLS_TOKEN, SEP_TOKEN, UNK_TOKEN, PAD_TOKEN]) {
      if (!this.ids.has(required)) throw new Error(`vocab.txt has no ${required} token`);
    }
  }

  get size(): number {
    return this.ids.size;
  }

  id(token: string): number | undefined {
    return this.ids.get(token);
  }

  idOf(token: string): number {
    return this.ids.get(token) ?? (this.ids.get(UNK_TOKEN) as number);
  }

  /** Greedy longest-prefix match; a word with any unmatched remainder becomes a single `[UNK]`. */
  wordPieces(word: string): string[] {
    if (word.length > MAX_WORD_CHARS) return [UNK_TOKEN];
    const pieces: string[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let piece: string | undefined;
      while (start < end) {
        const candidate = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
        if (this.ids.has(candidate)) {
          piece = candidate;
          break;
        }
        end -= 1;
      }
      if (piece === undefined) return [UNK_TOKEN];
      pieces.push(piece);
      start = end;
    }
    return pieces;
  }

  /** `[CLS] … [SEP]` ids for one text, truncated to `maxTokens` (the special tokens included). */
  encode(text: string, maxTokens: number): number[] {
    const ids = [this.idOf(CLS_TOKEN)];
    const body = Math.max(0, maxTokens - 2);
    outer: for (const word of basicTokenize(text)) {
      for (const piece of this.wordPieces(word)) {
        if (ids.length - 1 >= body) break outer;
        ids.push(this.idOf(piece));
      }
    }
    ids.push(this.idOf(SEP_TOKEN));
    return ids;
  }
}

/** One padded batch: `rows × width` ids with the mask that tells the model where the padding starts. */
export interface EncodedBatch {
  ids: BigInt64Array;
  mask: BigInt64Array;
  types: BigInt64Array;
  rows: number;
  width: number;
}

/**
 * Encode a batch, padded to its own longest row rather than to the model's maximum.
 *
 * Memories are one to three sentences, so a batch of them is typically 30 tokens wide against a
 * 512-token limit; padding to the limit would make every batch fifteen times the work for nothing.
 */
export function encodeBatch(vocab: WordPieceVocab, texts: string[], maxTokens: number): EncodedBatch {
  const rows = texts.map((text) => vocab.encode(text, maxTokens));
  const width = Math.max(1, ...rows.map((r) => r.length));
  const pad = BigInt(vocab.idOf(PAD_TOKEN));
  const ids = new BigInt64Array(rows.length * width).fill(pad);
  const mask = new BigInt64Array(rows.length * width);
  const types = new BigInt64Array(rows.length * width);
  rows.forEach((row, r) => {
    row.forEach((id, c) => {
      ids[r * width + c] = BigInt(id);
      mask[r * width + c] = 1n;
    });
  });
  return { ids, mask, types, rows: rows.length, width };
}
