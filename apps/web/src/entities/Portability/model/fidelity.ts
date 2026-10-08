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
