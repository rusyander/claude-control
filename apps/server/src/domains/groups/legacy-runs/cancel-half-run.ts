import type { DeferredScope } from '@agentdeck/contracts/deferred-asks';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { legacyRunState } from './legacy-runs.ts';

/** Срез хранилища, который нужен миграции: чтение планов и запись одного. */
export interface CancelHalfRunStore {
  getSplitPlans(): Record<string, SplitPlanRecord>;
  setSplitPlan(record: SplitPlanRecord): void;
}

/** Отложенные вопросы D-n: отзыв ждущих и неиспользованных записей по области. */
export interface CancelHalfRunAsks {
  withdraw(match: (scope: DeferredScope) => boolean): readonly { id: string }[];
}

export interface CancelHalfRunResult {
  /** Планы, отменённые этим запуском. */
  plans: string[];
  /** Отозванные записи D-n групп. */
  asks: string[];
}

/**
 * Разовая миграция при старте панели (этап 10, F1): прежний рантайм групп ушёл, и недоведённый
 * запуск продолжать некому — ядро прежние группы не подхватывает (спека 10:8). Каждый такой
 * план получает `cancelledAt`: страница показывает его остановленным, а не «идущим» вечно. Ждущие
 * вопросы D-n групп отзываются: ответить на них уже некому, а значок «Ждёт решения» горел бы вечно.
 *
 * Повторный запуск ничего не меняет: отменённый план уже не «не доведён», отозванная запись уже
 * не ждёт, а доведённые и отменённые раньше планы не трогаются — отметка человека остаётся его.
 */
export function cancelHalfRunPlans(
  store: CancelHalfRunStore,
  now: string,
  asks?: CancelHalfRunAsks,
): CancelHalfRunResult {
  const plans: string[] = [];
  for (const plan of Object.values(store.getSplitPlans())) {
    if (legacyRunState(plan) !== 'half-run') continue;
    store.setSplitPlan({ ...plan, cancelledAt: now });
    plans.push(plan.parentChatId);
  }
  const withdrawn = asks?.withdraw((scope) => scope.kind === 'group') ?? [];
  return { plans, asks: withdrawn.map((record) => record.id) };
}
