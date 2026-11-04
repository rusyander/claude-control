import { describe, expect, it } from 'vitest';
import { continuationTitle } from './continuation-title.ts';

describe('continuationTitle', () => {
  it('не копит суффиксы: третье продолжение читается как третье', () => {
    expect(continuationTitle('Группа · работа', 1)).toBe('Группа · работа · продолжение');
    expect(continuationTitle('Группа · работа · продолжение', 2)).toBe(
      'Группа · работа · продолжение 2',
    );
    expect(continuationTitle('Группа · работа · продолжение 2', 3)).toBe(
      'Группа · работа · продолжение 3',
    );
  });

  it('пустое название — «Разговор · продолжение»', () => {
    expect(continuationTitle('  ', 1)).toBe('Разговор · продолжение');
  });
});
