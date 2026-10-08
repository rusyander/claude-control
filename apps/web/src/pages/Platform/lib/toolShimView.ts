import type { PlatformToolShimReport } from '@agentdeck/contracts';

/**
 * Счётчик выброшенных: сервер прежней версии его не шлёт, и `undefined > 0`
 * прочиталось бы как ноль — то самое незнание под видом факта, от которого
 * заведена проверка формы выше.
 */
export function shimDropped(report: PlatformToolShimReport | undefined): number {
  return typeof report?.dropped === 'number' ? report.dropped : 0;
}
