import type { PlatformSummarizedReport } from '@agentdeck/contracts';
import { isSummarizedReport } from './summarizedView';

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
