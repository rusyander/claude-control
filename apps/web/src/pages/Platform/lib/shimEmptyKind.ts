import type { PlatformToolShimReport } from '@agentdeck/contracts';
import { isReport } from './isReport';
import { shimDropped } from './toolShimView';

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
 *
 * `dropped` — третье состояние, и оно не пустое: запросы с инструментами шли, но
 * прослойка была ВЫКЛЮЧЕНА, и полем контур их не принял. Сказать здесь `idle`
 * («панель не знает ничего») — соврать ровно там, где панель знает всё: она сама
 * и выбросила список, и знает переключатель, который это чинит.
 */
export type ToolShimEmptyKind = 'idle' | 'quiet' | 'dropped' | 'none';

export function shimEmptyKind(report: PlatformToolShimReport | undefined): ToolShimEmptyKind {
  if (!isReport(report)) return 'none';
  if (report.requests === 0) return shimDropped(report) > 0 ? 'dropped' : 'idle';
  if (report.calls > 0 || report.claimed > 0 || report.flaws.length > 0) return 'none';
  return 'quiet';
}
