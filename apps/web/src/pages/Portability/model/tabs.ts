import type { IconName } from '@shared/ui/icon';

/**
 * Вкладки раздела «Паспорт среды». Порядок — порядок разговора: что у меня
 * есть; что доедет и как перенести; держать ли цель согласованной дальше;
 * доехало ли на самом деле; и отдельно — незакрытая работа, у которой своя
 * цель (активный CLI). `id` попадает в адрес (`/portability?tab=…`).
 */
export const PORTABILITY_TABS = ['passport', 'transfer', 'subscription', 'probe', 'carry'] as const;

export type PortabilityTabId = (typeof PORTABILITY_TABS)[number];

/** Вкладки, которые отвечают про выбранную ЦЕЛЬ переноса: без неё им нечего показать. */
export const TARGET_TABS: readonly PortabilityTabId[] = ['transfer', 'subscription', 'probe'];

export const PORTABILITY_TAB_ICONS: Record<PortabilityTabId, IconName> = {
  passport: 'file',
  transfer: 'swap',
  subscription: 'refresh',
  probe: 'check',
  carry: 'chat',
};
