import type { BgItem } from '@agentdeck/contracts/core/agents';
import type { FiredVerdict } from '../observer.types.ts';

export const BG_ORPHAN_SIGNAL = 'bg-orphan';

/** Жив ли процесс фоновой работы: `unknown` — личность процесса не закреплена (pid без начала). */
export type BgLiveness = 'alive' | 'gone' | 'unknown';

/**
 * Что сторож делает с открытой фоновой работой (этап 11, P148). Владелец жив — ничего.
 * Владелец кончился: процесса нет или CLI pid не назвал — работа закрыта как потерянная
 * (`bg.ended lost`), без сигнала (CLI сам убрал своё — это норма конца сессии); процесс жив —
 * снимается через общий снос ресурса (P90/P40) и называется сигналом `bg-orphan`; личность не
 * закреплена — снести нельзя (чужой процесс с тем же pid), сигнал называет, что осталось.
 */
export type OrphanPlan =
  | { do: 'none' }
  | { do: 'close-lost'; reason: string }
  | { do: 'reap'; reason: string }
  | { do: 'name-only'; reason: string };

export function orphanPlan(
  item: Pick<BgItem, 'pid'>,
  ownerEnd: string | null,
  live: BgLiveness,
): OrphanPlan {
  if (ownerEnd === null) return { do: 'none' };
  if (item.pid === undefined)
    return { do: 'close-lost', reason: `${ownerEnd}; the CLI named no pid, nothing to reap` };
  if (live === 'gone')
    return { do: 'close-lost', reason: `${ownerEnd}; process ${item.pid} is already gone` };
  if (live === 'unknown')
    return {
      do: 'name-only',
      reason: `${ownerEnd}; process ${item.pid} identity was never pinned, not reaped (could be a reused pid)`,
    };
  return { do: 'reap', reason: `${ownerEnd}; process ${item.pid} still running` };
}

/** Исход сноса: проверен — снят; нет — почему (утечка ресурса уже в журнале у сноса). */
export type ReapOutcome = { reaped: true; rid: string } | { reaped: false; why: string };

/**
 * Вердикт `bg-orphan`: фоновая работа пережила владельца. Один на работу (`key` по itemId);
 * в детали — снята ли она, и если нет — что осталось и почему.
 */
export function orphanVerdict(item: BgItem, reason: string, outcome: ReapOutcome): FiredVerdict {
  const what = `${item.kind} ${item.itemId}${item.pid === undefined ? '' : ` (pid ${item.pid})`}`;
  const result = outcome.reaped
    ? `reaped through resource ${outcome.rid}, verified gone`
    : `NOT reaped: ${outcome.why}`;
  return {
    fired: true,
    signal: BG_ORPHAN_SIGNAL,
    subject: item.itemId,
    detail: `background ${what} outlived its owner; ${result}`,
    reasons: [reason, result],
    key: `${BG_ORPHAN_SIGNAL}:${item.itemId}`,
    stepId: item.ownerChain.stepId,
    sessionId: item.ownerChain.sessionId,
  };
}
