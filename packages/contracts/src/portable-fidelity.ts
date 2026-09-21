/**
 * Словарь ВЕРНОСТИ переноса: на каком уровне запись канона доедет до конкретного
 * CLI и почему именно на этом.
 *
 * Уровень здесь только НАЗВАН. Считается он `domains/portability/fidelity.ts` из
 * двух источников — требований записи (`needs` канона) и возможностей цели в
 * каталоге провайдеров. Таблицы «провайдер → уровень» не существует ни здесь, ни
 * там: она и есть то, что начинает лгать на одиннадцатом CLI (§5.4 плана).
 *
 * МОДУЛЬ САМОДОСТАТОЧЕН И БЕЗ ZOD, как `portable-env.ts`: сервер берёт его точкой
 * экспорта `@agentdeck/contracts/portable-fidelity`, минуя бочку. Ни одного
 * импорта здесь появиться не должно — проверка этого живёт в наборе тестов.
 */

/**
 * Пять уровней верности (§2 плана). Коды английские, как и всё в канонe; буквы
 * матрицы — их показ человеку, а не вторые имена:
 *
 * - `native` (Н) — у цели есть тот же механизм, запись переезжает в его формат;
 * - `emulated` (Э) — механизма нет, его отыгрывает панель вокруг СВОЕГО запуска
 *   CLI: без панели запись не действует;
 * - `wired` (П) — нужен контур или DLP-прокси в пути запроса;
 * - `text` (Т) — запись превращается в инструкцию модели: соблюдение вместо
 *   принуждения;
 * - `impossible` (×) — никакой уровень не спасает, и причина названа вслух.
 *
 * Порядок массива — от лучшего к худшему, и он значим: `worstFidelity`
 * сравнивает уровни именно по нему («уровень записи считается по худшему из её
 * `needs`»).
 */
export const fidelityLevels = ['native', 'emulated', 'wired', 'text', 'impossible'] as const;

export type FidelityLevel = (typeof fidelityLevels)[number];

/*
 * Здесь была `worksWithoutPanel(level)`, и её никто не звал — строку «работает
 * только при запуске через панель» считает `countOnlyThroughPanel` ПО УСЛОВИЮ
 * приговора. Удалена не за неиспользование, а за ложь в имени: `wired` она
 * относила к «не работает без панели», тогда как проводу панель не нужна вовсе —
 * ему нужен контур, и это другое условие, у которого свой текст в строке.
 * Функция, ждущая первого вызывающего, чтобы соврать, хуже отсутствующей.
 */

/** Худший из двух уровней — порядок берётся из `fidelityLevels`. */
export function worstFidelity(left: FidelityLevel, right: FidelityLevel): FidelityLevel {
  return fidelityLevels.indexOf(left) >= fidelityLevels.indexOf(right) ? left : right;
}

