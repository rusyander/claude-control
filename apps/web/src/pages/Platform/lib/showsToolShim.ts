import type { PlatformToolShimReport } from '@agentdeck/contracts';
import { isReport } from './isReport';
import { shimDropped } from './toolShimView';

/**
 * Показывать ли карточку вообще. Как и у проверок: выключенный контур обязан
 * вернуть панель к прежнему виду, а карточка о прослойке при мёртвом шлюзе
 * объясняет несуществующее.
 */
export function showsToolShim(
  hasShimPlatform: boolean,
  gatewayRunning: boolean,
  report: PlatformToolShimReport | undefined,
): boolean {
  // Выброшенные инструменты показываются и БЕЗ единого контура с прослойкой:
  // это ровно тот случай, ради которого карточка нужна больше всего — руки у
  // агента отобраны, а условие «есть контур с прослойкой» здесь ложно по
  // определению, потому что прослойка и выключена.
  if (!gatewayRunning || !isReport(report)) return false;
  return hasShimPlatform || shimDropped(report) > 0;
}
