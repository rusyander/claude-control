import type { PlatformViolationReport, PlatformViolationRow } from '@agentdeck/contracts';

/**
 * Решения карточки «Проверки контура» — здесь, а не в разметке: прогон фронта
 * идёт в node и компонентов не рендерит, а решений тут ровно те, в которых
 * можно соврать человеку.
 */

/**
 * Что показывает карточка, когда показывать нечего.
 *
 * Две разные пустоты, и путать их нельзя. `idle` — через шлюз не прошло ни
 * одного запроса, и о проверках панель не знает НИЧЕГО. `clean` — запросы шли,
 * проверки ни разу не срабатывали. Общее «нарушений нет» на месте первого —
 * враньё: молчание там не утверждение, а незнание.
 *
 * Безымянных срабатываний в этом решении нет: они не пустота. Контур вправе
 * отказать, оборвать или замаскировать, не назвав ни одной проверки, и такой
 * ответ карточка показывает своими строками — `clean` рядом с ними означал бы
 * «проверки молчали» про запрос, который не приняли.
 */
export type ViolationsEmptyKind = 'idle' | 'clean' | 'none';

/** Есть ли вообще что показать: названная проверка или безымянное срабатывание. */
function hasFacts(report: PlatformViolationReport): boolean {
  return (
    report.rows.length > 0 ||
    report.maskedUnnamed > 0 ||
    report.blockedUnnamed > 0 ||
    report.interruptedUnnamed > 0
  );
}

/**
 * Сводка приходит без проверки схемы (`getGateway` — обычное приведение типа),
 * поэтому её форма проверяется здесь. Неполный объект от сервера другой версии
 * не должен ронять раздел: `rows.length` на таком объекте — исключение в
 * рендере, а оно уносит всю страницу «Контур», а не одну карточку.
 */
function isReport(report: PlatformViolationReport | undefined): report is PlatformViolationReport {
  return Boolean(report) && Array.isArray(report?.rows);
}

export function emptyKind(report: PlatformViolationReport | undefined): ViolationsEmptyKind {
  if (!isReport(report)) return 'none';
  if (hasFacts(report)) return 'none';
  return report.since ? 'clean' : 'idle';
}

/**
 * Насколько срочна строка. Обрыв и отказ человек увидел сам — ответа не было
 * или он оборвался; маскировка не видна вовсе, и ответ выглядит нормальным,
 * поэтому её и подсвечиваем громче: тихая правда важнее громкой.
 */
export function rowTone(row: PlatformViolationRow): 'warning' | 'danger' | 'neutral' {
  if (row.actions.includes('masked')) return 'warning';
  if (row.actions.includes('blocked') || row.actions.includes('interrupted')) return 'danger';
  return 'neutral';
}

/**
 * Показывать ли карточку вообще.
 *
 * Выключенный контур обязан вернуть панель к сегодняшнему поведению побайтно —
 * значит и карточки быть не должно: раздел, рассказывающий о проверках чужой
 * платформы, к которой панель не подключена, объясняет несуществующее.
 *
 * Сводки может не быть в ответе вовсе или она может прийти неполной — сервер
 * старее фронта, ответ из кэша браузера, заглушка прогона. Это не «проверок не
 * было», это «панель не знает», и молчать тут честнее, чем рисовать пустую
 * карточку или ронять раздел на первом же обращении к полю.
 */
export function showsViolations(
  hasEnabledPlatform: boolean,
  gatewayRunning: boolean,
  report: PlatformViolationReport | undefined,
): boolean {
  return hasEnabledPlatform && gatewayRunning && isReport(report);
}
