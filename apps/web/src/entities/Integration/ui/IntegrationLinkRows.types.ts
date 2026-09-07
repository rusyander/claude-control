import type { IntegrationLink } from '@agentdeck/contracts';

export interface IntegrationLinkRowsProps {
  /** Привязка проекта или группы. Пустая — блок не рисуется вовсе. */
  link: IntegrationLink | undefined;
  /** Показывать подпись «ничего не привязано» вместо пустоты. */
  withEmpty?: boolean;
}
