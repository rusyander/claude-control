import type { SectionKind, RuleSection } from './ruleSections.types';

export const SECTION_HEADING: Record<Exclude<SectionKind, 'custom'>, string> = {
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
