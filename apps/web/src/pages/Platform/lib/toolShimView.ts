import type {
  Platform,
  PlatformSmokeTools,
  PlatformToolRoute,
  PlatformToolShimReport,
} from '@agentdeck/contracts';

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

/**
 * Сводка приходит без проверки схемы (обычное приведение типа в `getGateway`),
 * поэтому её форма проверяется здесь: неполный объект от сервера другой версии
 * не должен ронять весь раздел «Контур» ради одной карточки.
 */
function isReport(report: PlatformToolShimReport | undefined): report is PlatformToolShimReport {
  // Счётчики, на которых стоит «вызовов не было», проверяются тоже: без них
  // `undefined > 0` читалось бы как ноль, и незнание выдавалось бы за факт.
  return (
    Boolean(report) &&
    Array.isArray(report?.flaws) &&
    typeof report?.requests === 'number' &&
    typeof report?.calls === 'number' &&
    typeof report?.claimed === 'number'
  );
}

/**
 * Счётчик выброшенных: сервер прежней версии его не шлёт, и `undefined > 0`
 * прочиталось бы как ноль — то самое незнание под видом факта, от которого
 * заведена проверка формы выше.
 */
export function shimDropped(report: PlatformToolShimReport | undefined): number {
  return typeof report?.dropped === 'number' ? report.dropped : 0;
}

export function shimEmptyKind(report: PlatformToolShimReport | undefined): ToolShimEmptyKind {
  if (!isReport(report)) return 'none';
  if (report.requests === 0) return shimDropped(report) > 0 ? 'dropped' : 'idle';
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
  // Выброшенные инструменты показываются и БЕЗ единого контура с прослойкой:
  // это ровно тот случай, ради которого карточка нужна больше всего — руки у
  // агента отобраны, а условие «есть контур с прослойкой» здесь ложно по
  // определению, потому что прослойка и выключена.
  if (!gatewayRunning || !isReport(report)) return false;
  return hasShimPlatform || shimDropped(report) > 0;
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

/**
 * Наклонение строки пробы инструментов (развилка 3).
 *
 * `ok` — модель зовёт полем; `offer` — не зовёт, и прослойку предлагают кнопкой;
 * `auto` — прослойку по этому же итогу уже включила ПАНЕЛЬ, и строка отчитывается
 * о сделанном с кнопкой обратно; `none` — говорить не о чем.
 *
 * `auto` отдельно от `none` ровно потому, что прослойка включена: умолчание,
 * молчащее о себе, человек узнаёт по счёту за длинный ход, а не по карточке.
 */
export type SmokeToolsLineKind = 'ok' | 'offer' | 'auto' | 'none';

export function smokeToolsLineKind(
  platform: Pick<Platform, 'toolShim' | 'toolShimFromProbe'>,
  tools: PlatformSmokeTools,
): SmokeToolsLineKind {
  if (platform.toolShim) {
    // Прослойку включил человек — итог пробы остался от запуска БЕЗ неё и про
    // нынешний путь не говорит ничего.
    return platform.toolShimFromProbe && !tools.ok ? 'auto' : 'none';
  }
  return tools.ok ? 'ok' : 'offer';
}
