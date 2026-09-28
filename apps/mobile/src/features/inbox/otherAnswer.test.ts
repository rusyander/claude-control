import { describe, expect, it } from 'vitest';
import { applyOtherAnswer } from './otherAnswer';

/**
 * «Другое» при нескольких вариантах: свой текст встаёт рядом с отмеченными.
 * Текст, равный готовому варианту, давал дубль — `['A','A']` в ответе и вторую
 * строку «моё» с тем же именем (F-154).
 */
describe('applyOtherAnswer', () => {
  const known = new Set(['A', 'B']);

  it('свой текст встаёт вместо прежнего своего', () => {
    expect(applyOtherAnswer({ picked: ['A', 'old'], custom: 'old', text: 'new', known })).toEqual({
      picked: ['A', 'new'],
      custom: 'new',
    });
  });

  it('текст, равный отмеченному варианту, не повторяется', () => {
    expect(applyOtherAnswer({ picked: ['A'], custom: '', text: 'A', known })).toEqual({
      picked: ['A'],
      custom: '',
    });
  });

  it('текст, равный неотмеченному варианту, отмечает сам вариант, а не «моё»', () => {
    expect(applyOtherAnswer({ picked: ['old'], custom: 'old', text: 'B', known })).toEqual({
      picked: ['B'],
      custom: '',
    });
  });
});
