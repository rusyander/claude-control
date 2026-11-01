/**
 * Порог тишины сессии (06:138, F9 этапа 8): сколько активного времени сессия может молчать с ходом
 * в работе, прежде чем ядро спросит, жива ли она. Класс — инструмент, которого сессия ждёт
 * (`exec`, `read`, … как в `tool.event.effectClass`), без ожидаемого инструмента — `model`.
 * Выученный p95 вызова класса × 3 с полом 2 мин (короткие вызовы не дают пробы на каждой паузе
 * модели), не выучен — 10 мин. Числа приходят снаружи: наблюдатель экономику не импортирует.
 */

export const STALL_DEFAULT_MS = 10 * 60_000;
export const STALL_FLOOR_MS = 2 * 60_000;
export const STALL_P95_FACTOR = 3;

/** Класс без ожидаемого инструмента: модель думает или пишет ответ. */
export const MODEL_CLASS = 'model';

export interface StallThreshold {
  ms: number;
  toolClass: string;
  basis: 'learned' | 'default';
}

/**
 * `learned` — выученные p95 по классу (только классы с достаточной выборкой); `defaultMs` —
 * значение спеки, тесты подставляют меньшее (`ObserverOptions.stallDefaultMs`).
 */
export function stallThreshold(
  toolClass: string,
  learned: Readonly<Record<string, number>> | null,
  defaultMs: number = STALL_DEFAULT_MS,
): StallThreshold {
  const p95 = learned?.[toolClass];
  if (typeof p95 === 'number' && Number.isFinite(p95) && p95 >= 0)
    return {
      ms: Math.max(p95 * STALL_P95_FACTOR, STALL_FLOOR_MS),
      toolClass,
      basis: 'learned',
    };
  return { ms: defaultMs, toolClass, basis: 'default' };
}

/**
 * Порог сессии, ждущей несколько инструментов сразу (параллельные вызовы): самый длинный — проба
 * не приходит раньше, чем мог кончиться самый медленный из ожидаемых. Ничего не ждёт — `model`.
 */
export function sessionStallThreshold(
  pendingClasses: readonly string[],
  learned: Readonly<Record<string, number>> | null,
  defaultMs: number = STALL_DEFAULT_MS,
): StallThreshold {
  const classes = pendingClasses.length > 0 ? pendingClasses : [MODEL_CLASS];
  return classes
    .map((cls) => stallThreshold(cls, learned, defaultMs))
    .reduce((a, b) => (b.ms > a.ms ? b : a));
}
