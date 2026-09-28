import type { CompareSection } from '@agentdeck/contracts';
import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Сравнение» — по одной на раздел сравнения сервера: вопрос к
 * каждому один («что слева, что справа»), а модели записей несовместимы, и на
 * одной ленте четыре разные таблицы читались как одна. `id` = раздел сервера,
 * он же в адресе (`/compare?tab=…`).
 */
export const COMPARE_TABS = [
  'mcp',
  'env',
  'permissions',
  'instructions',
] as const satisfies readonly CompareSection[];

export type CompareTabId = (typeof COMPARE_TABS)[number];

export const COMPARE_TAB_ICONS: Record<CompareTabId, IconName> = {
  mcp: 'mcp',
  env: 'env',
  permissions: 'permissions',
  instructions: 'file',
};
