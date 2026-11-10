import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import { crossStepsOf } from '../../economy/cross-steps.ts';
import type { ReviewStanding } from './gates.types.ts';

/**
 * Что ворота берут из строк журнала (01 §State): последнее заявление ревью, подтверждения ревью
 * по индексу ворот шага и последняя запись проверки ядра по каждому `checkId`. Вердикт и свежесть
 * записи — чтения хранилища и дерева, их делает вызывающий (`requirements/facts.ts`). Чистая.
 */
export interface GateLines {
  review: ReviewStanding | null;
  confirmations: Record<number, 'confirmed' | 'refuted'>;
  /** checkId → номер последней записи прогона ядра; захваченные (сеанс, псевдо) не в счёт (P92). */
  latestRecords: Record<string, string>;
}

function data<K extends keyof JournalDataV1>(line: JournalLine, kind: K): JournalDataV1[K] | null {
  return line.kind === kind ? (line.data as JournalDataV1[K]) : null;
}

export function gateFactsOf(lines: readonly JournalLine[], stepDefId: string): GateLines {
  const out: GateLines = { review: null, confirmations: {}, latestRecords: {} };
  const kindOf = new Map<string, string>();
  const runs = new Map<string, string>();
  const crossSteps = crossStepsOf(lines);
  for (const line of lines) {
    const started = data(line, 'step.started');
    if (started) kindOf.set(started.stepId, started.stepKind);
    const requested = data(line, 'check.requested');
    if (requested?.origin === 'core') runs.set(requested.checkRunId, requested.checkId);
    const recorded = data(line, 'check.recorded');
    const checkId = recorded ? runs.get(recorded.checkRunId) : undefined;
    if (recorded && checkId !== undefined) out.latestRecords[checkId] = recorded.recordId;
    const claimed = data(line, 'step.claimed');
    if (!claimed || kindOf.get(claimed.stepId) !== 'review') continue;
    // Второе ревью (P185) ничего не одобряет: его чистое заявление не снимает находку первого,
    // его подтверждение ворот не в счёт; его блокирующая находка и опровержение — в счёт.
    const cross = crossSteps.has(claimed.stepId);
    const blocking = (claimed.claim.findings ?? []).filter((f) => f.severity === 'blocking').length;
    if (!cross || blocking > 0) out.review = { stepId: claimed.stepId, blocking };
    for (const c of claimed.claim.confirmations ?? [])
      if (c.target.kind === 'gate' && c.target.stepDefId === stepDefId)
        if (!cross || c.verdict === 'refuted') out.confirmations[c.target.index] = c.verdict;
  }
  return out;
}
