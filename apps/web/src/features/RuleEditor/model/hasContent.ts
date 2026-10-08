import type { RuleSection } from './ruleSections.types';

/** Есть ли в конструкторе хоть один заполненный пункт. */
export function hasContent(sections: RuleSection[]): boolean {
  return sections.some((section) => section.items.some((item) => item.trim()));
}
