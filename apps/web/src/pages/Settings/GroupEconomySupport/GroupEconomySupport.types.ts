import type { ProviderInfo } from '@agentdeck/contracts';
import type { GroupEconomyLever } from '@agentdeck/contracts/group-economy-support';

export interface GroupEconomySupportProps {
  /** Рычаг, под чьим полем стоит строка отметок. */
  lever: GroupEconomyLever;
  /** Провайдеры из `/api/providers`; рисуются только объявившие этот рычаг. */
  providers: readonly ProviderInfo[];
}
