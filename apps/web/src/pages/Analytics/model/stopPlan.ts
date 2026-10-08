import type { SessionWhere } from '@agentdeck/contracts';

/** «Остановить»: что именно будет снято — или почему снимать нечего. */
export type StopPlan =
  | { kind: 'panel'; chatId: string }
  | { kind: 'process'; pid: number; startedAt: string; ownsPanel: boolean }
  | { kind: 'nothing'; reason: 'unidentified' | 'finished' };

export function stopPlan(where: SessionWhere): StopPlan {
  if (where.kind === 'panel') return { kind: 'panel', chatId: where.chatId };
  if (where.kind === 'process') {
    return {
      kind: 'process',
      pid: where.pid,
      startedAt: where.startedAt,
      ownsPanel: where.ownsPanel,
    };
  }
  return { kind: 'nothing', reason: where.kind };
}