/**
 * Почему уровень именно такой. Словарь ЗАКРЫТ: каждая причина переводится на
 * экране, а «×» без причины из этого списка в отчёт не попадает вовсе (критерий
 * приёмки П1.1).
 *
 * - `target_mechanism` — у цели есть тот же механизм, запись едет в его формат;
 * - `target_shares_location` — цель читает ТОТ ЖЕ каталог, что и источник
 *   (`~/.claude/skills` у kimi и opencode): переносить нечего, довольно не мешать;
 * - `no_mechanism` — раздела у цели нет вовсе;
 * - `mechanism_read_only` — раздел есть, но панель в него не пишет (ключ исчез из
 *   документации, состоянием владеет сам CLI);
 * - `event_absent` — механизм хуков есть, но такого события у него нет;
 * - `tool_events_absent` — записи нужны факты вызова инструмента, а их механизм
 *   цели не даёт: снаружи процесса их видно только проводу;
 * - `blocking_lost` — событие у цели есть, но остановить действие оно не может;
 *   молча превратить запрет в наблюдение нельзя (инвариант 6);
 * - `needs_undetermined` — требования записи вывести не удалось, поэтому она
 *   считается требующей всего сразу;
 * - `decision_downgraded` — решение правила цель не знает и оно понижено в
 *   сторону строгости (`ask` → `deny`); во что именно — сказано полем `decision`;
 * - `decision_unrepresentable` — решения строже у цели нет вовсе, а ослабить
 *   правило нельзя (инвариант 6): выразить его механизмом цели невозможно;
 * - `value_not_carried` — значение не переносится по построению (секрет живёт в
 *   окружении процесса и нигде не сохраняется, инвариант 5);
 * - `in_process_only` — сущность живёт внутри чужого процесса (`"type":"sdk"` у
 *   MCP-сервера) и вне его не существует;
 * - `account_only` — тела записи на диске нет: скилл или плагин синхронизирован
 *   с аккаунтом (`origin: 'account'`), и переносить у цели нечего. Записать её
 *   пустым телом было бы хуже отказа: у цели появился бы скилл с тем же именем
 *   и без содержимого;
 * - `unit_not_installable` — плагин у источника установлен чужим магазином или
 *   реестром (`form: 'installed'`): ни кода, ни имени пакета у панели нет, а
 *   установка плагинов у цели вне объёма партии. Едет СОДЕРЖИМОЕ плагина —
 *   скиллы, команды, хуки, субагенты обычными записями;
 * - `panel_only_construct` — конструкция самой панели (группы, разговоры): у
 *   чужого CLI её нет ни у кого;
 * - `no_panel_run` — панель не умеет запускать этот CLI, поэтому отыграть
 *   механизм вокруг запуска не может;
 * - `no_wire` — своего адреса у CLI не задокументировано, провод не поставить.
 */
export const fidelityReasons = [
  'target_mechanism',
  'target_shares_location',
  'no_mechanism',
  'mechanism_read_only',
  'event_absent',
  'tool_events_absent',
  'blocking_lost',
  'needs_undetermined',
  'decision_downgraded',
  'decision_unrepresentable',
  'value_not_carried',
  'in_process_only',
  'account_only',
  'unit_not_installable',
  'panel_only_construct',
  'no_panel_run',
  'no_wire',
] as const;

export type FidelityReason = (typeof fidelityReasons)[number];

/**
 * При каком условии уровень держится. Условие — не украшение: `emulated` без
 * запуска через панель не существует вовсе, и человек обязан узнать это ДО
 * переноса, а не после.
 *
 * - `run_through_panel` — запускать CLI из панели;
 * - `enable_contour` — включить контур/DLP-прокси в путь запроса.
 */
export const fidelityConditions = ['run_through_panel', 'enable_contour'] as const;

export type FidelityCondition = (typeof fidelityConditions)[number];

/**
 * Приговор одной записи.
 *
 * `fallback` — четвёртое поле сверх названных в тикете, и оно там не от
 * избытка: клетки матрицы вида «Э/Т» — это ровно пара «уровень при выполненном
 * условии / уровень без него». Без `fallback` отчёт обещал бы эмуляцию тому, кто
 * запускает CLI сам, а обещание уровня, которого не будет, — та же ложь, что и
 * молчаливая потеря записи. Условия нет ⇒ `fallback` равен `level`.
 */
export interface FidelityVerdict {
  readonly level: FidelityLevel;
  readonly reason: FidelityReason;
  readonly condition: FidelityCondition | null;
  readonly fallback: FidelityLevel;
  /**
   * ВО ЧТО превращается решение правила у цели. Есть только у записей прав, и
   * только там, где вопрос вообще стоит: решение цель знает — здесь оно само,
   * не знает — названа замена (строже исходного, инвариант 6). Поле
   * необязательное ровно потому, что у остальных видов записи решения нет и
   * выдумывать его нечем; а у прав без него «понижено в сторону строгости» —
   * заявление, из которого эмиттер (П2.2) не может записать ни одной строки.
   */
  readonly decision?: 'allow' | 'ask' | 'deny';
}

/** Строка отчёта: приговор плюс то, о чём он вынесен. */
export interface FidelityRow extends FidelityVerdict {
  /** Идентификатор записи канона (`skill:doc-hygiene`) — строка раскрывается до неё. */
  readonly itemId: string;
  /** Вид записи — по нему отчёт группируется на экране. */
  readonly kind: string;
  /** Одна фраза человеку: та же, что у записи канона. */
  readonly intent: string;
}

