import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Защита данных». Порядок — порядок настройки: сам прокси,
 * правила, проверка правил на пробном тексте, журнал срабатываний и последним —
 * гейт на промпте: он видит меньше прокси, и рядом с ним читался бы заменой.
 * `id` попадает в адрес (`/dlp?tab=…`).
 */
export const DLP_TABS = ['proxy', 'rules', 'check', 'journal', 'gate'] as const;

export type DlpTabId = (typeof DLP_TABS)[number];

export const DLP_TAB_ICONS: Record<DlpTabId, IconName> = {
  proxy: 'lock',
  rules: 'rules',
  check: 'eye',
  journal: 'history',
  gate: 'hooks',
};
