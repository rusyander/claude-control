import type { ActiveRunView } from '@shared/lib/agent-runs';

/** Прогон зовёт человека, если ждёт ответа или упал; работающий — нет. */
export function callsForAttention(status: ActiveRunView['status']): boolean {
  return status === 'waiting' || status === 'error';
}
