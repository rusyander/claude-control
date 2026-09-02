/**
 * Модель составного правила: набор смысловых блоков, из которых собирается
 * текст правила. Блоки и их сборка в markdown вынесены сюда, чтобы конструктор
 * занимался только интерфейсом.
 */

export type SectionKind = 'allow' | 'deny' | 'caution' | 'custom';

export interface RuleSection {
  kind: SectionKind;
  /** Заголовок — только у произвольной секции; у остальных он предопределён. */
  title?: string;
  items: string[];
}

/** Стартовый набор: два типовых блока («можно», «нельзя»), каждый с одним пустым пунктом. */
export function defaultSections(): RuleSection[] {
  return [
    { kind: 'allow', items: [''] },
    { kind: 'deny', items: [''] },
  ];
}

const SECTION_HEADING: Record<Exclude<SectionKind, 'custom'>, string> = {
  allow: 'Что можно',
  deny: 'Что нельзя',
  caution: 'С осторожностью',
};

/**
 * Сборка блоков в текст правила. Пустые пункты и пустые секции отбрасываются:
 * в файл должно уйти только заполненное.
 */
export function sectionsToMarkdown(sections: RuleSection[]): string {
  const blocks: string[] = [];

  for (const section of sections) {
    const items = section.items.map((item) => item.trim()).filter(Boolean);
    if (items.length === 0) continue;

    const heading =
      section.kind === 'custom' ? section.title?.trim() || 'Раздел' : SECTION_HEADING[section.kind];

    blocks.push(`## ${heading}\n${items.map((item) => `- ${item}`).join('\n')}`);
  }

  return blocks.join('\n\n');
}

/** Есть ли в конструкторе хоть один заполненный пункт. */
export function hasContent(sections: RuleSection[]): boolean {
  return sections.some((section) => section.items.some((item) => item.trim()));
}
