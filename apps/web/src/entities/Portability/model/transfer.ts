import { emitOutcomes, landsAtTarget, type EmitEntry } from '@agentdeck/contracts/portable-emit';
import type { EmitOutcome } from '@agentdeck/contracts/portable-emit';
import type { TransferPlan } from '@agentdeck/contracts/portable-transfer';
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

/**
 * Сколько записей у каждого исхода. Считается ИЗ строк, а не берётся полем
 * ответа: число, за которым на экране нет строк, — то же самое число без
 * основания (правило отчёта верности, оно же здесь).
 */
export function summarizeOutcomes(entries: readonly EmitEntry[]): Record<EmitOutcome, number> {
  const counts = Object.fromEntries(emitOutcomes.map((outcome) => [outcome, 0])) as Record<
    EmitOutcome,
    number
  >;
  for (const entry of entries) counts[entry.outcome] += 1;
  return counts;
}

/** Сводка плана: чем он обернётся на диске и сколько записей доедет. */
export interface PlanSummary {
  /** Файлов, которых перенос коснётся, — ровно строки плана. */
  readonly files: number;
  /** Из них будут созданы с нуля. */
  readonly created: number;
  /** Из них не изменятся: у цели уже лежит ровно это. */
  readonly unchanged: number;
  readonly added: number;
  readonly removed: number;
  /** Записей, которые окажутся у цели без панели (`written` + `already_available`). */
  readonly lands: number;
  /** Записей, которые держатся запуском через панель или проводом. */
  readonly runtimeOnly: number;
}

/**
 * Сводка плана одним проходом по тому, что человеку показано.
 *
 * `lands` считается через `landsAtTarget` канона, а не сравнением с `'written'`:
 * `already_available` записей на диск не создаёт — цель просто читает тот же
 * каталог, — и отдельная проверка здесь потеряла бы их молча, объявив
 * непереехавшим то, что у цели уже есть.
 */
export function summarizePlan(plan: TransferPlan): PlanSummary {
  let created = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;
  for (const file of plan.files) {
    if (!file.exists) created += 1;
    if (file.unchanged) unchanged += 1;
    added += file.added;
    removed += file.removed;
  }

  let lands = 0;
  let runtimeOnly = 0;
  for (const entry of plan.entries) {
    if (landsAtTarget(entry.outcome)) lands += 1;
    if (entry.outcome === 'runtime_only') runtimeOnly += 1;
  }

  return { files: plan.files.length, created, unchanged, added, removed, lands, runtimeOnly };
}
