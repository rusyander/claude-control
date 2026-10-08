import type { PortabilityLevel } from '@entities/Portability';

export interface SubscriptionSectionProps {
  target: string;
  targetName: string;
  level: PortabilityLevel;
  /** Провайдер, выбранный источником на экране, — нужен ОДНОЙ строке. */
  source: string;
}
