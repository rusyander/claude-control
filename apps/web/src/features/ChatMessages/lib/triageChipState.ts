import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

/**
 * Итог разбора одним словом — подпись фишки в хабе.
 *
 * Отдельной функцией, потому что состояний стало четыре и одно из них
 * противоположно соседнему по последствиям: «не получен» значит, что группы
 * ПОШЛИ как предложено, а «оборван перезапуском» — что не пошли вовсе и стоят
 * на вопросе человеку. Пока это решалось тернарником в разметке, второй случай
 * показывался подписью первого и врал ровно там, где человеку надо действовать.
 */
export type TriageChipState = 'running' | 'applied' | 'missing' | 'interrupted';

export function triageChipState(triage: SplitPlanView['triage']): TriageChipState {
  // Разбора нет — он ещё идёт: запись конвейера заводится ДО его прогона, а
  // поле `triage` появляется только когда прогон кончился, чем бы ни кончился.
  if (!triage) return 'running';
  if (triage.received) return 'applied';
  return triage.interrupted ? 'interrupted' : 'missing';
}
