import type { KitItemKind } from '@agentdeck/contracts/kit';
import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки страницы «Набор панели» — по виду элемента. Порядок — от того, что
 * агент берёт сам (навыки), к тому, что зовёт человек (пайплайны), к помощникам,
 * которых агент запускает сам (субагенты), и к тому, что действует всегда
 * (правила, хуки). `id` попадает в адрес (`/kit?tab=…`).
 */
export const KIT_TABS = [
  'skill',
  'command',
  'agent',
  'rule',
  'hook',
] as const satisfies readonly KitItemKind[];

export const KIT_TAB_ICONS: Record<KitItemKind, IconName> = {
  skill: 'skills',
  command: 'commands',
  agent: 'groups',
  rule: 'rules',
  hook: 'hooks',
};
