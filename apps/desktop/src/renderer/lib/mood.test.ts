import { describe, expect, it } from 'vitest';
import { describeRoutine, energyWord, moodWord } from './mood';

describe('mood words', () => {
  it('maps mood -1..1 into five buckets, clamping outside values', () => {
    expect(moodWord(-1)).toBe('miserable');
    expect(moodWord(-5)).toBe('miserable');
    expect(moodWord(-0.5)).toBe('low');
    expect(moodWord(0)).toBe('even');
    expect(moodWord(0.3)).toBe('good');
    expect(moodWord(0.95)).toBe('elated');
    expect(moodWord(1)).toBe('elated');
    expect(moodWord(Number.NaN)).toBe('even');
  });
  it('maps energy 0..1', () => {
    expect(energyWord(0)).toBe('exhausted');
    expect(energyWord(0.3)).toBe('tired');
    expect(energyWord(0.5)).toBe('steady');
    expect(energyWord(0.7)).toBe('lively');
    expect(energyWord(1)).toBe('energised');
  });
  it('describeRoutine composes state, label and next', () => {
    expect(describeRoutine({ state: 'available' })).toBe('available');
    expect(describeRoutine({ state: 'busy', label: 'deep work', next: { at: '18:00', state: 'available' } })).toBe('busy — deep work · next: available at 18:00');
  });
});
