import type { SettingsSource } from '@claude-control/contracts';

export interface SourceBadgeProps {
  /** Источник записи. Для 'settings' бейдж не рисуется: это обычный случай. */
  source: SettingsSource;
}
