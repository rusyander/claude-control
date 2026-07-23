import { describe, it, expect } from 'vitest';
import { fuzzyScore, rankByFuzzy } from './fuzzy';

/**
 * Нечёткий поиск по названиям разделов. Проверяем ровно то, за что он отвечает:
 * пропускать подпоследовательности, отбрасывать непопадания, регистр не важен,
 * а балл предпочитает начало слова и буквы подряд — иначе палитра поднимала бы
 * случайные совпадения выше очевидных.
 */

describe('fuzzyScore', () => {
  it('пустой запрос совпадает со всем нейтральным баллом', () => {
    expect(fuzzyScore('Обзор', '')).toBe(0);
    expect(fuzzyScore('Обзор', '   ')).toBe(0);
  });

  it('находит подпоследовательность букв по порядку', () => {
    expect(fuzzyScore('Настройки', 'наст')).not.toBeNull();
    expect(fuzzyScore('Настройки', 'нтр')).not.toBeNull();
  });

  it('не совпадает, когда буквы идут не по порядку', () => {
    expect(fuzzyScore('Обзор', 'роз')).toBeNull();
  });

  it('не совпадает, когда буквы нет вовсе', () => {
    expect(fuzzyScore('Чат', 'x')).toBeNull();
  });

  it('регистр не важен', () => {
    expect(fuzzyScore('MCP-серверы', 'mcp')).not.toBeNull();
    expect(fuzzyScore('mcp-серверы', 'MCP')).not.toBeNull();
  });

  it('совпадение с начала ценнее, чем в середине', () => {
    const fromStart = fuzzyScore('Права', 'пра');
    const fromMiddle = fuzzyScore('Операция', 'пра');
    expect(fromStart).not.toBeNull();
    expect(fromMiddle).not.toBeNull();
    expect(fromStart!).toBeGreaterThan(fromMiddle!);
  });
});

describe('rankByFuzzy', () => {
  const items = [
    { id: 'overview', label: 'Обзор' },
    { id: 'settings', label: 'Настройки' },
    { id: 'history', label: 'История изменений' },
    { id: 'mcp', label: 'MCP-серверы' },
  ];
  const label = (item: { label: string }) => item.label;

  it('оставляет только совпавшие элементы', () => {
    const ranked = rankByFuzzy(items, 'наст', label);
    expect(ranked.map((entry) => entry.item.id)).toEqual(['settings']);
  });

  it('пустой запрос сохраняет весь список в исходном порядке', () => {
    const ranked = rankByFuzzy(items, '', label);
    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'overview',
      'settings',
      'history',
      'mcp',
    ]);
  });

  it('сортирует по убыванию балла: точное начало выше', () => {
    const ranked = rankByFuzzy(items, 'ист', label);
    // «История» начинается с «ист» — должна стоять раньше «Настройки».
    expect(ranked[0]?.item.id).toBe('history');
  });

  it('при равном балле сохраняет исходный порядок', () => {
    const pair = [
      { id: 'a', label: 'Правила' },
      { id: 'b', label: 'Правила' },
    ];
    const ranked = rankByFuzzy(pair, 'прав', (item) => item.label);
    expect(ranked.map((entry) => entry.item.id)).toEqual(['a', 'b']);
  });
});
