import type { IconName } from '@shared/ui/icon';

export interface StatTileProps {
  icon: IconName;
  label: string;
  value: number;
  hint?: string;
  /** Тревожный тон подсказки — например, когда есть сломанные хуки. */
  tone?: 'danger';
  to: string;
}
