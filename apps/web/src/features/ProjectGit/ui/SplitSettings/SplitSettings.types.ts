import type { SplitSettingsView } from '@agentdeck/contracts/task-split';

export interface SplitSettingsProps {
  /** Основная копия проекта — по ней настройка и хранится. */
  path: string;
  /** Уже прочитанная настройка проекта: её показывает и кнопка в шапке. */
  view: SplitSettingsView;
}

export interface DeliveryControlProps {
  /** Каталог проекта этого чата. */
  path: string;
}
