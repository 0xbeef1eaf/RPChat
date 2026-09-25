/**
 * The tokeniser half of the on-device embedder.
 *
 * What matters here is agreement with the weights: the same text has to become the same ids the
 * model was trained on, or the vectors are quietly meaningless rather than obviously broken. The
 * cases below are the ones that decide that — accents, punctuation, an unknown word, and a word
 * that only exists in the vocabulary as pieces — plus the padding the batch depends on.
 */
import { describe, expect, it } from 'vitest';
import { WordPieceVocab, basicTokenize, encodeBatch } from './wordpiece.js';

/** A stand-in for `vocab.txt`: the line number is the id, exactly as in the real file. */
const VOCAB = [
  '[PAD]', // 0
  '[UNK]', // 1
  '[CLS]', // 2
  '[SEP]', // 3
  'the', // 4
  'cat', // 5
  'sat', // 6
  '.', // 7
  '?', // 8
  'em', // 9
  '##bed', // 10
  '##ding', // 11
  '##s', // 12
  'cafe', // 13
  '猫', // 14
].join('\n');

const vocab = new WordPieceVocab(VOCAB);

describe('basicTokenize', () => {
  it('lower-cases, drops accents and splits punctuation off', () => {
    expect(basicTokenize('The Café, closed?')).toEqual(['the', 'cafe', ',', 'closed', '?']);
    expect(basicTokenize('  spaced\tout\nlines ')).toEqual(['spaced', 'out', 'lines']);
  });

  it('gives every CJK character its own token', () => {
    // か, not が: an uncased BERT strips combining marks everywhere, dakuten included. The quirk is
    // the reference implementation's, and this model is English-only, so faithful beats clever.
    expect(basicTokenize('猫が好き')).toEqual(['猫', 'か', '好', 'き']);
  });

  it('survives control characters and an empty string', () => {
    expect(basicTokenize('a\u0000b\u0007c')).toEqual(['ab', 'c']);
    expect(basicTokenize('')).toEqual([]);
  });
});

describe('WordPieceVocab', () => {
  it('reads ids off the line numbers and insists on the special tokens', () => {
    expect(vocab.size).toBe(15);
    expect(vocab.id('cat')).toBe(5);
    expect(vocab.id('[CLS]')).toBe(2);
    expect(vocab.id('nope')).toBeUndefined();
    expect(vocab.idOf('nope')).toBe(1); // [UNK]
    expect(() => new WordPieceVocab('the\ncat')).toThrow(/\[CLS\]/);
    expect(new WordPieceVocab(`${VOCAB}\n`).size).toBe(15); // a trailing newline is not a token
  });

  it('splits a word into the longest pieces it has, `##` on every continuation', () => {
    expect(vocab.wordPieces('embeddings')).toEqual(['em', '##bed', '##ding', '##s']);
    expect(vocab.wordPieces('cat')).toEqual(['cat']);
  });

  it('gives up on the whole word when any part is missing', () => {
    // "embedded" starts well ("em", "##bed") and then cannot continue: BERT emits one [UNK] for the
    // word rather than the prefix it managed, and a vector built from the prefix would be wrong.
    expect(vocab.wordPieces('embedded')).toEqual(['[UNK]']);
    expect(vocab.wordPieces('x'.repeat(200))).toEqual(['[UNK]']);
  });

  it('wraps in [CLS]/[SEP] and truncates to the token budget', () => {
    expect(vocab.encode('The cat sat.', 512)).toEqual([2, 4, 5, 6, 7, 3]);
    expect(vocab.encode('The cat sat.', 4)).toEqual([2, 4, 5, 3]); // budget includes both specials
    expect(vocab.encode('', 512)).toEqual([2, 3]);
  });
});

describe('encodeBatch', () => {
  it('pads to the longest row of the batch and masks the padding', () => {
    const batch = encodeBatch(vocab, ['the cat', 'the cat sat.'], 512);
    expect([batch.rows, batch.width]).toEqual([2, 6]);
    expect([...batch.ids]).toEqual([2n, 4n, 5n, 3n, 0n, 0n, 2n, 4n, 5n, 6n, 7n, 3n]);
    expect([...batch.mask]).toEqual([1n, 1n, 1n, 1n, 0n, 0n, 1n, 1n, 1n, 1n, 1n, 1n]);
    expect([...batch.types].every((t) => t === 0n)).toBe(true);
  });

  it('never produces a zero-width batch', () => {
    expect(encodeBatch(vocab, [], 512)).toMatchObject({ rows: 0, width: 1 });
  });
});
