import type { AgentTranscript } from '@agentdeck/contracts';
import type { AgentDigest } from './agent-digest.types.ts';

/**
 * Окно шагов хода агента — общее для субагента и главного агента. Номера шагов
 * — от начала хода: в памяти лежат шаги `[dropped, dropped + steps.length)`,
 * более ранние ушли (их число — `dropped`), счёт `total` точен всегда.
 *
 * Два способа спросить: `offset` — последние `limit`, сдвинутые от конца (окно
 * идущего агента едет вместе с ним); `start` — `limit` шагов с этого номера
 * (листание назад стоит на месте, пока агент дописывает новые).
 */
export interface StepWindow {
  limit: number;
  offset?: number;
  start?: number;
}

type WindowPart = Pick<
  AgentTranscript,
  'steps' | 'total' | 'hasMore' | 'start' | 'toolCalls' | 'tokens' | 'anomalies'
> &
  Partial<Pick<AgentTranscript, 'startedAt' | 'lastAt'>>;

export function windowOf(digest: AgentDigest, dropped: number, window: StepWindow): WindowPart {
  const total = dropped + digest.steps.length;
  let first: number;
  let end: number;
  if (window.start !== undefined) {
    first = Math.min(Math.max(dropped, window.start), total);
    end = Math.min(total, first + window.limit);
  } else {
    end = Math.max(dropped, total - (window.offset ?? 0));
    first = Math.max(dropped, end - window.limit);
  }
  return {
    steps: digest.steps.slice(first - dropped, end - dropped),
    total,
    hasMore: first > dropped,
    start: first,
    toolCalls: digest.toolCalls,
    tokens: digest.tokens,
    anomalies: digest.anomalies,
    ...(digest.startedAt ? { startedAt: digest.startedAt } : {}),
    ...(digest.lastAt ? { lastAt: digest.lastAt } : {}),
  };
}
