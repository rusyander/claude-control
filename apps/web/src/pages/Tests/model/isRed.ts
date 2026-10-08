import type { ProjectTestStatus } from '@agentdeck/contracts';

/** Красное: провал и блокировка. Оба означают «результата нет». */
export function isRed(status: ProjectTestStatus): boolean {
  return status === 'failed' || status === 'blocked';
}
