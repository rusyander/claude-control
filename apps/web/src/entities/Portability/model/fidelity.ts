import { fidelityLevels, type FidelityLevel } from '@agentdeck/contracts/portable-fidelity';
import type { BadgeTone } from '@shared/ui/badge';

/**
 * Показ уровней верности. Словари здесь ЗАКРЫТЫ по типу: добавленный в канон
 * уровень не соберётся, пока ему не назначат тон и перевод, — иначе он тихо
 * приехал бы на экран серой меткой со своим английским кодом.
 */

/**
 * Цвет уровня несёт ровно одно: доедет ли запись без оговорок.
 *
 * `emulated` и `wired` — предупреждение, а не успех: за ними стоит условие
 * (панель в пути запуска, контур в пути запроса), и зелёная метка означала бы
 * обещание, которого без этого условия не будет. `text` — тоже предупреждение:
 * инструкция модели — это соблюдение вместо принуждения.
 */
export const LEVEL_TONE: Record<FidelityLevel, BadgeTone> = {
  native: 'success',
  emulated: 'info',
  wired: 'info',
  text: 'warning',
  impossible: 'danger',
};

/** Порядок показа — от лучшего к худшему, тот же, что в словаре канона. */
export const LEVEL_ORDER: readonly FidelityLevel[] = fidelityLevels;

export function levelLabelKey(level: FidelityLevel): string {
  return `portability.fidelity.level.${level}`;
}

/** Ключ перевода причины. Причина без перевода показывает свой код, а не пустоту. */
export function reasonLabelKey(reason: string): string {
  return `portability.fidelity.reason.${reason}`;
}

export function conditionLabelKey(condition: string): string {
  return `portability.fidelity.condition.${condition}`;
}

/**
 * Какая цель переноса ДЕЙСТВИТЕЛЬНО выбрана при этом источнике.
 *
 * Выбор цели человек делает один раз, а источник потом меняет — и выбранное
 * раньше остаётся в состоянии экрана. Само по себе это давало вечный скелет:
 * цель «codex» при источнике «codex» из списка исчезает, запрос отчёта
 * выключается, а страница продолжает считать, что цель выбрана, и рисует
 * загрузку, которая никогда не кончится.
 *
 * Поэтому цель не хранится «как есть», а ВЫВОДИТСЯ: совпала с источником
 * (перенос в самого себя не перенос) или её нет среди известных панели
 * провайдеров — цель не выбрана, и это одно значение для всего экрана: списка,
 * запроса и таблицы. Сброс состояния при смене источника дал бы тот же ответ
 * кадром позже — ровно тем кадром, в котором экран успевает соврать.
 */
export function usableTarget(chosen: string, providerId: string, known: readonly string[]): string {
  if (!chosen || chosen === providerId) return '';
  return known.includes(chosen) ? chosen : '';
}
