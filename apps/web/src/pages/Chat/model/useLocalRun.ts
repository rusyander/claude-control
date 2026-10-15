import { usePlatformRunPlan } from '@entities/Platform';
import { isLocalRoute } from '@shared/lib/chat-model';

/**
 * Пойдёт ли ход этого чата на локальную модель (L6) — тем же планом прогона, что и шапка
 * (потребитель «Группы» у звена разделения), чтобы строка состояния и подпись модели не
 * расходились.
 */
export function useLocalRun(consumer: string, projectPath: string | undefined): boolean {
  const plan = usePlatformRunPlan(consumer, projectPath ?? '');
  return isLocalRoute(plan.data?.routed === true ? plan.data : undefined);
}
