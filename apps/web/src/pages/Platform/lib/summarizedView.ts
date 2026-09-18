import type { PlatformSummarizedLink, PlatformSummarizedReport } from '@agentdeck/contracts';

/**
 * Решения карточки «Контур сжимал историю» — здесь, а не в разметке: прогон
 * фронта идёт в node и компонентов не рендерит.
 */

const LINKS: readonly PlatformSummarizedLink[] = ['message', 'run', 'none'];

/**
 * Сводка приходит без проверки схемы: сервер другой версии пришлёт её неполной
 * или не пришлёт вовсе, и раздел «Контур» не должен падать ради одной карточки.
 */
export function isSummarizedReport(
  report: PlatformSummarizedReport | undefined,
): report is PlatformSummarizedReport {
  return Boolean(report) && typeof report?.total === 'number' && Array.isArray(report?.recent);
}

/**
 * Показывать ли карточку. Как у проверок: выключенный контур и погашенный шлюз
 * возвращают раздел к прежнему виду.
 */
export function showsSummarized(
  hasEnabledPlatform: boolean,
  gatewayRunning: boolean,
  report: PlatformSummarizedReport | undefined,
): boolean {
  return hasEnabledPlatform && gatewayRunning && isSummarizedReport(report);
}

/** Привязка случая; незнакомое слово сервера читается как «подписать негде». */
export function summarizedLinkOf(link: unknown): PlatformSummarizedLink {
  return LINKS.includes(link as PlatformSummarizedLink) ? (link as PlatformSummarizedLink) : 'none';
}
