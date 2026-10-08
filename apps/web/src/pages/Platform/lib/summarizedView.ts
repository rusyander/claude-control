import type { PlatformSummarizedReport } from '@agentdeck/contracts';

/**
 * Сводка приходит без проверки схемы: сервер другой версии пришлёт её неполной
 * или не пришлёт вовсе, и раздел «Контур» не должен падать ради одной карточки.
 */
export function isSummarizedReport(
  report: PlatformSummarizedReport | undefined,
): report is PlatformSummarizedReport {
  return Boolean(report) && typeof report?.total === 'number' && Array.isArray(report?.recent);
}
