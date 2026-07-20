import type {
  Analytics,
  DailyUsage,
  ModelUsage,
  ProjectUsage,
  SessionUsage,
  TokenTotals,
} from '@claude-control/contracts';

/**
 * Сборка выгрузки аналитики (CSV/JSON). Вынесено из страницы в чистые функции:
 * корректность колонок и экранирование — это логика, которую надо проверять
 * тестом, а не глазами в разметке.
 *
 * CSV собирается несколькими секциями (по дням, моделям, проектам, сессиям) —
 * именно разрез по моделям/проектам чаще нужен для отчёта, а не только дни.
 * У каждой числовой секции есть колонка `estimatedCost`: стоимость доступна и
 * без неё отчёт неполон.
 */

/** Колонки дневного CSV. Порядок фиксирован — на него смотрит тест. */
export const DAILY_CSV_HEADER = [
  'date',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
] as const;

/** Колонки CSV по моделям. */
export const MODEL_CSV_HEADER = [
  'model',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
] as const;

/** Колонки CSV по проектам. */
export const PROJECT_CSV_HEADER = [
  'project',
  'displayName',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
  'sessions',
  'lastActivity',
] as const;

/** Колонки CSV по недавним сессиям. */
export const SESSION_CSV_HEADER = [
  'sessionId',
  'project',
  'displayName',
  'startedAt',
  'lastActivity',
  'total',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'requests',
  'estimatedCost',
  'models',
  'isActive',
] as const;

/**
 * Экранирование ячейки CSV.
 *
 * Две задачи сразу:
 *   1. Кавычки/запятые/переносы — по RFC 4180: оборачиваем в кавычки, внутренние
 *      кавычки удваиваем. Иначе значение с запятой разъедет столбцы.
 *   2. Инъекция формул: ячейка, начинающаяся с `= + - @` или управляющего
 *      символа, в Excel/Sheets исполняется как формула. Гасим ведущим апострофом
 *      — тогда табличный редактор покажет текст, а не выполнит его.
 *
 * Теперь в CSV попадают и текстовые колонки (модель, проект, ветка git), где
 * инъекция уже достижима, поэтому защита ставится ко всем ячейкам, а не только к
 * числовым.
 */
export function csvCell(value: string | number | boolean): string {
  const text = String(value);

  // Ловим и управляющие префиксы (\t, \r) — с них тоже начинают инъекцию.
  const dangerousLead = /^[=+\-@\t\r]/.test(text);
  const guarded = dangerousLead ? `'${text}` : text;

  if (/[",\r\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

/** Строка CSV из ячеек с экранированием каждой. */
function csvRow(cells: Array<string | number | boolean>): string {
  return cells.map(csvCell).join(',');
}

/** Собрать CSV из заголовка и строк данных (по-Windows перенос `\r\n`). */
function toCsv(header: readonly string[], rows: Array<Array<string | number | boolean>>): string {
  return [csvRow([...header]), ...rows.map(csvRow)].join('\r\n');
}

/** Пять токен-колонок в фиксированном порядке — общий хвост числовых секций. */
function tokenCells(totals: TokenTotals): Array<string | number> {
  return [
    totals.total,
    totals.input,
    totals.output,
    totals.cacheRead,
    totals.cacheCreation,
    totals.requests,
  ];
}

/**
 * Дневной CSV: одна строка на день. Колонки включают cacheCreation (без неё
 * `total` не сходился с суммой показанных столбцов) и estimatedCost.
 *
 * Пустой byDay → только заголовок: файл валиден, просто без строк.
 */
export function buildDailyCsv(byDay: DailyUsage[]): string {
  return toCsv(
    DAILY_CSV_HEADER,
    byDay.map((day) => [day.date, ...tokenCells(day.totals), day.estimatedCost]),
  );
}

/** CSV по моделям: разрез, который для отчёта нужен чаще дневного. */
export function buildModelsCsv(byModel: ModelUsage[]): string {
  return toCsv(
    MODEL_CSV_HEADER,
    byModel.map((model) => [model.model, ...tokenCells(model.totals), model.estimatedCost]),
  );
}

/** CSV по проектам: расход, стоимость, число сессий и последняя активность. */
export function buildProjectsCsv(byProject: ProjectUsage[]): string {
  return toCsv(
    PROJECT_CSV_HEADER,
    byProject.map((project) => [
      project.project,
      project.displayName,
      ...tokenCells(project.totals),
      project.estimatedCost,
      project.sessions,
      project.lastActivity,
    ]),
  );
}

/** CSV по недавним сессиям. Модели склеиваются через `; ` в одну ячейку. */
export function buildSessionsCsv(recentSessions: SessionUsage[]): string {
  return toCsv(
    SESSION_CSV_HEADER,
    recentSessions.map((session) => [
      session.sessionId,
      session.project,
      session.displayName,
      session.startedAt,
      session.lastActivity,
      ...tokenCells(session.totals),
      session.estimatedCost,
      session.models.join('; '),
      session.isActive,
    ]),
  );
}

/** Заголовок секции отдельной строкой-ячейкой над её таблицей. */
function titledSection(title: string, csv: string): string {
  return `${csvCell(title)}\r\n${csv}`;
}

/**
 * Полный CSV-отчёт: все разрезы в одном файле, секции разделены пустой строкой
 * и подписаны. Одна кнопка — весь расход: по дням, моделям, проектам и сессиям.
 */
export function buildReportCsv(data: Analytics): string {
  return [
    titledSection('По дням', buildDailyCsv(data.byDay)),
    titledSection('По моделям', buildModelsCsv(data.byModel)),
    titledSection('По проектам', buildProjectsCsv(data.byProject)),
    titledSection('Недавние сессии', buildSessionsCsv(data.recentSessions)),
  ].join('\r\n\r\n');
}

/**
 * JSON-выгрузка снимка аналитики.
 *
 * Из выгрузки исключаются `runningAgents` — это живые процессы машины на момент
 * снимка, а не исторический расход. Отчёту «о расходе» они не нужны, а файл,
 * который уходит в чужие руки, не должен нести сведения о текущих процессах.
 */
export function buildJson(data: Analytics): string {
  const exportable: Partial<Analytics> = { ...data };
  delete exportable.runningAgents;
  return JSON.stringify(exportable, null, 2);
}
