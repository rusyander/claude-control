import type { RuleSection } from './ruleSections.types';

/** Стартовый набор: два типовых блока («можно», «нельзя»), каждый с одним пустым пунктом. */
export function defaultSections(): RuleSection[] {
  return [
    { kind: 'allow', items: [''] },
    { kind: 'deny', items: [''] },
  ];
}
