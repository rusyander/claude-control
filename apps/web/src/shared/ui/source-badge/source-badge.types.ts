import type { SettingsSource } from '@agentdeck/contracts';

export interface SourceBadgeProps {
  /** Источник записи. Для 'settings' бейдж не рисуется: это обычный случай. */
  source: SettingsSource;
}