/** Сводка отчёта: сколько записей на каждом уровне. Считается, а не пишется рукой. */
export type FidelitySummary = Readonly<Record<FidelityLevel, number>>;

/**
 * Отчёт верности: что будет с каждой записью паспорта у выбранной цели.
 *
 * Версия канона и дата лежат ВНУТРИ отчёта, потому что он переживает сессию
 * (хранится в `state.json` рядом с планом переноса): прочитанный завтра отчёт
 * обязан уметь сказать, что он посчитан по другому словарю, а не тихо сойти за
 * сегодняшний.
 */
export interface FidelityReport {
  readonly canonVersion: number;
  /** Откуда снят паспорт. */
  readonly source: string;
  /** Куда считается перенос. */
  readonly target: string;
  readonly scope: string;
  readonly computedAt: string;
  readonly rows: readonly FidelityRow[];
  readonly summary: FidelitySummary;
  /**
   * Сколько записей держится только на запуске через панель. Считается из строк
   * (`condition === 'run_through_panel'`) — это и есть та строка отчёта, которую
   * человек обязан увидеть до применения.
   */
  readonly onlyThroughPanel: number;
}

/**
 * ОТТИСК отчёта — всё, что переживает сессию: обещание без строк.
 *
 * Строки в состояние панели не кладутся вовсе. Отчёт по реальному дому — это
 * 55 КБ на пару «источник → цель», а пар до двухсот: `state.json` вырастал бы в
 * мегабайты копий того, что и так считается заново на каждом запросе. Вопрос,
 * ради которого оттиск хранится, один — «что панель обещала в прошлый раз», — и
 * на него отвечают сводка, дата и версия словаря.
 */
export interface FidelityMark {
  readonly computedAt: string;
  readonly canonVersion: number;
  readonly summary: FidelitySummary;
  readonly onlyThroughPanel: number;
}

export function fidelityMark(report: FidelityReport): FidelityMark {
  return {
    computedAt: report.computedAt,
    canonVersion: report.canonVersion,
    summary: report.summary,
    onlyThroughPanel: report.onlyThroughPanel,
  };
}

/**
 * Одно ли это ОБЕЩАНИЕ. Дата нарочно не сравнивается: она у каждого расчёта
 * своя, и по ней «прошлый раз» означал бы «секунду назад» — ровно то, во что
 * вырождался хранимый отчёт, пока маршрут переписывал его на каждом запросе.
 */
export function sameFidelityPromise(left: FidelityMark, right: FidelityMark): boolean {
  return (
    left.canonVersion === right.canonVersion &&
    left.onlyThroughPanel === right.onlyThroughPanel &&
    fidelityLevels.every((level) => left.summary[level] === right.summary[level])
  );
}

/** Прошлый расчёт в ответе: оттиск плюс признак «посчитан тем же словарём». */
export interface PreviousFidelity extends FidelityMark {
  readonly readable: boolean;
}

/**
 * Ответ маршрута верности. Живёт в контрактах, а не двумя объявлениями по
 * сторонам: отчёт внутри — общий тип, а конверт был переписан рукой на экране, и
 * переименованное на сервере поле собиралось на обеих сторонах, показывая
 * `undefined` человеку.
 */
export interface FidelityAnswer {
  readonly report: FidelityReport;
  readonly previous: PreviousFidelity | null;
}

/** Пустая сводка — основа подсчёта; заводится здесь, чтобы никто не забыл уровень. */
export function emptyFidelitySummary(): Record<FidelityLevel, number> {
  return { native: 0, emulated: 0, wired: 0, text: 0, impossible: 0 };
}

/** Сводка по строкам отчёта. Ровно одна реализация — и у сервера, и у экрана. */
export function summarizeFidelity(rows: readonly FidelityRow[]): FidelitySummary {
  const summary = emptyFidelitySummary();
  for (const row of rows) summary[row.level] += 1;
  return summary;
}

/** Сколько строк действует только при запуске через панель. */
export function countOnlyThroughPanel(rows: readonly FidelityRow[]): number {
  return rows.filter((row) => row.condition === 'run_through_panel').length;
}
