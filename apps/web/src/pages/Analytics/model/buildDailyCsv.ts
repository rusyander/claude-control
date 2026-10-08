import type { DailyUsage } from '@agentdeck/contracts';
import { toCsv } from './toCsv';
import { tokenCells } from './tokenCells';

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
