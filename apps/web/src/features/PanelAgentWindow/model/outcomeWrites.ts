import type { PanelActionOutcome } from '@agentdeck/contracts/panel-agent';

/** Исходы, при которых до исполнения дело не дошло: записи точно не было. */
const NEVER_EXECUTED: ReadonlySet<PanelActionOutcome> = new Set<PanelActionOutcome>([
  'rejected',
  'timeout',
  'cancelled',
  // Сервер отбивает их до исполнения: действия с таким именем нет, ввод не
  // прошёл схему (panel-agent-routes.ts).
  'unknown',
  'invalid',
]);

/**
 * Могла ли правка агента что-то записать. Отказ, таймаут, отмена, неизвестное
 * действие и негодный ввод — точно нет: до исполнения дело не дошло.
 * `needs-secret` — да: действие выполнено, и только следующий шаг ждёт ключа.
 * `failed` — может: действие в два шага (`afterRoute`) падает вторым шагом,
 * когда первый уже записал, и страница без перечитывания стояла бы на снимке до
 * записи.
 */
export function outcomeMayHaveWritten(outcome: PanelActionOutcome): boolean {
  return !NEVER_EXECUTED.has(outcome);
}
