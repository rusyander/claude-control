import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { HubBucket } from './hubSummary.types';

export function hubBucket(group: ChildStageGroup): HubBucket {
  if (group.isRunning) return 'running';
  // Звено спросило человека и стоит: после ответа работа сама не пойдёт.
  if (group.waitingFor === 'question') return 'ask';
  // Чат есть, прогона нет, вопроса нет: стоит — продолжить решает человек.
  return 'idle';
}
