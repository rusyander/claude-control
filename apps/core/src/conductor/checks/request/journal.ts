import type {
  CheckAnswer,
  CheckDecision,
  CheckEntry,
  CheckKey,
  CheckRequest,
  RecordGrade,
} from '@agentdeck/contracts/core/records';
import type { CheckRunEvent, CheckRunState } from '@agentdeck/contracts/core/states';
import type { CheckDeps } from '../checks.types.ts';
import { factKind, message } from './helpers.ts';
import type { Gathered, ServiceState } from './request.types.ts';

/** Строки журнала задачи от входа проверки (G24): решение, запрос, переходы машины прогона. */

export function journal(
  s: ServiceState,
  req: CheckRequest,
  entry: Parameters<CheckDeps['journal']>[1],
): void {
  const { deps, lost } = s;
  try {
    deps.journal(req.taskId, entry);
  } catch (error) {
    // Журнал задачи не принял строку (задача снята, схема отклонила, диск) — прогон не роняется:
    // запись в хранилище остаётся доказательством. Потеря названа (A1r4-F10): в канал потерь
    // обвязки и в заметку ответа — молча пропавшая строка схемы не видна никому.
    const reason = message(error);
    lost.set(req, [...(lost.get(req) ?? []), `${entry.kind}: ${reason}`]);
    try {
      deps.onJournalLoss?.(req.taskId, entry.kind, reason);
    } catch {
      // Канал потерь сам не пишет — потеря остаётся в заметке ответа.
    }
  }
}

/** Потери журнала запроса — в заметку ответа `ran` (один раз: снятые не повторяются). */
export function withLosses(s: ServiceState, req: CheckRequest, answer: CheckAnswer): CheckAnswer {
  const { lost } = s;
  const lines = lost.get(req);
  if (!lines?.length || answer.kind !== 'ran') return answer;
  lost.delete(req);
  const named = `journal lost ${lines.join('; ')}`;
  return { ...answer, note: answer.note ? `${answer.note}; ${named}` : named };
}

export function move(
  s: ServiceState,
  req: CheckRequest,
  checkRunId: string,
  event: CheckRunEvent,
  from: CheckRunState,
  to: CheckRunState,
): void {
  journal(s, req, {
    kind: 'check.transition',
    stepId: req.stepId,
    data: { checkRunId, event, from, to },
  });
}

export function journalDecision(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  decision: CheckDecision,
  extra: string[],
): void {
  const { deps } = s;
  const reason =
    'reason' in decision ? decision.reason : 'header' in decision ? decision.header : decision.kind;
  journal(s, req, {
    kind: 'decision',
    stepId: req.stepId,
    data: {
      decisionId: deps.newId(),
      class: 'check',
      inputs: [],
      facts: [
        { readClass: 'check.registry', kind: factKind(g.registry) },
        { readClass: 'git.tree', kind: factKind(g.key) },
        { readClass: 'check.records', kind: factKind(g.records) },
      ],
      numbers: {
        ...(g.input.inflight ? { inflightSince: g.input.inflight.since } : {}),
        ...('deadlineMs' in decision ? { waitDeadline: decision.deadlineMs } : {}),
      },
      reasons: [...extra, `${req.road}: ${reason}`],
      output: JSON.parse(JSON.stringify(decision)) as never,
    },
  });
}

export function requested(
  s: ServiceState,
  req: CheckRequest,
  entry: CheckEntry,
  unit: string,
  key: CheckKey | null,
  grade: RecordGrade,
  checkRunId: string,
  retryOf?: string,
): void {
  journal(s, req, {
    kind: 'check.requested',
    stepId: req.stepId,
    data: {
      checkRunId,
      checkId: entry.id,
      unit,
      key,
      grade,
      origin: req.origin,
      road: req.road,
      stepId: req.stepId,
      ...(retryOf ? { retryOf } : {}),
    },
  });
}
