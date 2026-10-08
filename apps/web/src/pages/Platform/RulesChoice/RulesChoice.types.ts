import type { Platform } from '@agentdeck/contracts';

export interface RulesChoiceProps {
  platform: Platform;
  /** Заголовок над выбором: на карточке он нужен, на вкладке правил его несёт карточка. */
  withTitle?: boolean;
}
