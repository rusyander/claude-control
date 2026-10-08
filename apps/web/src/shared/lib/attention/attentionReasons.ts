import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { AttentionReason } from './attention.types';
import { runKeyPrefix } from './runKeyPrefix';
import { callsForAttention } from './attention';

/** Разговор на вопросе без живого прогона: id и время последней записи. */
export interface AwaitingMark {
  id: string;
  since: string;
}

/**
 * Поводы из прогонов вкладки и разговоров, стоящих на вопросе. Разговор, за
 * которым уже числится зовущий прогон, второй раз не считается.
 */
export function attentionReasons(
  runs: readonly ActiveRunView[],
  awaiting: readonly AwaitingMark[] = [],
): AttentionReason[] {
  const calling = runs.filter((run) => callsForAttention(run.status));
  const counted = new Set(calling.flatMap((run) => [run.id, run.sessionId ?? run.id]));
  return [
    ...calling.map((run) => ({
      key: `${runKeyPrefix(run.id)}${run.status}`,
      tone: run.status === 'error' ? ('danger' as const) : ('warning' as const),
    })),
    ...awaiting
      .filter((chat) => !counted.has(chat.id))
      .map((chat) => ({ key: `chat:${chat.id}:${chat.since}`, tone: 'warning' as const })),
  ];
}
