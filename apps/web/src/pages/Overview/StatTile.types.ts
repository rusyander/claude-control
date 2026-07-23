import type { IconName } from '@shared/ui/icon';

/**
 * Быстрое действие на плитке: короткая ссылка на осмысленное действие в разделе
 * (создать сущность, открыть смежную страницу). Логику не несёт — только ведёт
 * по адресу, а действие выполняет уже сам раздел (форма создания, история).
 */
export interface QuickAction {
  label: string;
  /** Адрес назначения — тот же строковый путь, что у маршрутов роутера. */
  to: string;
  /** Параметры адреса, например `{ create: true }` для открытия формы. */
  search?: Record<string, unknown>;
  icon?: IconName;
}

export interface StatTileProps {
  icon: IconName;
  label: string;
  value: number;
  hint?: string;
  /** Тревожный тон подсказки — например, когда есть сломанные хуки. */
  tone?: 'danger';
  to: string;
  /** Быстрые действия под сводкой: «Добавить», «Открыть историю» и т. п. */
  actions?: QuickAction[];
}
