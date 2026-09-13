import type { PlatformToolRoute, PlatformToolShimReport } from '@agentdeck/contracts';

/**
 * Решения карточки «Инструменты через контур» — здесь, а не в разметке: прогон
 * фронта идёт в node и компонентов не рендерит, а врать человеку можно ровно в
 * этих решениях.
 */

/**
 * Что показывает карточка, когда показывать нечего.
 *
 * `idle` — через шлюз не проходило ни одного запроса С ИНСТРУМЕНТАМИ, и о
 * прослойке панель не знает ничего. `quiet` — такие запросы шли, но ни одного
 * вызова не собралось и ни одной заявки не нашлось. Слить их в «вызовов нет»
 * значило бы выдать незнание за факт.
 */
export type ToolShimEmptyKind = 'idle' | 'quiet' | 'none';

/**
 * Сводка приходит без проверки схемы (обычное приведение типа в `getGateway`),
 * поэтому её форма проверяется здесь: неполный объект от сервера другой версии
 * не должен ронять весь раздел «Контур» ради одной карточки.
 */
function isReport(report: PlatformToolShimReport | undefined): report is PlatformToolShimReport {
  return Boolean(report) && Array.isArray(report?.flaws) && typeof report?.requests === 'number';
}

export function shimEmptyKind(report: PlatformToolShimReport | undefined): ToolShimEmptyKind {
  if (!isReport(report)) return 'none';
  if (report.requests === 0) return 'idle';
  if (report.calls > 0 || report.claimed > 0 || report.flaws.length > 0) return 'none';
  return 'quiet';
}

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
  return hasShimPlatform && gatewayRunning && isReport(report);
}

/**
 * Показывать ли решённый факт «инструменты объявляются текстом». Он про тип,
 * который `tools` полем не принимает, и у раздела, где все контуры получают
 * инструменты полем, это утверждение ложно (аудит DRV-13). Без контуров факт
 * остаётся: он объясняет, чем раздел обычно платит, до первого подключения.
 */
export function showsToolsFact(routes: readonly PlatformToolRoute[]): boolean {
  return routes.length === 0 || routes.some((route) => route !== 'native');
}
