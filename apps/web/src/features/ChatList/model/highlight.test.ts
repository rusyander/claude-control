import { describe, it, expect } from 'vitest';
import { highlightSnippet } from './highlight';

/**
 * Тесты подсветки сниппета. Ключевое: совпадения помечаются отдельными кусками,
 * поиск без учёта регистра, регистр исходного текста сохраняется, склейка кусков
 * восстанавливает исходную строку без потерь.
 */
describe('highlightSnippet', () => {
  it('помечает совпадение отдельным куском', () => {
    const parts = highlightSnippet('настрой вебпак сейчас', 'вебпак');
    expect(parts).toEqual([
      { text: 'настрой ', match: false },
      { text: 'вебпак', match: true },
      { text: ' сейчас', match: false },
    ]);
  });

  it('ищет без учёта регистра, но сохраняет исходный регистр', () => {
    const parts = highlightSnippet('Разбор DATABASE и миграций', 'database');
    const match = parts.find((part) => part.match);
    expect(match?.text).toBe('DATABASE');
  });

  it('помечает все вхождения', () => {
    const parts = highlightSnippet('тест и ещё тест', 'тест');
    expect(parts.filter((part) => part.match)).toHaveLength(2);
  });

  it('склейка кусков даёт исходную строку', () => {
    const source = 'тест в начале, Тест в середине и ТЕСТ в конце';
    const joined = highlightSnippet(source, 'тест')
      .map((part) => part.text)
      .join('');
    expect(joined).toBe(source);
  });

  it('нет совпадения → одна обычная часть', () => {
    expect(highlightSnippet('обычный текст', 'отсутствует')).toEqual([
      { text: 'обычный текст', match: false },
    ]);
  });

  it('пустой запрос → весь текст обычным куском', () => {
    expect(highlightSnippet('текст', '   ')).toEqual([{ text: 'текст', match: false }]);
  });

  it('пустой сниппет → пустой список', () => {
    expect(highlightSnippet('', 'тест')).toEqual([]);
  });
});
