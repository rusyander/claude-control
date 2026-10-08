import type { TransferPlan } from '@agentdeck/contracts/portable-transfer';
import { landsAtTarget } from '@agentdeck/contracts/portable-emit';

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
