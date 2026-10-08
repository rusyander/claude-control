import { emitOutcomes } from '@agentdeck/contracts/portable-emit';
import type { EmitOutcome } from '@agentdeck/contracts/portable-emit';
import type { BadgeTone } from '@shared/ui/badge';

/**
 * Показ переноса: исходы записей и сводка плана (П2.3).
 *
 * Словари закрыты по типу — тем же приёмом, что у уровней верности: исход,
 * добавленный в канон и забытый здесь, не соберётся, вместо того чтобы тихо
 * приехать на экран серой меткой со своим английским кодом.
 */

/**
 * Цвет исхода несёт ровно одно: доедет ли запись до цели САМА.
 *
 * `runtime_only` — не успех и не беда: запись держится запуском через панель,
 * и зелёным она обещала бы то, чего у запущенного человеком CLI не будет.
 * `collision_needs_choice` — предупреждение, а не отказ: у цели уже лежит своя
 * версия, и выбор между ними человеческий. Красное — только то, что не доедет
 * никак.
 */
export const OUTCOME_TONE: Record<EmitOutcome, BadgeTone> = {
  written: 'success',
  already_available: 'success',
  runtime_only: 'info',
  collision_needs_choice: 'warning',
  refused_by_target: 'warning',
  disabled_at_source: 'neutral',
  // Не «нейтрально»: запись у источника цела и человек ждал её у цели, а не
  // доехала она из-за поломки, которую чинить ему.
  script_missing: 'warning',
  not_transferable: 'danger',
};

/**
 * Порядок показа — тот же, что в словаре канона: сначала доехавшее, потом
 * условное, потом непереносимое. Свой порядок здесь разошёлся бы с сервером на
 * первом же добавленном исходе.
 */
export const OUTCOME_ORDER: readonly EmitOutcome[] = emitOutcomes;

export function outcomeLabelKey(outcome: EmitOutcome): string {
  return `portability.transfer.outcome.${outcome}`;
}
