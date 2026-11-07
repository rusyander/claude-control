/**
 * Решение «маскировать ли запрос на пути через контур» (Р11) — чистая часть, общая для панели и
 * хоста звеньев ядра. Драйвер и карточка контура остаются у панели: сюда приходят уже факты.
 * Одно решение на шлюз, карточку и звено ядра: два расчёта разошлись бы молча — карточка
 * обещала бы маску, а запрос уходил бы открытым.
 */

export type DataMaskReason = 'declared' | 'chosen' | 'global' | 'none';

export interface DataMaskInput {
  /** Общий выключатель раздела «Защита данных». */
  globalOn: boolean;
  /** Выбор человека на контуре; `undefined` — не выбирал, решает манифест. */
  choice: boolean | undefined;
  /** Контур объявил подмену данных (строка манифеста `anonymization`). */
  declared: boolean;
}

export interface DataMaskDecision {
  on: boolean;
  reason: DataMaskReason;
}

/**
 * Общий выключатель сильнее выбора на контуре: человек, включивший защиту данных для всего, не
 * должен узнать, что одна карточка её тихо сняла.
 */
export function dataMaskDecision(input: DataMaskInput): DataMaskDecision {
  const byContour = input.choice ?? input.declared;
  const on = input.globalOn || byContour;
  const reason: DataMaskReason = byContour
    ? input.choice === undefined
      ? 'declared'
      : 'chosen'
    : input.globalOn
      ? 'global'
      : input.choice === false
        ? 'chosen'
        : 'none';
  return { on, reason };
}
