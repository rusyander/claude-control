import { describe, it, expect } from 'vitest';
import { defaultSections, sectionsToMarkdown, hasContent, type RuleSection } from './ruleSections';

/**
 * Конструктор правила собирает текст, который уходит в живой `CLAUDE.md`.
 * Отсюда требовательность к пустякам: лишний заголовок без пунктов или
 * пункт из одних пробелов попадут в файл, который Claude Code читает при
 * каждом старте, и останутся там мусором до ручной правки.
 */

describe('defaultSections', () => {
  it('даёт два блока с одним пустым пунктом каждый', () => {
    expect(defaultSections()).toEqual<RuleSection[]>([
      { kind: 'allow', items: [''] },
      { kind: 'deny', items: [''] },
    ]);
  });

  it('возвращает новые объекты при каждом вызове', () => {
    // Общий массив на два открытия формы означал бы, что правка одного
    // черновика меняет другой.
    const first = defaultSections();
    const second = defaultSections();
    first[0]?.items.push('добавлено');
    expect(second[0]?.items).toEqual(['']);
  });
});

describe('sectionsToMarkdown', () => {
  it('собирает блок с предопределённым заголовком и списком', () => {
    const markdown = sectionsToMarkdown([
      { kind: 'allow', items: ['читать код', 'править фронт'] },
    ]);
    expect(markdown).toBe('## Что можно\n- читать код\n- править фронт');
  });

  it('переводит вид блока в свой заголовок', () => {
    expect(sectionsToMarkdown([{ kind: 'deny', items: ['трогать бэк'] }])).toContain(
      '## Что нельзя',
    );
    expect(sectionsToMarkdown([{ kind: 'caution', items: ['миграции'] }])).toContain(
      '## С осторожностью',
    );
  });

  it('разделяет блоки пустой строкой', () => {
    const markdown = sectionsToMarkdown([
      { kind: 'allow', items: ['раз'] },
      { kind: 'deny', items: ['два'] },
    ]);
    expect(markdown).toBe('## Что можно\n- раз\n\n## Что нельзя\n- два');
  });

  it('обрезает пробелы вокруг пункта', () => {
    expect(sectionsToMarkdown([{ kind: 'allow', items: ['  читать код  '] }])).toBe(
      '## Что можно\n- читать код',
    );
  });

  it('выбрасывает пустые пункты, оставляя заполненные', () => {
    const markdown = sectionsToMarkdown([{ kind: 'allow', items: ['раз', '', '   ', 'два'] }]);
    expect(markdown).toBe('## Что можно\n- раз\n- два');
  });

  it('блок без единого заполненного пункта не попадает в текст', () => {
    // Иначе в CLAUDE.md уходил бы заголовок с пустотой под ним.
    const markdown = sectionsToMarkdown([
      { kind: 'allow', items: ['', '  '] },
      { kind: 'deny', items: ['нельзя'] },
    ]);
    expect(markdown).toBe('## Что нельзя\n- нельзя');
  });

  it('пустой набор блоков даёт пустую строку', () => {
    expect(sectionsToMarkdown([])).toBe('');
  });

  it('все блоки пустые — текста нет вовсе', () => {
    expect(sectionsToMarkdown([{ kind: 'allow', items: [''] }])).toBe('');
  });

  it('произвольный блок берёт свой заголовок', () => {
    expect(sectionsToMarkdown([{ kind: 'custom', title: 'Мой раздел', items: ['пункт'] }])).toBe(
      '## Мой раздел\n- пункт',
    );
  });

  it('произвольный блок без заголовка получает запасной', () => {
    expect(sectionsToMarkdown([{ kind: 'custom', items: ['пункт'] }])).toBe('## Раздел\n- пункт');
  });

  it('заголовок из одних пробелов тоже заменяется запасным', () => {
    expect(sectionsToMarkdown([{ kind: 'custom', title: '   ', items: ['пункт'] }])).toBe(
      '## Раздел\n- пункт',
    );
  });
});

describe('hasContent', () => {
  it('пустой набор блоков — содержимого нет', () => {
    expect(hasContent([])).toBe(false);
  });

  it('блоки только с пустыми пунктами — содержимого нет', () => {
    expect(hasContent(defaultSections())).toBe(false);
  });

  it('пункт из одних пробелов за содержимое не считается', () => {
    expect(hasContent([{ kind: 'allow', items: ['   ', '\t'] }])).toBe(false);
  });

  it('хотя бы один заполненный пункт — содержимое есть', () => {
    expect(
      hasContent([
        { kind: 'allow', items: [''] },
        { kind: 'deny', items: ['', 'нельзя'] },
      ]),
    ).toBe(true);
  });
});
