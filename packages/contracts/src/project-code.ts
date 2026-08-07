/**
 * Границы раскладки окна кода — ЗНАЧЕНИЯ, а не типы.
 *
 * Отдельный модуль под своим подпутём (`@claude-control/contracts/project-code`)
 * ровно по той же причине, что `uploads` и `vocabulary`: сервер идёт без сборки
 * (`--experimental-strip-types`) и берёт из бочки только типы — значение через
 * барель Node ESM не разрешит. Модуль ничего не импортирует.
 *
 * Обе стороны обязаны считать одинаково: клиент не даст утащить разделитель за
 * границу, сервер не поверит клиенту на слово.
 */

export const PROJECT_CODE_TREE_MIN = 200;
export const PROJECT_CODE_TREE_MAX = 720;
export const PROJECT_CODE_TREE_DEFAULT = 300;

/** Ширина в границах. Мусор (NaN, строка, ничего) — это умолчание, а не отказ. */
export function clampTreeWidth(value: unknown): number {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return PROJECT_CODE_TREE_DEFAULT;
  return Math.min(PROJECT_CODE_TREE_MAX, Math.max(PROJECT_CODE_TREE_MIN, width));
}
